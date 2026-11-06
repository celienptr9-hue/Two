require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const express = require("express");
const helmet = require("helmet");
const { applicationDefault, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const app = express();
const port = Number(process.env.PORT) || 3000;
const databasePath =
  process.env.DATABASE_PATH === ":memory:"
    ? ":memory:"
    : path.resolve(process.env.DATABASE_PATH || "./data/messaging.sqlite");
const onlineClients = new Map();

if (databasePath !== ":memory:") {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    firebase_uid TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'declined')),
    created_at TEXT NOT NULL,
    UNIQUE(requester_id, addressee_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversation_reads (
    friendship_id TEXT NOT NULL REFERENCES friendships(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (friendship_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS friendships_addressee_status
    ON friendships(addressee_id, status);
  CREATE INDEX IF NOT EXISTS messages_friendship_id_id
    ON messages(friendship_id, id);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);
if (!userColumns.includes("firebase_uid")) {
  db.exec("ALTER TABLE users ADD COLUMN firebase_uid TEXT");
}
if (userColumns.includes("password_hash")) {
  db.exec("ALTER TABLE users DROP COLUMN password_hash");
}
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS users_firebase_uid
    ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
  DROP TABLE IF EXISTS sessions;
  DROP TABLE IF EXISTS pending_signups;
`);

const statements = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userByFirebaseUid: db.prepare("SELECT * FROM users WHERE firebase_uid = ?"),
  userByUsername: db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  userById: db.prepare(
    "SELECT id, email, first_name, last_name, username FROM users WHERE id = ?",
  ),
  friendshipBetween: db.prepare(`
    SELECT * FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?)
       OR (requester_id = ? AND addressee_id = ?)
    LIMIT 1
  `),
  friendshipByIdForUser: db.prepare(`
    SELECT * FROM friendships
    WHERE id = ? AND (requester_id = ? OR addressee_id = ?)
  `),
  acceptedFriendshipBetween: db.prepare(`
    SELECT * FROM friendships
    WHERE status = 'accepted'
      AND ((requester_id = ? AND addressee_id = ?)
        OR (requester_id = ? AND addressee_id = ?))
    LIMIT 1
  `),
};

const jsonLimit = express.json({ limit: "16kb" });
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: [
          "'self'",
          "https://identitytoolkit.googleapis.com",
          "https://securetoken.googleapis.com",
          "https://firebaseinstallations.googleapis.com",
        ],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  }),
);
app.use(jsonLimit);

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

let testIdentityVerifier = null;
let firebaseAuth = null;

function getFirebaseAuth() {
  if (!firebaseAuth) {
    if (!getApps().length) {
      if (!process.env.FIREBASE_PROJECT_ID) {
        throw new Error("FIREBASE_PROJECT_ID n’est pas configuré dans .env.");
      }
      initializeApp({
        credential: applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID,
      });
    }
    firebaseAuth = getAuth();
  }
  return firebaseAuth;
}

async function requireAuth(req, res, next) {
  const authorization = req.get("Authorization") || "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return sendError(res, 401, "Veuillez vous connecter pour continuer.");

  let identity;
  try {
    identity = testIdentityVerifier
      ? await testIdentityVerifier(match[1])
      : await getFirebaseAuth().verifyIdToken(match[1]);
  } catch {
    return sendError(res, 401, "Votre session Firebase a expiré. Veuillez vous reconnecter.");
  }
  if (!identity.email_verified || !identity.email || !identity.uid) {
    return sendError(res, 403, "Vérifiez votre adresse e-mail avant de continuer.");
  }

  const email = normalizeEmail(identity.email);
  let user = statements.userByFirebaseUid.get(identity.uid);
  if (!user) {
    const existingAccount = statements.userByEmail.get(email);
    if (existingAccount && !existingAccount.firebase_uid) {
      db.prepare("UPDATE users SET firebase_uid = ? WHERE id = ?").run(
        identity.uid,
        existingAccount.id,
      );
      user = statements.userByFirebaseUid.get(identity.uid);
    }
  }
  req.userId = user ? user.id : identity.uid;
  req.email = email;
  req.profile = user || null;
  return next();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    username: user.username,
  };
}

function pushEvent(userId, event) {
  const clients = onlineClients.get(userId);
  if (!clients) return;
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(data);
}

function pushToFriendship(friendship, event) {
  pushEvent(friendship.requester_id, event);
  pushEvent(friendship.addressee_id, event);
}

app.get("/api/config", (req, res) => {
  const { FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID, FIREBASE_APP_ID } =
    process.env;
  const firebaseSettings = [
    FIREBASE_API_KEY,
    FIREBASE_AUTH_DOMAIN,
    FIREBASE_PROJECT_ID,
    FIREBASE_APP_ID,
  ];
  if (
    firebaseSettings.some(
      (value) => !value || value.startsWith("your-") || value.includes("your-project-id"),
    )
  ) {
    return sendError(
      res,
      503,
      "Firebase n’est pas configuré. Complétez les paramètres FIREBASE_* dans .env.",
    );
  }
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const localAdminCredentialsAvailable =
    credentialPath && fs.existsSync(path.resolve(credentialPath));
  const cloudCredentialsAvailable =
    process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_CONFIG;
  if (
    process.env.NODE_ENV !== "test" &&
    !localAdminCredentialsAvailable &&
    !cloudCredentialsAvailable
  ) {
    return sendError(
      res,
      503,
      "Firebase Admin n’est pas configuré. Ajoutez le fichier de compte de service et définissez GOOGLE_APPLICATION_CREDENTIALS dans .env.",
    );
  }
  return res.json({
    firebase: {
      apiKey: FIREBASE_API_KEY,
      authDomain: FIREBASE_AUTH_DOMAIN,
      projectId: FIREBASE_PROJECT_ID,
      appId: FIREBASE_APP_ID,
    },
  });
});

app.get("/api/me", requireAuth, (req, res) => {
  const user = statements.userById.get(req.userId);
  return res.json({ user: user ? publicUser(user) : null, email: req.email });
});

app.post("/api/profile", requireAuth, (req, res, next) => {
  if (req.profile) return sendError(res, 409, "Votre profil existe déjà.");

  const firstName = cleanText(req.body.firstName, 50);
  const lastName = cleanText(req.body.lastName, 50);
  const username = cleanText(req.body.username, 24).toLowerCase();
  if (!firstName || !lastName) {
    return sendError(res, 400, "Veuillez renseigner votre prénom et votre nom.");
  }
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return sendError(res, 400, "L’identifiant doit contenir 3 à 24 lettres, chiffres ou tirets bas.");
  }

  try {
    const userId = req.userId;
    db.prepare(`
      INSERT INTO users (id, email, first_name, last_name, username, firebase_uid, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      req.email,
      firstName,
      lastName,
      username,
      userId,
      new Date().toISOString(),
    );
    const user = statements.userById.get(userId);
    return res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return sendError(res, 409, "Cet identifiant ou cette adresse e-mail est déjà utilisé.");
    }
    return next(error);
  }
});

