import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const authScreen = document.querySelector("#auth-screen");
const appScreen = document.querySelector("#app-screen");
const authPanels = {
  login: document.querySelector("#auth-step"),
  signup: document.querySelector("#signup-step"),
  verify: document.querySelector("#verify-step"),
  profile: document.querySelector("#profile-step"),
};
const state = {
  user: null,
  auth: null,
  db: null,
  firebaseUser: null,
  friendships: new Map(),
  profiles: new Map(),
  conversations: [],
  activePeerId: null,
  friendshipsUnsub: null,
  messagesUnsub: null,
  seenInitialFriendships: false,
  syncVersion: 0,
  markingRead: false,
  toastTimer: null,
  searchTimer: null,
};

/* ---------- Utilitaires d'interface ---------- */

function showAuthPanel(name) {
  Object.entries(authPanels).forEach(([key, panel]) => {
    panel.classList.toggle("hidden", key !== name);
  });
}

function showFormError(id, message) {
  document.querySelector(id).textContent = message || "";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3300);
}

function setButtonBusy(button, busy) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-label="Chargement"></span>';
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }
}

function initials(firstName, lastName) {
  return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase() || "?";
}

function avatarTone(seed) {
  let total = 0;
  for (const character of seed || "") total += character.charCodeAt(0);
  return total % 5;
}

