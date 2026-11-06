const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const Database = require("better-sqlite3");

process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";
process.env.FIREBASE_API_KEY = "test-web-api-key";
process.env.FIREBASE_AUTH_DOMAIN = "test-project.firebaseapp.com";
process.env.FIREBASE_PROJECT_ID = "test-project";
process.env.FIREBASE_APP_ID = "1:123:web:test";

const identities = new Map();
const app = require("../server");
app.setIdentityVerifierForTests(async (token) => {
  const identity = identities.get(token);
  if (!identity) throw new Error("Invalid test token.");
  return identity;
});

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function request(url, body, token = "") {
  const response = await fetch(`${baseUrl}${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    response,
    data: response.status === 204 ? null : await response.json(),
  };
}

function registerIdentity(token, uid, email, emailVerified = true) {
  identities.set(token, { uid, email, email_verified: emailVerified });
}

async function createProfile(token, uid, email, firstName, username) {
  registerIdentity(token, uid, email);
  const result = await request(
    "/api/profile",
    { firstName, lastName: "Test", username },
    token,
  );
  assert.equal(result.response.status, 201, JSON.stringify(result.data));
  return result.data.user;
}

test("Firebase client configuration is exposed without server credentials", async () => {
  const result = await request("/api/config");
  assert.equal(result.response.status, 200);
  assert.equal(result.data.firebase.projectId, "test-project");
  assert.equal(result.data.firebase.apiKey, "test-web-api-key");
  assert.equal(JSON.stringify(result.data).includes("PRIVATE_KEY"), false);
});

test("Firebase placeholder settings are rejected", async () => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  process.env.FIREBASE_PROJECT_ID = "your-project-id";
  try {
    const result = await request("/api/config");
    assert.equal(result.response.status, 503);
    assert.match(result.data.error, /Firebase n’est pas configuré/);
  } finally {
    process.env.FIREBASE_PROJECT_ID = projectId;
  }
});

test("Firebase verified accounts can exchange messages after accepting invitations", async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal((html.match(/data-password-toggle/g) || []).length, 2);
  const bundle = await fetch(`${baseUrl}/app.bundle.js`);
  assert.equal(bundle.status, 200);

  const anonymous = await request("/api/me");
  assert.equal(anonymous.response.status, 401);

  registerIdentity("unverified-token", "unverified-user", "pending@example.test", false);
  const unverified = await request("/api/me", undefined, "unverified-token");
  assert.equal(unverified.response.status, 403);

  const alice = await createProfile(
    "alice-token",
    "alice-firebase-uid",
    "alice@example.test",
    "Alice",
    "alice_test",
  );
  const bob = await createProfile(
    "bob-token",
    "bob-firebase-uid",
    "bob@example.test",
    "Bob",
    "bob_test",
  );

  const existingProfile = await request("/api/me", undefined, "alice-token");
  assert.equal(existingProfile.data.user.username, "alice_test");
  const search = await request("/api/search?username=bob_test", undefined, "alice-token");
  assert.equal(search.data.user.username, "bob_test");

  const invitation = await request(
    "/api/invitations",
    { username: "bob_test" },
    "alice-token",
  );
  assert.equal(invitation.response.status, 201);
  const pending = await request("/api/invitations", undefined, "bob-token");
  assert.equal(pending.data.invitations.length, 1);
  const accepted = await request(
    `/api/invitations/${pending.data.invitations[0].id}/accept`,
    {},
    "bob-token",
  );
  assert.equal(accepted.response.status, 200);
  const aliceConversations = await request("/api/conversations", undefined, "alice-token");
  assert.equal(aliceConversations.data.conversations.length, 1);
  assert.equal(aliceConversations.data.conversations[0].unread, false);

  const events = await fetch(`${baseUrl}/api/events`, {
    headers: { Authorization: "Bearer bob-token" },
  });
  assert.equal(events.status, 200);
  const eventReader = events.body.getReader();
  try {
    const readyEvent = await eventReader.read();
    assert.match(new TextDecoder().decode(readyEvent.value), /"type":"ready"/);
    const firstMessage = await request(
      `/api/conversations/${bob.id}/messages`,
      { body: "Bonjour Bob !" },
      "alice-token",
    );
    assert.equal(firstMessage.response.status, 201);
    const liveEvent = await Promise.race([
      eventReader.read(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("live message event timed out")), 2000);
        timer.unref();
      }),
    ]);
    const liveEventText = new TextDecoder().decode(liveEvent.value);
    assert.match(liveEventText, /"type":"message"/);
    assert.match(liveEventText, new RegExp(`"peerId":"${alice.id}"`));

    const bobUnread = await request("/api/conversations", undefined, "bob-token");
    assert.equal(bobUnread.data.conversations[0].unread, true);
    const received = await request(
      `/api/conversations/${alice.id}/messages`,
      undefined,
      "bob-token",
    );
    assert.equal(received.data.messages[0].body, "Bonjour Bob !");
    const bobConversations = await request("/api/conversations", undefined, "bob-token");
    assert.equal(bobConversations.data.conversations[0].unread, false);

    const reply = await request(
      `/api/conversations/${alice.id}/messages`,
      { body: "Bonjour Alice !" },
      "bob-token",
    );
    assert.equal(reply.response.status, 201);
    const aliceUnread = await request("/api/conversations", undefined, "alice-token");
    assert.equal(aliceUnread.data.conversations[0].unread, true);
    const newMessages = await request(
      `/api/conversations/${bob.id}/messages?after=${firstMessage.data.message.id}`,
      undefined,
      "alice-token",
    );
    assert.equal(newMessages.data.messages[0].body, "Bonjour Alice !");
  } finally {
    await eventReader.cancel();
  }
});

test("legacy SQLite accounts retain profiles and conversations during Firebase migration", () => {
  const databasePath = path.join(os.tmpdir(), `two-migration-${process.pid}.sqlite`);
  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE pending_signups (
      email TEXT PRIMARY KEY,
      password_hash TEXT,
      code_hash TEXT NOT NULL,
      code_expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      enrollment_hash TEXT,
      enrollment_expires_at INTEGER
    );
    CREATE TABLE friendships (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'declined')),
      created_at TEXT NOT NULL,
      UNIQUE(requester_id, addressee_id)
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO users VALUES
      ('legacy-a', 'legacy-a@example.test', 'old-password-hash', 'Legacy', 'One', 'legacy_one', '2025-01-01'),
      ('legacy-b', 'legacy-b@example.test', 'old-password-hash', 'Legacy', 'Two', 'legacy_two', '2025-01-01');
    INSERT INTO sessions VALUES ('old-token', 'old-csrf', 'legacy-a', 9999999999999);
    INSERT INTO pending_signups (email, password_hash, code_hash, code_expires_at)
      VALUES ('pending@example.test', NULL, 'old-code-hash', 9999999999999);
    INSERT INTO friendships VALUES ('legacy-friendship', 'legacy-a', 'legacy-b', 'accepted', '2025-01-01');
    INSERT INTO messages (friendship_id, sender_id, body, created_at)
      VALUES ('legacy-friendship', 'legacy-a', 'Message conservé', '2025-01-01');
  `);
  legacyDb.close();

  try {
    const migration = spawnSync(process.execPath, ["-e", "require('./server')"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_PATH: databasePath,
      },
    });
    assert.equal(migration.status, 0, migration.stderr);

    const migratedDb = new Database(databasePath, { readonly: true });
    const columns = migratedDb.prepare("PRAGMA table_info(users)").all().map(({ name }) => name);
    const tables = migratedDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => name);
    assert.ok(columns.includes("firebase_uid"));
    assert.equal(columns.includes("password_hash"), false);
    assert.equal(tables.includes("sessions"), false);
    assert.equal(tables.includes("pending_signups"), false);
    assert.equal(migratedDb.prepare("SELECT COUNT(*) AS count FROM users").get().count, 2);
    assert.equal(
      migratedDb.prepare("SELECT body FROM messages").get().body,
      "Message conservé",
    );
    migratedDb.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${databasePath}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});