app.get("/api/search", requireAuth, (req, res) => {
  const username = cleanText(req.query.username, 24).replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.json({ user: null, relationship: null });
  }
  const user = statements.userByUsername.get(username);
  if (!user || user.id === req.userId) {
    return res.json({ user: null, relationship: null });
  }
  const relationship = statements.friendshipBetween.get(
    req.userId,
    user.id,
    user.id,
    req.userId,
  );
  return res.json({
    user: {
      id: user.id,
      firstName: user.first_name,
      lastName: user.last_name,
      username: user.username,
    },
    relationship: relationship
      ? {
          id: relationship.id,
          status: relationship.status,
          direction: relationship.requester_id === req.userId ? "sent" : "received",
        }
      : null,
  });
});

app.post("/api/invitations", requireAuth, (req, res) => {
  const username = cleanText(req.body.username, 24).replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return sendError(res, 400, "Saisissez un identifiant valide.");
  }
  const user = statements.userByUsername.get(username);
  if (!user || user.id === req.userId) {
    return sendError(res, 404, "Aucun membre trouvé avec cet identifiant.");
  }
  const existing = statements.friendshipBetween.get(req.userId, user.id, user.id, req.userId);
  if (existing) {
    return sendError(
      res,
      409,
      existing.status === "accepted"
        ? "Vous êtes déjà en contact."
        : "Une invitation existe déjà pour ce membre.",
    );
  }
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO friendships (id, requester_id, addressee_id, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, req.userId, user.id, new Date().toISOString());
  pushEvent(user.id, { type: "invitation" });
  return res.status(201).json({ message: "Invitation envoyée." });
});