function avatarElement(user, extraClass = "") {
  const avatar = document.createElement("div");
  avatar.className = `avatar ${extraClass}`.trim();
  avatar.dataset.tone = String(avatarTone(user.username || user.id || ""));
  avatar.textContent = initials(user.firstName, user.lastName);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function formatTime(date) {
  if (!date) return "";
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const now = new Date();
  if (value.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(value);
  }
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(value);
}

function firebaseErrorMessage(error) {
  const messages = {
    "auth/email-already-in-use": "Un compte utilise déjà cette adresse e-mail. Essayez de vous connecter.",
    "auth/invalid-email": "Veuillez saisir une adresse e-mail valide.",
    "auth/invalid-credential": "Adresse e-mail ou mot de passe incorrect.",
    "auth/too-many-requests": "Trop de tentatives. Réessayez plus tard.",
    "auth/weak-password": "Choisissez un mot de passe d’au moins 10 caractères.",
    "auth/network-request-failed": "Connexion impossible à Firebase. Vérifiez votre connexion Internet.",
    "auth/operation-not-allowed": "Activez la connexion par e-mail et mot de passe dans Firebase Console.",
    "auth/unauthorized-continue-uri": "Ajoutez votre domaine GitHub Pages dans Firebase > Authentication > Paramètres > Domaines autorisés.",
    "permission-denied": "Action refusée. Vérifiez que les règles Firestore ont bien été publiées.",
    unavailable: "Firestore est injoignable pour le moment. Réessayez.",
  };
  if (messages[error?.code]) return messages[error.code];
  if (error?.message) return error.message;
  return "Une erreur est survenue. Veuillez réessayer.";
}

/* ---------- Données (Firestore) ---------- */

function pairIdFor(a, b) {
  return [a, b].sort().join("_");
}

function peerOf(friendship) {
  return friendship.members.find((member) => member !== state.user.id);
}

function toMillis(timestamp) {
  return timestamp?.toMillis ? timestamp.toMillis() : 0;
}

function isUnread(friendship) {
  const me = state.user.id;
  if (!friendship.lastMessageAt || !friendship.lastSenderId || friendship.lastSenderId === me) return false;
  return toMillis(friendship.lastMessageAt) > toMillis(friendship.readAt?.[me]);
}

async function getProfile(uid) {
  if (state.profiles.has(uid)) return state.profiles.get(uid);
  const snap = await getDoc(doc(state.db, "users", uid));
  const user = snap.exists()
    ? { id: snap.id, ...snap.data() }
    : { id: uid, firstName: "Membre", lastName: "inconnu", username: "inconnu" };
  state.profiles.set(uid, user);
  return user;
}

function cachedProfile(uid) {
  return state.profiles.get(uid) || { id: uid, firstName: "Membre", lastName: "", username: "membre" };
}

function buildConversations() {
  return [...state.friendships.values()]
    .filter((friendship) => friendship.status === "accepted")
    .map((friendship) => {
      const peerId = peerOf(friendship);
      return {
        id: friendship.id,
        user: cachedProfile(peerId),
        lastMessage: friendship.lastMessage || "",
        lastMessageAt: friendship.lastMessageAt?.toDate ? friendship.lastMessageAt.toDate() : null,
        sortTime: toMillis(friendship.lastMessageAt) || toMillis(friendship.createdAt),
        unread: isUnread(friendship),
      };
    })
    .sort((a, b) => b.sortTime - a.sortTime);
}

function buildInvitations() {
  const me = state.user.id;
  return [...state.friendships.values()]
    .filter((friendship) => friendship.status === "pending" && friendship.to === me)
    .map((friendship) => ({ id: friendship.id, user: cachedProfile(friendship.from) }));
}

function relationshipWith(peerId) {
  const friendship = state.friendships.get(pairIdFor(state.user.id, peerId));
  if (!friendship) return null;
  return {
    status: friendship.status,
    direction: friendship.from === state.user.id ? "sent" : "received",
  };
}

function subscribeToFriendships() {
  state.friendshipsUnsub?.();
  state.seenInitialFriendships = false;
  const me = state.user.id;
  const friendshipsQuery = query(
    collection(state.db, "friendships"),
    where("members", "array-contains", me),
  );
  state.friendshipsUnsub = onSnapshot(
    friendshipsQuery,
    async (snapshot) => {
      const version = ++state.syncVersion;
      const previous = state.friendships;

      if (state.seenInitialFriendships) {
        snapshot.docChanges().forEach((change) => {
          const data = change.doc.data();
          if (change.type === "added" && data.status === "pending" && data.to === me) {
            showToast("Vous avez reçu une nouvelle invitation.");
          }
          if (
            change.type === "modified" &&
            data.status === "accepted" &&
            data.from === me &&
            previous.get(change.doc.id)?.status === "pending"
          ) {
            showToast("Votre invitation a été acceptée.");
          }
        });
      }

      const next = new Map();
      snapshot.docs.forEach((item) => {
        next.set(item.id, { id: item.id, ...item.data({ serverTimestamps: "estimate" }) });
      });
      state.friendships = next;
      state.seenInitialFriendships = true;

      await Promise.all(
        [...next.values()].map((friendship) => getProfile(peerOf(friendship)).catch(() => null)),
      );
      if (version !== state.syncVersion || !state.user) return;
      renderInvitations(buildInvitations());
      renderConversations(buildConversations());
      maybeMarkRead();
    },
    (error) => showToast(firebaseErrorMessage(error)),
  );
}

function maybeMarkRead() {
  if (!state.activePeerId || state.markingRead || !state.user) return;
  const pid = pairIdFor(state.user.id, state.activePeerId);
  const friendship = state.friendships.get(pid);
  if (!friendship || friendship.status !== "accepted" || !isUnread(friendship)) return;
  state.markingRead = true;
  updateDoc(doc(state.db, "friendships", pid), {
    [`readAt.${state.user.id}`]: serverTimestamp(),
  })
    .catch(() => {})
    .finally(() => {
      state.markingRead = false;
    });
}

/* ---------- Authentification ---------- */

function setAuthenticated(user) {
  state.user = user;
  showWorkspace();
}

function showWorkspace() {
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  const fullName = `${state.user.firstName} ${state.user.lastName}`;
  document.querySelector("#profile-name").textContent = fullName;
  document.querySelector("#profile-handle").textContent = `@${state.user.username}`;
  document.querySelector("#profile-avatar").textContent = initials(state.user.firstName, state.user.lastName);
  initializeWorkspace().catch(showFatalError);
}

function leaveWorkspace() {
  state.friendshipsUnsub?.();
  state.messagesUnsub?.();
  state.friendshipsUnsub = null;
  state.messagesUnsub = null;
  state.syncVersion += 1;
  state.firebaseUser = null;
  state.user = null;
  state.friendships = new Map();
  state.profiles = new Map();
  state.conversations = [];
  state.activePeerId = null;
  state.seenInitialFriendships = false;
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  document.querySelector("#welcome-panel").classList.remove("hidden");
  document.querySelector("#conversation-panel").classList.add("hidden");
  showAuthPanel("signup");
}

async function handleLogin(event) {
  event.preventDefault();
  showFormError("#auth-error", "");
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    await signInWithEmailAndPassword(
      state.auth,
      String(form.get("email")).trim(),
      String(form.get("password")),
    );
  } catch (error) {
    showFormError("#auth-error", firebaseErrorMessage(error));
  } finally {
    setButtonBusy(button, false);
  }
}

