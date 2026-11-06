import { initializeApp } from "@firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  reload,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
} from "@firebase/auth";

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
  firebaseUser: null,
  conversations: [],
  activePeerId: null,
  lastMessageId: 0,
  conversationView: 0,
  messageRefresh: null,
  unreadPeerIds: new Set(),
  eventController: null,
  toastTimer: null,
  searchTimer: null,
  seenInitialEvents: false,
};

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

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (state.firebaseUser) {
    headers.Authorization = `Bearer ${await state.firebaseUser.getIdToken()}`;
  }
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Une erreur est survenue. Réessayez.");
  }
  return data;
}

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
  state.eventController?.abort();
  state.eventController = null;
  state.firebaseUser = null;
  state.user = null;
  state.conversations = [];
  state.activePeerId = null;
  state.lastMessageId = 0;
  state.conversationView += 1;
  state.messageRefresh = null;
  state.unreadPeerIds.clear();
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  showAuthPanel("signup");
}

function initials(firstName, lastName) {
  return `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase() || "?";
}

function avatarTone(seed) {
  let total = 0;
  for (const character of seed) total += character.charCodeAt(0);
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

function formatTime(dateString) {
  if (!dateString) return "";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" }).format(date);
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
      await sendEmailVerification(result.user, { url: window.location.origin });
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
    await state.firebaseUser.getIdToken(true);
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
    const result = await api("/api/profile", {
      method: "POST",
      body: JSON.stringify({
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        username: form.get("username"),
      }),
    });
    setAuthenticated(result.user);
  } catch (error) {
    showFormError("#profile-error", error.message);
  } finally {
    setButtonBusy(button, false);
  }
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

async function resendVerificationLink() {
  const button = document.querySelector("#resend-code");
  button.disabled = true;
  try {
    if (!state.firebaseUser) throw new Error("Reconnectez-vous pour demander un nouveau lien.");
    await sendEmailVerification(state.firebaseUser, { url: window.location.origin });
    showFormError("#verify-error", `Un nouveau lien a été envoyé à ${state.firebaseUser.email}.`);
  } catch (error) {
    showFormError("#verify-error", firebaseErrorMessage(error));
  } finally {
    window.setTimeout(() => { button.disabled = false; }, 1800);
  }
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
  };
  if (messages[error?.code]) return messages[error.code];
  if (error?.message) return error.message;
  return "Une erreur est survenue. Veuillez réessayer.";
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

  const result = await api("/api/me");
  if (state.auth.currentUser?.uid !== firebaseUser.uid) return;
  if (result.user) {
    setAuthenticated(result.user);
    return;
  }
  authScreen.classList.remove("hidden");
  appScreen.classList.add("hidden");
  showAuthPanel("profile");
  document.querySelector("#profile-step .card-intro").textContent =
    `Adresse vérifiée : ${firebaseUser.email}. Choisissez le nom et l’identifiant que vos amis verront.`;
}

async function initializeFirebase() {
  const response = await fetch("/api/config");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "La configuration Firebase est manquante.");
  state.auth = getAuth(initializeApp(data.firebase));
  onAuthStateChanged(state.auth, (firebaseUser) => {
    state.firebaseUser = firebaseUser;
    if (!firebaseUser) {
      leaveWorkspace();
      return;
    }
    handleFirebaseUser(firebaseUser).catch((error) => {
      console.error("Impossible de charger le compte Firebase :", error);
      showToast(error.message || "Impossible de charger votre compte.");
    });
  });
}

async function initializeWorkspace() {
  const [conversationsResult, invitationsResult] = await Promise.all([
    api("/api/conversations"),
    api("/api/invitations"),
  ]);
  renderConversations(conversationsResult.conversations);
  renderInvitations(invitationsResult.invitations);
  connectToEvents();
}

function connectToEvents() {
  state.eventController?.abort();
  const controller = new AbortController();
  state.eventController = controller;
  consumeEvents(controller.signal).catch((error) => {
    if (!controller.signal.aborted) {
      console.error("Connexion en direct interrompue :", error);
      showToast("La connexion en direct a été interrompue. Actualisez la page.");
    }
  });
}

async function consumeEvents(signal) {
  while (!signal.aborted && state.firebaseUser) {
    try {
      const token = await state.firebaseUser.getIdToken();
      const response = await fetch("/api/events", {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error("Impossible de démarrer la connexion en direct.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const event of events) {
            const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
            if (dataLine) handleLiveEvent(JSON.parse(dataLine.slice(6)));
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error.name === "AbortError") return;
    }
    if (!signal.aborted) {
      await new Promise((resolve) => window.setTimeout(resolve, 1500));
    }
  }
}

function handleLiveEvent(data) {
  if (data.type === "message") {
    if (state.activePeerId !== data.peerId) state.unreadPeerIds.add(data.peerId);
    refreshConversations();
    if (state.activePeerId === data.peerId) refreshMessages();
  } else if (data.type === "ready") {
    refreshConversations();
    if (state.activePeerId) refreshMessages();
  } else if (data.type === "invitation") {
    refreshInvitations();
    showToast("Vous avez reçu une nouvelle invitation.");
  } else if (data.type === "contacts") {
    refreshInvitations();
    refreshConversations();
  }
}

async function refreshConversations() {
  if (!state.user) return;
  try {
    const result = await api("/api/conversations");
    renderConversations(result.conversations);
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshInvitations() {
  if (!state.user) return;
  try {
    const result = await api("/api/invitations");
    renderInvitations(result.invitations);
  } catch (error) {
    showToast(error.message);
  }
}

function renderConversations(conversations) {
  state.conversations = conversations;
  const list = document.querySelector("#conversations-list");
  const empty = document.querySelector("#empty-conversations");
  list.replaceChildren();
  empty.classList.toggle("hidden", conversations.length > 0);

  conversations.forEach((conversation) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-item${conversation.user.id === state.activePeerId ? " active" : ""}`;
    if (conversation.user.id === state.activePeerId) {
      state.unreadPeerIds.delete(conversation.user.id);
    } else if (conversation.unread) {
      state.unreadPeerIds.add(conversation.user.id);
    }
    const hasUnreadMessage = state.unreadPeerIds.has(conversation.user.id);
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
    const result = await api(`/api/invitations/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    showToast(result.message);
    await Promise.all([refreshInvitations(), refreshConversations()]);
  } catch (error) {
    showToast(error.message);
  }
}

function showSearchResult(parent, user, relationship) {
  parent.replaceChildren();
  if (!user) {
    const note = document.createElement("div");
    note.className = "search-note";
    note.textContent = "Aucun membre trouvé. Vérifiez son identifiant.";
    parent.append(note);
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
    invite.addEventListener("click", () => sendInvitation(user.username));
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

async function searchFriend(value) {
  const results = document.querySelector("#search-results");
  const username = value.trim().replace(/^@/, "");
  if (username.length < 3) {
    results.classList.add("hidden");
    return;
  }
  try {
    const result = await api(`/api/search?username=${encodeURIComponent(username)}`);
    if (document.querySelector("#friend-search").value.trim().replace(/^@/, "") !== username) return;
    if (!result.user) {
      showSearchResult(results, null, null);
      return;
    }
    showSearchResult(results, result.user, result.relationship);
  } catch (error) {
    results.replaceChildren();
    const note = document.createElement("div");
    note.className = "search-note";
    note.textContent = error.message;
    results.append(note);
    results.classList.remove("hidden");
  }
}

async function sendInvitation(username) {
  try {
    const result = await api("/api/invitations", {
      method: "POST",
      body: JSON.stringify({ username }),
    });
    showToast(result.message);
    await searchFriend(username);
  } catch (error) {
    showToast(error.message);
  }
}

async function openConversation(peerId) {
  const conversation = state.conversations.find((item) => item.user.id === peerId);
  if (!conversation) return;
  state.activePeerId = peerId;
  state.conversationView += 1;
  state.messageRefresh = null;
  state.unreadPeerIds.delete(peerId);
  state.lastMessageId = 0;
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
  renderConversations(state.conversations);
  document.querySelector("#message-input").focus();
  await refreshMessages();
}

async function refreshMessages() {
  if (!state.activePeerId) return;
  const requestedPeer = state.activePeerId;
  const requestedView = state.conversationView;
  if (
    state.messageRefresh?.peerId === requestedPeer &&
    state.messageRefresh.view === requestedView
  ) {
    state.messageRefresh.refreshAgain = true;
    return state.messageRefresh.promise;
  }

  const refresh = { peerId: requestedPeer, view: requestedView, refreshAgain: false };
  state.messageRefresh = refresh;
  refresh.promise = (async () => {
    try {
      do {
        refresh.refreshAgain = false;
        const after = state.lastMessageId > 0 ? `?after=${state.lastMessageId}` : "";
        const result = await api(
          `/api/conversations/${encodeURIComponent(requestedPeer)}/messages${after}`,
        );
        if (
          requestedPeer !== state.activePeerId ||
          requestedView !== state.conversationView
        ) return;
        renderMessages(result.messages, state.lastMessageId > 0);
        state.unreadPeerIds.delete(requestedPeer);
        refreshConversations();
        if (result.messages.length === 200) refresh.refreshAgain = true;
      } while (refresh.refreshAgain && requestedPeer === state.activePeerId &&
        requestedView === state.conversationView);
    } catch (error) {
      if (
        state.activePeerId === requestedPeer &&
        state.conversationView === requestedView
      ) showFormError("#message-error", error.message);
    } finally {
      if (state.messageRefresh === refresh) state.messageRefresh = null;
    }
  })();
  return refresh.promise;
}

function renderMessages(messages, append) {
  const list = document.querySelector("#message-list");
  if (!append) list.replaceChildren();
  messages.forEach((message) => {
    state.lastMessageId = Math.max(state.lastMessageId, message.id);
    const row = document.createElement("div");
    row.className = `message-row${message.senderId === state.user.id ? " own" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.body;
    const time = document.createElement("time");
    time.className = "message-time";
    time.dateTime = message.createdAt;
    time.textContent = new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(message.createdAt));
    row.append(bubble, time);
    list.append(row);
  });
  if (messages.length > 0) list.querySelector(".conversation-empty")?.remove();
  if (!append && messages.length === 0) {
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
    const result = await api(
      `/api/conversations/${encodeURIComponent(state.activePeerId)}/messages`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    input.value = "";
    resizeComposer(input);
    renderMessages([result.message], true);
    refreshConversations();
  } catch (error) {
    showFormError("#message-error", error.message);
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
  showToast(error.message || "Impossible de charger votre espace.");
}

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
