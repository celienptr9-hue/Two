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
  getDocs,
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

// Notifications hors-ligne : facultatives, le site fonctionne sans.
const pushConfig = await import("./push-config.js").then((m) => m.pushConfig).catch(() => null);
const serviceWorkerReady =
  "serviceWorker" in navigator ? navigator.serviceWorker.register("./sw.js").catch(() => null) : Promise.resolve(null);

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
  searchSeq: 0,
  seenMessages: null,
  pendingImage: null,
  pushActive: false,
  pendingOpen: new URLSearchParams(location.search).get("open"),
  lastMessageIds: [],
};
const baseTitle = document.title;
const NOTIF_KEY = "two-notifications";

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

/* ---------- Barre latérale (tiroir sur mobile) et hauteur d'écran ---------- */

const mobileQuery = window.matchMedia("(max-width: 760px)");
const isMobile = () => mobileQuery.matches;

function sidebarIsOpen() {
  const sidebar = document.querySelector("#sidebar");
  return isMobile() ? appScreen.classList.contains("drawer-open") : !sidebar.classList.contains("collapsed");
}

function setSidebarOpen(open) {
  const sidebar = document.querySelector("#sidebar");
  if (isMobile()) {
    appScreen.classList.toggle("drawer-open", open);
  } else {
    sidebar.classList.toggle("collapsed", !open);
  }
  sidebar.inert = !open;
  document.querySelectorAll('[aria-controls="sidebar"]').forEach((button) => {
    button.setAttribute("aria-expanded", String(open));
  });
}

// Sur téléphone, le clavier réduit la zone visible : on suit sa hauteur réelle.
function syncViewportHeight() {
  const viewport = window.visualViewport;
  if (viewport && viewport.scale > 1.01) return;
  const height = viewport ? viewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
}

function initials(firstName, lastName) {
  return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase() || "?";
}

function avatarTone(seed) {
  let total = 0;
  for (const character of seed || "") total += character.charCodeAt(0);
  return total % 6;
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
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (value.toDateString() === yesterday.toDateString()) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(value);
}

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