function verificationSettings() {
  return { url: window.location.origin + window.location.pathname };
}

async function handleSignup(event) {
  event.preventDefault();
  showFormError("#signup-error", "");
  const form = new FormData(event.currentTarget);
  const email = String(form.get("email")).trim();
  const password = String(form.get("password"));
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    const result = await createUserWithEmailAndPassword(state.auth, email, password);
    state.firebaseUser = result.user;
    document.querySelector("#verify-step .card-intro").textContent =
      `Firebase a envoyé un lien de vérification à ${result.user.email}. Ouvrez-le, puis revenez ici.`;
    showAuthPanel("verify");
    try {
      await sendEmailVerification(result.user, verificationSettings());
    } catch (error) {
      showFormError("#verify-error", firebaseErrorMessage(error));
    }
  } catch (error) {
    showFormError("#signup-error", firebaseErrorMessage(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleVerification(event) {
  event.preventDefault();
  showFormError("#verify-error", "");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    if (!state.firebaseUser) throw new Error("Reconnectez-vous pour vérifier votre adresse.");
    await reload(state.firebaseUser);
    if (!state.firebaseUser.emailVerified) {
      showFormError("#verify-error", "Cliquez d’abord sur le lien reçu par e-mail, puis réessayez.");
      return;
    }
    await handleFirebaseUser(state.firebaseUser);
  } catch (error) {
    showFormError("#verify-error", firebaseErrorMessage(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function handleProfile(event) {
  event.preventDefault();
  showFormError("#profile-error", "");
  const form = new FormData(event.currentTarget);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setButtonBusy(button, true);
  try {
    const uid = state.firebaseUser?.uid;
    if (!uid) throw new Error("Reconnectez-vous pour créer votre profil.");
    const firstName = String(form.get("firstName")).trim();
    const lastName = String(form.get("lastName")).trim();
    const username = String(form.get("username")).trim().replace(/^@/, "");
    if (!firstName || !lastName) throw new Error("Indiquez votre prénom et votre nom.");
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
      throw new Error("L’identifiant doit contenir 3 à 24 lettres, chiffres ou tirets bas.");
    }
    const usernameLower = username.toLowerCase();
    const taken = await getDoc(doc(state.db, "usernames", usernameLower));
    if (taken.exists()) throw new Error("Cet identifiant est déjà pris. Essayez-en un autre.");

    const batch = writeBatch(state.db);
    batch.set(doc(state.db, "users", uid), {
      firstName,
      lastName,
      username,
      usernameLower,
      createdAt: serverTimestamp(),
    });
    batch.set(doc(state.db, "usernames", usernameLower), { uid });
    await batch.commit();

    state.profiles.delete(uid);
    setAuthenticated({ id: uid, firstName, lastName, username, usernameLower });
  } catch (error) {
    showFormError("#profile-error", firebaseErrorMessage(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function resendVerificationLink() {
  const button = document.querySelector("#resend-code");
  button.disabled = true;
  try {
    if (!state.firebaseUser) throw new Error("Reconnectez-vous pour demander un nouveau lien.");
    await sendEmailVerification(state.firebaseUser, verificationSettings());
    showFormError("#verify-error", `Un nouveau lien a été envoyé à ${state.firebaseUser.email}.`);
  } catch (error) {
    showFormError("#verify-error", firebaseErrorMessage(error));
  } finally {
    window.setTimeout(() => { button.disabled = false; }, 1800);
  }
}

async function handleFirebaseUser(firebaseUser) {
  if (!state.auth || state.auth.currentUser?.uid !== firebaseUser.uid) return;
  state.firebaseUser = firebaseUser;
  if (!firebaseUser.emailVerified) {
    authScreen.classList.remove("hidden");
    appScreen.classList.add("hidden");
    document.querySelector("#verify-step .card-intro").textContent =
      `Un lien de vérification a été envoyé à ${firebaseUser.email}. Ouvrez-le, puis revenez ici.`;
    showAuthPanel("verify");
    return;
  }
  if (state.user?.id === firebaseUser.uid) return;

  // Les règles Firestore lisent le jeton : on le rafraîchit pour qu'il indique "e-mail vérifié".
  await firebaseUser.getIdToken(true);
  const snap = await getDoc(doc(state.db, "users", firebaseUser.uid));
  if (state.auth.currentUser?.uid !== firebaseUser.uid) return;
  if (snap.exists()) {
    setAuthenticated({ id: snap.id, ...snap.data() });
    return;
  }
  authScreen.classList.remove("hidden");
  appScreen.classList.add("hidden");
  showAuthPanel("profile");
  document.querySelector("#profile-step .card-intro").textContent =
    `Adresse vérifiée : ${firebaseUser.email}. Choisissez le nom et l’identifiant que vos amis verront.`;
}

async function initializeFirebase() {
  if (!firebaseConfig?.apiKey || firebaseConfig.apiKey.startsWith("COLLEZ")) {
    throw new Error("Configuration Firebase manquante : renseignez le fichier firebase-config.js.");
  }
  const app = initializeApp(firebaseConfig);
  state.auth = getAuth(app);
  state.db = getFirestore(app);
  onAuthStateChanged(state.auth, (firebaseUser) => {
    state.firebaseUser = firebaseUser;
    if (!firebaseUser) {
      leaveWorkspace();
      return;
    }
    handleFirebaseUser(firebaseUser).catch((error) => {
      console.error("Impossible de charger le compte Firebase :", error);
      showToast(firebaseErrorMessage(error));
    });
  });
}

async function initializeWorkspace() {
  renderConversations([]);
  renderInvitations([]);
  subscribeToFriendships();
}

/* ---------- Affichage des listes ---------- */

function renderConversations(conversations) {
  state.conversations = conversations;
  const list = document.querySelector("#conversations-list");
  const empty = document.querySelector("#empty-conversations");
  list.replaceChildren();
  empty.classList.toggle("hidden", conversations.length > 0);

  conversations.forEach((conversation) => {
    const isActive = conversation.user.id === state.activePeerId;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-item${isActive ? " active" : ""}`;
    const hasUnreadMessage = conversation.unread && !isActive;
    button.setAttribute(
      "aria-label",
      `Ouvrir la conversation avec ${conversation.user.firstName}${hasUnreadMessage ? ", nouveau message" : ""}`,
    );
    button.append(avatarElement(conversation.user));
    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    const top = document.createElement("span");
    top.className = "conversation-preview-top";
    const name = document.createElement("strong");
    name.textContent = `${conversation.user.firstName} ${conversation.user.lastName}`;
    const time = document.createElement("time");
    time.textContent = formatTime(conversation.lastMessageAt);
    top.append(name, time);
    const lastMessage = document.createElement("span");
    lastMessage.textContent = conversation.lastMessage || "La conversation commence ici";
    preview.append(top, lastMessage);
    button.append(preview);
    if (hasUnreadMessage) {
      const unreadDot = document.createElement("span");
      unreadDot.className = "unread-dot";
      unreadDot.setAttribute("aria-hidden", "true");
      unreadDot.title = "Nouveau message";
      button.append(unreadDot);
    }
    button.addEventListener("click", () => openConversation(conversation.user.id));
    list.append(button);
  });
}

function renderInvitations(invitations) {
  const list = document.querySelector("#invitations-list");
  const count = document.querySelector("#invitation-count");
  list.replaceChildren();
  count.textContent = String(invitations.length);
  count.classList.toggle("hidden", invitations.length === 0);

  invitations.forEach((invitation) => {
    const card = document.createElement("div");
    card.className = "invitation-card";
    card.append(avatarElement(invitation.user, "avatar-small"));
    const person = document.createElement("div");
    person.className = "invitation-person";
    const name = document.createElement("strong");
    name.textContent = `${invitation.user.firstName} ${invitation.user.lastName}`;
    const handle = document.createElement("span");
    handle.textContent = `@${invitation.user.username}`;
    person.append(name, handle);
    const actions = document.createElement("div");
    actions.className = "invitation-actions";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.textContent = "Accepter";
    accept.addEventListener("click", () => respondToInvitation(invitation.id, "accept"));
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "decline-action";
    decline.textContent = "Refuser";
    decline.addEventListener("click", () => respondToInvitation(invitation.id, "decline"));
    actions.append(accept, decline);
    card.append(person, actions);
    list.append(card);
  });
}

async function respondToInvitation(id, action) {
  try {
    const reference = doc(state.db, "friendships", id);
    if (action === "accept") {
      await updateDoc(reference, { status: "accepted" });
      showToast("Invitation acceptée. Vous pouvez discuter.");
    } else {
      await deleteDoc(reference);
      showToast("Invitation refusée.");
    }
  } catch (error) {
    showToast(firebaseErrorMessage(error));
  }
}

/* ---------- Recherche d'amis ---------- */

function showSearchResult(parent, user, relationship, note) {
  parent.replaceChildren();
  if (!user) {
    const message = document.createElement("div");
    message.className = "search-note";
    message.textContent = note || "Aucun membre trouvé. Vérifiez son identifiant.";
    parent.append(message);
    parent.classList.remove("hidden");
    return;
  }

  const row = document.createElement("div");
  row.className = "search-result";
  row.append(avatarElement(user, "avatar-small"));
  const person = document.createElement("div");
  person.className = "search-result-info";
  const name = document.createElement("strong");
  name.textContent = `${user.firstName} ${user.lastName}`;
  const handle = document.createElement("span");
  handle.textContent = `@${user.username}`;
  person.append(name, handle);
  row.append(person);

  if (!relationship) {
    const invite = document.createElement("button");
    invite.type = "button";
    invite.className = "mini-action";
    invite.textContent = "Inviter";
    invite.addEventListener("click", () => sendInvitation(user));
    row.append(invite);
  } else {
    const status = document.createElement("span");
    status.className = "search-note";
    status.textContent =
      relationship.status === "accepted"
        ? "Déjà amis"
        : relationship.direction === "sent"
          ? "Invitation envoyée"
          : "Invitation reçue";
    row.append(status);
    if (relationship.status === "accepted") {
      row.addEventListener("click", () => {
        closeSearchResults();
        openConversation(user.id);
      });
      row.style.cursor = "pointer";
    }
  }
  parent.append(row);
  parent.classList.remove("hidden");
}

function closeSearchResults() {
  document.querySelector("#search-results").classList.add("hidden");
  document.querySelector("#friend-search").value = "";
}

async function findUserByUsername(username) {
  const lookup = await getDoc(doc(state.db, "usernames", username.toLowerCase()));
  if (!lookup.exists()) return null;
  return getProfile(lookup.data().uid);
}

async function searchFriend(value) {
  const results = document.querySelector("#search-results");
  const username = value.trim().replace(/^@/, "");
  if (username.length < 3 || !/^[a-zA-Z0-9_]+$/.test(username)) {
    results.classList.add("hidden");
    return;
  }
  try {
    const user = await findUserByUsername(username);
    if (document.querySelector("#friend-search").value.trim().replace(/^@/, "") !== username) return;
    if (!user) {
      showSearchResult(results, null, null);
      return;
    }
    if (user.id === state.user.id) {
      showSearchResult(results, null, null, "C’est votre propre identifiant.");
      return;
    }
    showSearchResult(results, user, relationshipWith(user.id));
  } catch (error) {
    showSearchResult(results, null, null, firebaseErrorMessage(error));
  }
}

async function sendInvitation(user) {
  const results = document.querySelector("#search-results");
  try {
    const me = state.user.id;
    if (relationshipWith(user.id)) return;
    await setDoc(doc(state.db, "friendships", pairIdFor(me, user.id)), {
      members: [me, user.id],
      from: me,
      to: user.id,
      status: "pending",
      createdAt: serverTimestamp(),
      readAt: {},
    });
    showToast("Invitation envoyée.");
    showSearchResult(results, user, { status: "pending", direction: "sent" });
  } catch (error) {
    showToast(firebaseErrorMessage(error));
  }
}

/* ---------- Conversation ---------- */

async function openConversation(peerId) {
  const conversation = state.conversations.find((item) => item.user.id === peerId);
  if (!conversation) return;
  state.messagesUnsub?.();
  state.activePeerId = peerId;
  document.querySelector("#welcome-panel").classList.add("hidden");
  const panel = document.querySelector("#conversation-panel");
  panel.classList.remove("hidden");
  document.querySelector("#conversation-name").textContent =
    `${conversation.user.firstName} ${conversation.user.lastName}`;
  document.querySelector("#conversation-handle").textContent = `@${conversation.user.username}`;
  const avatar = document.querySelector("#conversation-avatar");
  avatar.textContent = initials(conversation.user.firstName, conversation.user.lastName);
  avatar.dataset.tone = String(avatarTone(conversation.user.username));
  document.querySelector("#topbar-context").textContent =
    `EN CONVERSATION AVEC ${conversation.user.firstName.toUpperCase()}`;
  document.querySelector("#message-list").replaceChildren();
  showFormError("#message-error", "");
  renderConversations(buildConversations());
  document.querySelector("#message-input").focus();

  const pid = pairIdFor(state.user.id, peerId);
  const messagesQuery = query(
    collection(state.db, "friendships", pid, "messages"),
    orderBy("createdAt", "desc"),
    limit(200),
  );
  state.messagesUnsub = onSnapshot(
    messagesQuery,
    (snapshot) => {
      if (state.activePeerId !== peerId) return;
      const messages = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data({ serverTimestamps: "estimate" }) }))
        .reverse();
      renderMessages(messages);
      maybeMarkRead();
    },
    (error) => {
      if (state.activePeerId === peerId) showFormError("#message-error", firebaseErrorMessage(error));
    },
  );
  maybeMarkRead();
}

function renderMessages(messages) {
  const list = document.querySelector("#message-list");
  list.replaceChildren();
  messages.forEach((message) => {
    const row = document.createElement("div");
    row.className = `message-row${message.senderId === state.user.id ? " own" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.body;
    const date = message.createdAt?.toDate ? message.createdAt.toDate() : new Date();
    const time = document.createElement("time");
    time.className = "message-time";
    time.dateTime = date.toISOString();
    time.textContent = new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    row.append(bubble, time);
    list.append(row);
  });
  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = "Un premier bonjour, et la conversation est lancée.";
    list.append(empty);
  }
  list.scrollTop = list.scrollHeight;
}

async function sendMessage(event) {
  event.preventDefault();
  const input = document.querySelector("#message-input");
  const body = input.value.trim();
  if (!body || !state.activePeerId) return;
  const button = event.currentTarget.querySelector(".send-button");
  button.disabled = true;
  showFormError("#message-error", "");
  try {
    const pid = pairIdFor(state.user.id, state.activePeerId);
    const batch = writeBatch(state.db);
    batch.set(doc(collection(state.db, "friendships", pid, "messages")), {
      senderId: state.user.id,
      body,
      createdAt: serverTimestamp(),
    });
    batch.update(doc(state.db, "friendships", pid), {
      lastMessage: Array.from(body).slice(0, 200).join(""),
      lastMessageAt: serverTimestamp(),
      lastSenderId: state.user.id,
    });
    await batch.commit();
    input.value = "";
    resizeComposer(input);
  } catch (error) {
    showFormError("#message-error", firebaseErrorMessage(error));
  } finally {
    button.disabled = false;
  }
}

function resizeComposer(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 135)}px`;
}

function openFriendSearch() {
  const sidebar = document.querySelector("#sidebar");
  sidebar.classList.remove("collapsed");
  sidebar.classList.remove("sidebar-mobile-open");
  const input = document.querySelector("#friend-search");
  input.focus();
  if (window.matchMedia("(max-width: 680px)").matches) {
    sidebar.classList.add("sidebar-mobile-open");
  }
}

function showFatalError(error) {
  console.error(error);
  showToast(firebaseErrorMessage(error) || "Impossible de charger votre espace.");
}

/* ---------- Événements ---------- */

document.querySelector("#login-form").addEventListener("submit", handleLogin);
document.querySelector("#signup-form").addEventListener("submit", handleSignup);
document.querySelector("#verify-form").addEventListener("submit", handleVerification);
document.querySelector("#profile-form").addEventListener("submit", handleProfile);
document.querySelector("#resend-code").addEventListener("click", resendVerificationLink);
document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.getAttribute("aria-controls"));
    if (!input) throw new Error("Champ de mot de passe introuvable.");
    const isVisible = input.type === "password";
    input.type = isVisible ? "text" : "password";
    button.textContent = isVisible ? "Masquer" : "Afficher";
    button.setAttribute("aria-label", `${isVisible ? "Masquer" : "Afficher"} le mot de passe`);
    button.setAttribute("aria-pressed", String(isVisible));
  });
});
document.querySelector("#switch-signup").addEventListener("click", () => {
  showFormError("#auth-error", "");
  showAuthPanel("signup");
});
document.querySelector("#switch-login").addEventListener("click", () => {
  showFormError("#signup-error", "");
  showAuthPanel("login");
});
document.querySelectorAll("[data-auth-back]").forEach((button) => {
  button.addEventListener("click", () => {
    showFormError("#signup-error", "");
    showFormError("#verify-error", "");
    showFormError("#profile-error", "");
    showAuthPanel("login");
  });
});
document.querySelector("#verification-logout").addEventListener("click", async () => {
  if (state.auth) await signOut(state.auth);
});
document.querySelector("#profile-logout").addEventListener("click", async () => {
  if (state.auth) await signOut(state.auth);
});
document.querySelector("#message-form").addEventListener("submit", sendMessage);
document.querySelector("#message-input").addEventListener("input", (event) => resizeComposer(event.currentTarget));
document.querySelector("#message-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    document.querySelector("#message-form").requestSubmit();
  }
});
document.querySelector("#friend-search").addEventListener("input", (event) => {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => searchFriend(event.currentTarget.value), 250);
});
document.querySelector("#friend-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSearchResults();
  if (event.key === "Enter") {
    event.preventDefault();
    window.clearTimeout(state.searchTimer);
    searchFriend(event.currentTarget.value);
  }
});
document.querySelector("#new-message").addEventListener("click", openFriendSearch);
document.querySelector("#find-friends").addEventListener("click", openFriendSearch);
document.querySelector("#welcome-find-friend").addEventListener("click", openFriendSearch);
document.querySelector("#sidebar-toggle").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.add("collapsed");
  document.querySelector("#sidebar").classList.remove("sidebar-mobile-open");
});
document.querySelector("#sidebar-reopen").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.remove("collapsed");
});
document.querySelector("#mobile-sidebar-toggle").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.toggle("sidebar-mobile-open");
});
document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    if (state.auth) await signOut(state.auth);
  } catch (error) {
    showToast(firebaseErrorMessage(error));
  }
});
document.addEventListener("click", (event) => {
  const search = document.querySelector(".search-wrap");
  if (!search.contains(event.target)) document.querySelector("#search-results").classList.add("hidden");
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openFriendSearch();
  }
});

initializeFirebase().catch((error) => {
  console.error("Impossible de démarrer Firebase :", error);
  showFormError("#signup-error", error.message);
});