app.get("/api/invitations", requireAuth, (req, res) => {
  const invitations = db.prepare(`
    SELECT f.id, f.created_at, u.id AS user_id, u.first_name, u.last_name, u.username
    FROM friendships f
    JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.userId);
  return res.json({
    invitations: invitations.map((item) => ({
      id: item.id,
      createdAt: item.created_at,
      user: {
        id: item.user_id,
        firstName: item.first_name,
        lastName: item.last_name,
        username: item.username,
      },
    })),
  });
});

app.post("/api/invitations/:id/:action", requireAuth, (req, res) => {
  const invitation = db.prepare(`
    SELECT * FROM friendships
    WHERE id = ? AND addressee_id = ? AND status = 'pending'
  `).get(req.params.id, req.userId);
  if (!invitation) return sendError(res, 404, "Cette invitation n’est plus disponible.");

  if (req.params.action === "accept") {
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(invitation.id);
    pushToFriendship(invitation, { type: "contacts" });
    return res.json({ message: "Invitation acceptée." });
  }
  if (req.params.action === "decline") {
    db.prepare("DELETE FROM friendships WHERE id = ?").run(invitation.id);
    pushEvent(invitation.requester_id, { type: "contacts" });
    return res.json({ message: "Invitation refusée." });
  }
  return sendError(res, 404, "Action inconnue.");
});

app.get("/api/conversations", requireAuth, (req, res) => {
  const conversations = db.prepare(`
    SELECT
      f.id AS friendship_id,
      u.id AS user_id,
      u.first_name,
      u.last_name,
      u.username,
      (SELECT m.body FROM messages m
       WHERE m.friendship_id = f.id
       ORDER BY m.id DESC LIMIT 1) AS last_message,
      (SELECT m.created_at FROM messages m
       WHERE m.friendship_id = f.id
       ORDER BY m.id DESC LIMIT 1) AS last_message_at,
      (SELECT m.id FROM messages m
       WHERE m.friendship_id = f.id
       ORDER BY m.id DESC LIMIT 1) AS last_message_id,
      (SELECT m.sender_id FROM messages m
       WHERE m.friendship_id = f.id
       ORDER BY m.id DESC LIMIT 1) AS last_message_sender_id,
      COALESCE(reads.last_read_message_id, 0) AS last_read_message_id
    FROM friendships f
    JOIN users u ON u.id = CASE
      WHEN f.requester_id = ? THEN f.addressee_id
      ELSE f.requester_id
    END
    LEFT JOIN conversation_reads reads
      ON reads.friendship_id = f.id AND reads.user_id = ?
    WHERE f.status = 'accepted'
      AND (f.requester_id = ? OR f.addressee_id = ?)
    ORDER BY COALESCE(last_message_at, f.created_at) DESC
  `).all(req.userId, req.userId, req.userId, req.userId);
  return res.json({
    conversations: conversations.map((item) => ({
      id: item.friendship_id,
      user: {
        id: item.user_id,
        firstName: item.first_name,
        lastName: item.last_name,
        username: item.username,
      },
      lastMessage: item.last_message,
      lastMessageAt: item.last_message_at,
      unread:
        item.last_message_id !== null &&
        item.last_message_sender_id !== req.userId &&
        item.last_message_id > item.last_read_message_id,
    })),
  });
});

app.get("/api/conversations/:peerId/messages", requireAuth, (req, res) => {
  const friendship = statements.acceptedFriendshipBetween.get(
    req.userId,
    req.params.peerId,
    req.params.peerId,
    req.userId,
  );
  if (!friendship) return sendError(res, 404, "Cette conversation n’existe pas.");

  const after = Number.parseInt(req.query.after, 10);
  let messages;
  if (Number.isSafeInteger(after) && after > 0) {
    messages = db.prepare(`
      SELECT id, sender_id, body, created_at FROM messages
      WHERE friendship_id = ? AND id > ?
      ORDER BY id ASC LIMIT 200
    `).all(friendship.id, after);
  } else {
    messages = db.prepare(`
      SELECT id, sender_id, body, created_at FROM (
        SELECT id, sender_id, body, created_at FROM messages
        WHERE friendship_id = ? ORDER BY id DESC LIMIT 100
      ) ORDER BY id ASC
    `).all(friendship.id);
  }
  const lastReadMessageId = messages.at(-1)?.id;
  if (lastReadMessageId) {
    db.prepare(`
      INSERT INTO conversation_reads (friendship_id, user_id, last_read_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(friendship_id, user_id) DO UPDATE SET
        last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
        updated_at = excluded.updated_at
    `).run(friendship.id, req.userId, lastReadMessageId, new Date().toISOString());
  }
  return res.json({
    messages: messages.map((message) => ({
      id: message.id,
      senderId: message.sender_id,
      body: message.body,
      createdAt: message.created_at,
    })),
  });
});

app.post("/api/conversations/:peerId/messages", requireAuth, (req, res) => {
  const body = cleanText(req.body.body, 4000);
  if (!body) return sendError(res, 400, "Écrivez un message avant de l’envoyer.");
  if (typeof req.body.body !== "string" || req.body.body.length > 4000) {
    return sendError(res, 400, "Un message ne peut pas dépasser 4 000 caractères.");
  }
  const friendship = statements.acceptedFriendshipBetween.get(
    req.userId,
    req.params.peerId,
    req.params.peerId,
    req.userId,
  );
  if (!friendship) return sendError(res, 404, "Cette conversation n’existe pas.");

  const createdAt = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO messages (friendship_id, sender_id, body, created_at)
    VALUES (?, ?, ?, ?)
  `).run(friendship.id, req.userId, body, createdAt);
  const message = {
    id: Number(result.lastInsertRowid),
    senderId: req.userId,
    body,
    createdAt,
  };
  const recipientId =
    friendship.requester_id === req.userId ? friendship.addressee_id : friendship.requester_id;
  pushEvent(recipientId, { type: "message", peerId: req.userId });
  return res.status(201).json({ message });
});

app.get("/api/events", requireAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  const clients = onlineClients.get(req.userId) || new Set();
  clients.add(res);
  onlineClients.set(req.userId, clients);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(res);
    if (!clients.size) onlineClients.delete(req.userId);
  });
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) return sendError(res, 404, "Cette page n’existe pas.");
  return next();
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("Erreur serveur :", error);
  return sendError(res, 500, "Une erreur est survenue. Veuillez réessayer.");
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Two est disponible sur http://localhost:${port}`);
  });
}

if (process.env.NODE_ENV === "test") {
  app.setIdentityVerifierForTests = (verifier) => {
    if (typeof verifier !== "function") {
      throw new TypeError("Le vérificateur de jeton de test doit être une fonction.");
    }
    testIdentityVerifier = verifier;
  };
}

module.exports = app;