function formatDayLabel(date) {
  const now = new Date();
  if (sameDay(date, now)) return "Aujourd’hui";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return "Hier";
  const options = { weekday: "long", day: "numeric", month: "long" };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat("fr-FR", options).format(date);
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
        lastSenderId: friendship.lastSenderId || null,
        lastMessageMs: toMillis(friendship.lastMessageAt),
        peerReadMs: toMillis(friendship.readAt?.[peerId]),
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

      const events = [];
      if (state.seenInitialFriendships) {
        snapshot.docChanges().forEach((change) => {
          if (change.doc.metadata.hasPendingWrites) return;
          const data = change.doc.data();
          const before = previous.get(change.doc.id);
          if (change.type === "added" && data.status === "pending" && data.to === me) {
            events.push({ kind: "invite", peerId: data.from });
          }
          if (change.type === "modified" && data.status === "accepted" && data.from === me && before?.status === "pending") {
            events.push({ kind: "accepted", peerId: data.to });
          }
          if (
            change.type === "modified" &&
            data.status === "accepted" &&
            data.lastSenderId &&
            data.lastSenderId !== me &&
            toMillis(data.lastMessageAt) > toMillis(before?.lastMessageAt)
          ) {
            events.push({ kind: "message", peerId: data.lastSenderId, text: data.lastMessage || "" });
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
      events.forEach(announce);
      updateBadge();
      if (state.pendingOpen) {
        const target = state.pendingOpen;
        state.pendingOpen = null;
        if (state.conversations.some((c) => c.user.id === target)) openConversation(target);
      }
    },
    (error) => showToast(firebaseErrorMessage(error)),
  );
}

function maybeMarkRead() {
  if (!state.activePeerId || state.markingRead || !state.user || document.hidden) return;
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
  state.seenMessages = null;
  clearPendingImage();
  document.title = baseTitle;
  state.seenInitialFriendships = false;
  appScreen.classList.remove("drawer-open", "in-conversation");
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
  setSidebarOpen(true);
  renderConversations([]);
  renderInvitations([]);
  subscribeToFriendships();
  syncPushSubscription();
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
    const hasUnreadMessage = conversation.unread && !isActive;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-item${isActive ? " active" : ""}${hasUnreadMessage ? " unread" : ""}`;
    if (isActive) button.setAttribute("aria-current", "true");
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
    const last = document.createElement("span");
    last.className = "conversation-last";
    last.textContent = conversation.lastMessage
      ? `${conversation.lastSenderId === state.user.id ? "Vous : " : ""}${conversation.lastMessage}`
      : "Dites bonjour";
    preview.append(top, last);
    const status = conversationStatus(conversation, hasUnreadMessage);
    if (status) preview.append(status);
    button.append(preview);

    if (hasUnreadMessage) {
      const unreadDot = document.createElement("span");
      unreadDot.className = "unread-dot";
      unreadDot.setAttribute("aria-hidden", "true");
      button.append(unreadDot);
    }
    button.addEventListener("click", () =>
      conversation.user.id === state.activePeerId ? closeConversation() : openConversation(conversation.user.id),
    );
    list.append(button);
  });
}

function renderInvitations(invitations) {
  const list = document.querySelector("#invitations-list");
  const count = document.querySelector("#invitation-count");
  list.replaceChildren();
  count.textContent = String(invitations.length);
  count.classList.toggle("hidden", invitations.length === 0);
  document.querySelector("#invitations-section").classList.toggle("hidden", invitations.length === 0);

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
      const inviter = state.friendships.get(id)?.from;
      await updateDoc(reference, { status: "accepted" });
      if (inviter) notifyPeer("accepted", inviter);
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

function closeSearchResults() {
  state.searchSeq += 1;
  document.querySelector("#search-results").classList.add("hidden");
  document.querySelector("#friend-search").value = "";
}

function renderSearchMessage(text) {
  const results = document.querySelector("#search-results");
  const message = document.createElement("div");
  message.className = "search-note";
  message.textContent = text;
  results.replaceChildren(message);
  results.classList.remove("hidden");
}

function renderSearchResults(users) {
  const results = document.querySelector("#search-results");
  results.replaceChildren();
  users.forEach((user) => {
    const relationship = relationshipWith(user.id);
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
      invite.addEventListener("click", () => sendInvitation(user, invite));
      row.append(invite);
    } else if (relationship.status === "accepted") {
      const write = document.createElement("button");
      write.type = "button";
      write.className = "mini-action";
      write.textContent = "Écrire";
      write.addEventListener("click", () => {
        closeSearchResults();
        openConversation(user.id);
      });
      row.append(write);
    } else if (relationship.direction === "received") {
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "mini-action";
      accept.textContent = "Accepter";
      accept.addEventListener("click", async () => {
        await respondToInvitation(pairIdFor(state.user.id, user.id), "accept");
        closeSearchResults();
      });
      row.append(accept);
    } else {
      const status = document.createElement("span");
      status.className = "search-status";
      status.textContent = "Invitation envoyée";
      row.append(status);
    }
    results.append(row);
  });
  results.classList.remove("hidden");
}

// Recherche par début d'identifiant : "al" trouve @alice et @alain.
async function searchFriend(value) {
  const seq = ++state.searchSeq;
  const results = document.querySelector("#search-results");
  const term = value.trim().replace(/^@/, "");
  if (term.length < 2) {
    results.classList.add("hidden");
    return;
  }
  if (!/^[a-zA-Z0-9_]+$/.test(term)) {
    renderSearchMessage("Cherchez par identifiant, sans espace ni accent (par exemple @marie).");
    return;
  }
  try {
    const lower = term.toLowerCase();
    const snapshot = await getDocs(
      query(
        collection(state.db, "users"),
        where("usernameLower", ">=", lower),
        where("usernameLower", "<=", `${lower}\uf8ff`),
        limit(8),
      ),
    );
    if (seq !== state.searchSeq) return;
    const users = snapshot.docs
      .filter((item) => item.id !== state.user.id)
      .map((item) => {
        const user = { id: item.id, ...item.data() };
        state.profiles.set(user.id, user);
        return user;
      });
    if (users.length === 0) {
      renderSearchMessage(`Aucun membre trouvé pour « ${term} ». Vérifiez l’identifiant.`);
      return;
    }
    renderSearchResults(users);
  } catch (error) {
    if (seq === state.searchSeq) renderSearchMessage(firebaseErrorMessage(error));
  }
}

async function sendInvitation(user, button) {
  button.disabled = true;
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
    notifyPeer("invite", user.id);
    const status = document.createElement("span");
    status.className = "search-status";
    status.textContent = "Invitation envoyée";
    button.replaceWith(status);
  } catch (error) {
    button.disabled = false;
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
  state.seenMessages = null;
  clearPendingImage();
  document.querySelector("#message-list").replaceChildren();
  showFormError("#message-error", "");
  renderConversations(buildConversations());
  appScreen.classList.add("in-conversation");
  if (isMobile()) setSidebarOpen(false);
  else document.querySelector("#message-input").focus();

  const pid = pairIdFor(state.user.id, peerId);
  const messagesQuery = query(
    collection(state.db, "friendships", pid, "messages"),
    orderBy("createdAt", "desc"),
    limit(100),
  );
  state.messagesUnsub = onSnapshot(
    messagesQuery,
    (snapshot) => {
      if (state.activePeerId !== peerId) return;
      const messages = snapshot.docs
        .map((item) => ({ id: item.id, ...item.data({ serverTimestamps: "estimate" }) }))
        .reverse();
      state.lastMessageIds = messages.map((message) => message.id);
      renderMessages(messages);
      maybeMarkRead();
    },
    (error) => {
      if (state.activePeerId === peerId) showFormError("#message-error", firebaseErrorMessage(error));
    },
  );
  maybeMarkRead();
}

// Les messages d'une même personne, envoyés à moins de 5 minutes d'écart, forment un groupe.
function renderMessages(messages) {
  const GROUP_GAP = 5 * 60 * 1000;
  const list = document.querySelector("#message-list");
  let stick = false;
  const firstRender = state.seenMessages === null;
  const seen = state.seenMessages || new Set();
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 140;
  const dates = messages.map((message) => (message.createdAt?.toDate ? message.createdAt.toDate() : new Date()));
  list.replaceChildren();

  messages.forEach((message, index) => {
    const date = dates[index];
    const startsDay = index === 0 || !sameDay(dates[index - 1], date);
    if (startsDay) {
      const day = document.createElement("div");
      day.className = "message-day";
      day.textContent = formatDayLabel(date);
      list.append(day);
    }
    const next = messages[index + 1];
    const startsGroup =
      startsDay || messages[index - 1].senderId !== message.senderId || date - dates[index - 1] > GROUP_GAP;
    const endsGroup =
      !next || next.senderId !== message.senderId || dates[index + 1] - date > GROUP_GAP || !sameDay(date, dates[index + 1]);
    const own = message.senderId === state.user.id;

    const row = document.createElement("div");
    row.className = `message-row${own ? " own" : ""}${startsGroup ? " group-start" : ""}${endsGroup ? " group-end" : ""}`;
    if (!firstRender && !seen.has(message.id)) row.classList.add("is-new");
    seen.add(message.id);
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    if (typeof message.image === "string" && message.image.startsWith("data:image/")) {
      bubble.classList.add("has-image");
      const img = document.createElement("img");
      img.className = "message-image";
      img.alt = "Photo";
      img.src = message.image;
      img.addEventListener("click", (event) => {
        event.stopPropagation();
        openLightbox(message.image);
      });
      img.addEventListener("load", () => {
        if (stick) list.scrollTop = list.scrollHeight;
      });
      bubble.append(img);
      if (message.body) {
        const caption = document.createElement("div");
        caption.className = "message-caption";
        caption.textContent = message.body;
        bubble.append(caption);
      }
    } else {
      bubble.textContent = message.body;
    }
    const line = document.createElement("div");
    line.className = "message-line";
    if (own) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "message-delete";
      del.title = "Supprimer le message";
      del.setAttribute("aria-label", "Supprimer le message");
      del.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg><span class="label">Supprimer ?</span>';
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        requestDelete(message, index === messages.length - 1, del);
      });
      line.append(del);
      bubble.addEventListener("click", () => row.classList.toggle("show-actions"));
    }
    line.append(bubble);
    row.append(line);
    if (endsGroup) {
      const time = document.createElement("time");
      time.className = "message-time";
      time.dateTime = date.toISOString();
      time.textContent = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
      row.append(time);
    }
    list.append(row);
  });

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = "Aucun message pour l’instant. Écrivez le premier.";
    list.append(empty);
  }
  state.seenMessages = seen;
  const last = messages[messages.length - 1];
  stick = firstRender || nearBottom || last?.senderId === state.user.id;
  if (stick) list.scrollTop = list.scrollHeight;
}

async function sendMessage(event) {
  event.preventDefault();
  const input = document.querySelector("#message-input");
  const body = input.value.trim();
  const image = state.pendingImage;
  if ((!body && !image) || !state.activePeerId) return;
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
      ...(image ? { image } : {}),
    });
    batch.update(doc(state.db, "friendships", pid), {
      lastMessage: Array.from(image ? `📷 ${body || "Photo"}` : body).slice(0, 200).join(""),
      lastMessageAt: serverTimestamp(),
      lastSenderId: state.user.id,
    });
    await batch.commit();
    notifyPeer("message", state.activePeerId, image ? `📷 ${body || "Photo"}` : body);
    input.value = "";
    clearPendingImage();
    resizeComposer(input);
  } catch (error) {
    showFormError("#message-error", firebaseErrorMessage(error));
  } finally {
    button.disabled = false;
  }
}

function conversationStatus(conversation, hasUnreadMessage) {
  const me = state.user.id;
  let text = "";
  let cls = "";
  if (hasUnreadMessage) {
    text = "Nouveau message";
    cls = "is-new";
  } else if (conversation.lastSenderId === me && conversation.lastMessageMs) {
    const opened = conversation.peerReadMs >= conversation.lastMessageMs;
    text = opened ? "Ouvert" : "Remis";
    cls = opened ? "is-opened" : "is-delivered";
  }
  if (!text) return null;
  const el = document.createElement("span");
  el.className = `conversation-status ${cls}`;
  el.textContent = text;
  return el;
}

function closeConversation() {
  state.messagesUnsub?.();
  state.messagesUnsub = null;
  state.activePeerId = null;
  state.seenMessages = null;
  state.lastMessageIds = [];
  clearPendingImage();
  document.querySelector("#conversation-panel").classList.add("hidden");
  document.querySelector("#welcome-panel").classList.remove("hidden");
  appScreen.classList.remove("in-conversation");
  renderConversations(buildConversations());
  updateBadge();
}

/* ---------- Suppression de messages ---------- */

function requestDelete(message, isLast, button) {
  if (!button.classList.contains("confirming")) {
    button.classList.add("confirming");
    button.setAttribute("aria-label", "Confirmer la suppression");
    setTimeout(() => {
      button.classList.remove("confirming");
      button.setAttribute("aria-label", "Supprimer le message");
    }, 3000);
    return;
  }
  deleteMessage(message, isLast);
}

async function deleteMessage(message, isLast) {
  const pid = pairIdFor(state.user.id, state.activePeerId);
  try {
    await deleteDoc(doc(state.db, "friendships", pid, "messages", message.id));
    const friendship = state.friendships.get(pid);
    if (isLast && friendship?.lastSenderId === state.user.id) {
      await updateDoc(doc(state.db, "friendships", pid), { lastMessage: "Message supprimé" }).catch(() => {});
    }
  } catch (error) {
    showToast(firebaseErrorMessage(error));
  }
}

/* ---------- Photos ---------- */

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image"));
    };
    img.src = url;
  });
}

async function compressImage(file) {
  const img = await loadImage(file);
  for (const maxSide of [1280, 1024, 800, 600]) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.length <= 380000) return data;
    }
  }
  throw new Error("trop lourde");
}

function clearPendingImage() {
  state.pendingImage = null;
  document.querySelector("#image-preview")?.classList.add("hidden");
  const input = document.querySelector("#image-input");
  if (input) input.value = "";
}

async function handleImagePicked(event) {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showFormError("#message-error", "Ce fichier n’est pas une image.");
    return;
  }
  showFormError("#message-error", "");
  try {
    state.pendingImage = await compressImage(file);
    document.querySelector("#image-preview-img").src = state.pendingImage;
    document.querySelector("#image-preview").classList.remove("hidden");
  } catch {
    clearPendingImage();
    showFormError("#message-error", "Impossible de préparer cette photo. Essayez-en une autre.");
  }
}

function openLightbox(src) {
  document.querySelector("#lightbox-img").src = src;
  document.querySelector("#lightbox").classList.remove("hidden");
}

function closeLightbox() {
  document.querySelector("#lightbox").classList.add("hidden");
}

/* ---------- Notifications ---------- */

function notificationsEnabled() {
  try {
    return "Notification" in window && Notification.permission === "granted" && localStorage.getItem(NOTIF_KEY) === "1";
  } catch {
    return false;
  }
}

function syncNotifButton() {
  const button = document.querySelector("#notif-button");
  if (!button) return;
  const on = notificationsEnabled();
  button.setAttribute("aria-pressed", String(on));
  button.setAttribute("aria-label", on ? "Désactiver les notifications" : "Activer les notifications");
  button.title = on ? "Notifications activées" : "Activer les notifications";
}

async function toggleNotifications() {
  if (!("Notification" in window)) {
    showToast("Ce navigateur ne gère pas les notifications.");
    return;
  }
  if (notificationsEnabled()) {
    try { localStorage.setItem(NOTIF_KEY, "0"); } catch {}
    await unregisterPush().catch(() => {});
    syncNotifButton();
    showToast("Notifications désactivées.");
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showToast("Autorisez les notifications pour ce site dans les réglages du navigateur.");
    return;
  }
  try { localStorage.setItem(NOTIF_KEY, "1"); } catch {}
  syncNotifButton();
  const pushed = await syncPushSubscription();
  showToast(pushed ? "Notifications activées, même site fermé." : "Notifications activées.");
}

function announce(event) {
  const person = cachedProfile(event.peerId);
  const name = `${person.firstName} ${person.lastName}`.trim();
  const watching = !document.hidden && document.hasFocus();
  let title = "";
  let body = "";
  if (event.kind === "invite") {
    title = "Nouvelle demande d’ami";
    body = `${name} (@${person.username}) souhaite vous ajouter.`;
  } else if (event.kind === "accepted") {
    title = "Invitation acceptée";
    body = `${name} a accepté votre invitation.`;
  } else {
    if (watching && state.activePeerId === event.peerId) return;
    title = name;
    body = event.text || "Nouveau message";
  }
  if (watching) {
    showToast(event.kind === "message" ? `${name} : ${body}` : `${title} — ${body}`);
  } else if (notificationsEnabled() && !state.pushActive) {
    showSystemNotification(title, body, event);
  }
}

async function showSystemNotification(title, body, event) {
  const options = { body, icon: "./icon-192.png", tag: `two-${event.kind}-${event.peerId}`, data: { peerId: event.peerId } };
  try {
    const registration = await serviceWorkerReady;
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      if (event.kind === "message") openConversation(event.peerId);
      n.close();
    };
  } catch {}
}

/* ---------- Notifications hors-ligne (Web Push) ---------- */

function pushIsConfigured() {
  return Boolean(pushConfig?.workerUrl && pushConfig?.vapidPublicKey && "PushManager" in window);
}

function keyToBytes(base64url) {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function callWorker(path, payload) {
  const token = await state.auth?.currentUser?.getIdToken();
  if (!token) throw new Error("non connecté");
  const response = await fetch(`${pushConfig.workerUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`worker ${response.status}`);
}

async function syncPushSubscription() {
  state.pushActive = false;
  if (!pushIsConfigured() || !notificationsEnabled()) return false;
  try {
    const registration = await serviceWorkerReady;
    if (!registration) return false;
    const options = { userVisibleOnly: true, applicationServerKey: keyToBytes(pushConfig.vapidPublicKey) };
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe(options);
    }
    await callWorker("/subscribe", { subscription: subscription.toJSON() });
    state.pushActive = true;
    return true;
  } catch {
    return false;
  }
}

async function unregisterPush() {
  state.pushActive = false;
  if (!pushIsConfigured()) return;
  const registration = await serviceWorkerReady;
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await callWorker("/unsubscribe", { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

function notifyPeer(kind, peerId, text = "") {
  if (!pushConfig?.workerUrl || !peerId) return;
  callWorker("/notify", { kind, peerId, text: Array.from(text).slice(0, 140).join("") }).catch(() => {});
}

navigator.serviceWorker?.addEventListener("message", (event) => {
  if (event.data?.type !== "open-conversation" || !event.data.peerId) return;
  if (state.conversations.some((c) => c.user.id === event.data.peerId)) openConversation(event.data.peerId);
});

function updateBadge() {
  if (!state.user) return;
  const watching = !document.hidden;
  const unread = state.conversations.filter((c) => c.unread && !(watching && c.user.id === state.activePeerId)).length;
  const invites = buildInvitations().length;
  const total = unread + invites;
  document.title = total ? `(${total}) ${baseTitle}` : baseTitle;
}

function resizeComposer(input) {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 135)}px`;
}

function openFriendSearch() {
  setSidebarOpen(true);
  const input = document.querySelector("#friend-search");
  input.focus({ preventScroll: true });
  if (document.activeElement !== input) {
    window.setTimeout(() => input.focus({ preventScroll: true }), 80);
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
  // event.currentTarget vaut null une fois l'événement terminé : on lit la valeur tout de suite.
  const value = event.currentTarget.value;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => searchFriend(value), 250);
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
document.querySelector("#sidebar-toggle").addEventListener("click", () => setSidebarOpen(false));
document.querySelectorAll("[data-sidebar-open]").forEach((button) => {
  button.addEventListener("click", () => setSidebarOpen(true));
});
document.querySelector("#sidebar-backdrop").addEventListener("click", () => setSidebarOpen(false));
mobileQuery.addEventListener("change", () => setSidebarOpen(sidebarIsOpen()));
syncViewportHeight();
window.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("resize", syncViewportHeight);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isMobile() && state.activePeerId && sidebarIsOpen()) setSidebarOpen(false);
});
document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    await unregisterPush().catch(() => {});
    if (state.auth) await signOut(state.auth);
  } catch (error) {
    showToast(firebaseErrorMessage(error));
  }
});
document.addEventListener("click", (event) => {
  const search = document.querySelector(".search-wrap");
  // composedPath() garde le trajet d'origine, même si le bouton cliqué a été remplacé entre-temps.
  if (!event.composedPath().includes(search)) document.querySelector("#search-results").classList.add("hidden");
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

document.querySelector("#attach-button").addEventListener("click", () => document.querySelector("#image-input").click());
document.querySelector("#image-input").addEventListener("change", handleImagePicked);
document.querySelector("#image-remove").addEventListener("click", clearPendingImage);
document.querySelector("#lightbox").addEventListener("click", closeLightbox);
document.querySelector("#notif-button").addEventListener("click", toggleNotifications);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLightbox();
});
document.addEventListener("visibilitychange", () => {
  maybeMarkRead();
  updateBadge();
});
window.addEventListener("focus", () => {
  maybeMarkRead();
  updateBadge();
});
syncNotifButton();
