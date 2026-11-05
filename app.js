'use strict';

const CARD_DATABASE = window.ArcaneCards.CARD_DATABASE;
const DEFAULT_DECK = [...window.ArcaneCards.DEFAULT_DECK];
const CARDS_PER_PAGE = 18;
const DECK_BUILDER_BATCH = 60;

let currentUser = null;
let isAuthRegisterMode = false;
let playerDeck = [...DEFAULT_DECK];
let currentPage = 1;
let deckBuilderVisibleCount = DECK_BUILDER_BATCH;
let onlineSocket = null;
const pendingSocketMessages = [];
let reconnectTimer = null;
let reconnectAttempts = 0;
let shouldReconnectSocket = true;
let onlineSnapshot = null;
let localMatch = null;
let localEndHandledMatchId = null;
let isOnlineMode = false;
let selectedAttackerId = null;
let currentRoomCode = '';
let pendingChallengeTarget = null;
let messageTimer = null;
let rankedQueueActive = false;

const $ = (id) => document.getElementById(id);

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = String(value ?? '');
}

function makeElement(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = String(text);
  return node;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Error HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showAuthError(message) {
  showMessage(message);
  const password = $('auth-password');
  if (password) password.value = '';
}

async function checkStoredSession() {
  try {
    const data = await apiRequest('/api/me');
    await onUserLoggedIn(data.user);
  } catch {
    $('auth-modal')?.classList.remove('hidden');
    $('user-profile-bar')?.classList.add('hidden');
  }
}

function toggleAuthMode() {
  isAuthRegisterMode = !isAuthRegisterMode;
  setText('auth-title', isAuthRegisterMode ? 'Crear Cuenta' : 'Iniciar Sesión');
  setText('auth-submit-btn', isAuthRegisterMode ? 'REGISTRARSE' : 'ENTRAR AL JUEGO');
  setText('auth-toggle-btn', isAuthRegisterMode ? '¿Ya tienes cuenta? Inicia sesión' : '¿No tienes cuenta? Regístrate aquí');
}

async function handleAuthSubmit() {
  const username = $('auth-username')?.value.trim() || '';
  const password = $('auth-password')?.value || '';
  if (!username || !password) return showAuthError('Completa todos los campos.');

  const button = $('auth-submit-btn');
  if (button) button.disabled = true;
  try {
    const endpoint = isAuthRegisterMode ? '/api/register' : '/api/login';
    let data;
    try {
      data = await apiRequest(endpoint, { method: 'POST', body: JSON.stringify({ username, password }) });
    } catch (loginError) {
      if (isAuthRegisterMode || loginError.status !== 401) throw loginError;
      data = await migrateLegacyAccount(username, password, loginError);
    }
    if ($('auth-password')) $('auth-password').value = '';
    await onUserLoggedIn(data.user);
    if (data.migrated) showMessage('Cuenta local transferida al servidor. El ELO competitivo empieza en 1000.');
  } catch (error) {
    showAuthError(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function migrateLegacyAccount(username, password, originalError) {
  let legacyUsers;
  try { legacyUsers = JSON.parse(localStorage.getItem('arcane_users') || '{}'); }
  catch { throw originalError; }
  const legacy = legacyUsers?.[username];
  if (!legacy || (legacy.password !== password && legacy.password !== password.trim())) throw originalError;

  let deck = Array.isArray(legacy.deck) ? legacy.deck.slice(0, 30) : [...DEFAULT_DECK];
  const counts = new Map();
  let deckIsSafe = true;
  for (const id of deck) {
    const card = CARD_DATABASE[id];
    if (!Number.isInteger(id) || !card) { deckIsSafe = false; break; }
    const nextCount = (counts.get(id) || 0) + 1;
    if (nextCount > (card.rarity === 'legendary' ? 1 : 2)) { deckIsSafe = false; break; }
    counts.set(id, nextCount);
  }
  if (!deckIsSafe) deck = [...DEFAULT_DECK];

  const data = await apiRequest('/api/migrate-local', {
    method: 'POST',
    body: JSON.stringify({ username, password: legacy.password, deck })
  });
  delete legacyUsers[username];
  if (Object.keys(legacyUsers).length) localStorage.setItem('arcane_users', JSON.stringify(legacyUsers));
  else localStorage.removeItem('arcane_users');
  if (localStorage.getItem('arcane_active_user') === username) localStorage.removeItem('arcane_active_user');
  return data;
}

async function onUserLoggedIn(user) {
  shouldReconnectSocket = true;
  reconnectAttempts = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  pendingSocketMessages.length = 0;
  currentUser = user;
  playerDeck = Array.isArray(user.deck) ? [...user.deck] : [...DEFAULT_DECK];
  $('auth-modal')?.classList.add('hidden');
  $('user-profile-bar')?.classList.remove('hidden');
  setText('user-avatar', (user.username || 'A').charAt(0).toUpperCase());
  setText('user-display-name', user.username);
  updateRankDisplay();
  setText('my-peer-id', user.code || '—');
  setText('status-text', 'Conectando…');
  connectSocket();
  renderDeckbuilder();
  await renderFriendsList();
}

function updateRankDisplay() {
  if (!currentUser) return;
  const rank = currentUser.rank || rankFor(currentUser.rating || 1000);
  setText('user-rank', `${Number(currentUser.rating || 1000)} ELO • ${rank}`);
  setText('ranked-rating', Number(currentUser.rating || 1000));
  setText('ranked-tier', rank);
  setText('ranked-record', `${Number(currentUser.wins || 0)} victorias · ${Number(currentUser.losses || 0)} derrotas`);
}

function rankFor(rating) {
  if (rating >= 2200) return 'Gran Maestro';
  if (rating >= 1900) return 'Diamante';
  if (rating >= 1600) return 'Platino';
  if (rating >= 1300) return 'Oro';
  if (rating >= 1100) return 'Plata';
  if (rating >= 900) return 'Bronce';
  return 'Aprendiz Arcano';
}

async function refreshProfile() {
  if (!currentUser) return;
  try {
    const data = await apiRequest('/api/me');
    currentUser = data.user;
    playerDeck = [...currentUser.deck];
    updateRankDisplay();
    renderDeckbuilder();
  } catch (error) {
    showMessage(error.message);
  }
}

async function logout() {
  shouldReconnectSocket = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (onlineSocket && onlineSocket.readyState === WebSocket.OPEN) {
    try { onlineSocket.send(JSON.stringify({ type: 'queue:leave' })); } catch { /* ignore */ }
    onlineSocket.close();
  }
  onlineSocket = null;
  try { await apiRequest('/api/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
  currentUser = null;
  window.location.reload();
}

function connectSocket() {
  if (!currentUser || !shouldReconnectSocket) return;
  if (onlineSocket && (onlineSocket.readyState === WebSocket.OPEN || onlineSocket.readyState === WebSocket.CONNECTING)) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    onlineSocket = new WebSocket(`${protocol}//${window.location.host}`);
  } catch (error) {
    scheduleSocketReconnect(error.message);
    return;
  }

  onlineSocket.addEventListener('open', () => {
    reconnectAttempts = 0;
    setConnectionStatus(true, 'Conectado');
    const queued = pendingSocketMessages.splice(0, pendingSocketMessages.length);
    queued.forEach((message) => onlineSocket?.readyState === WebSocket.OPEN && onlineSocket.send(JSON.stringify(message)));
    sendSocket('rooms:list');
    if (onlineSnapshot?.status === 'playing') showMessage('Conexión recuperada. Sincronizando partida…');
  });
  onlineSocket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleSocketMessage(message);
  });
  onlineSocket.addEventListener('close', () => {
    setConnectionStatus(false, 'Reconectando…');
    onlineSocket = null;
    if (shouldReconnectSocket && currentUser) scheduleSocketReconnect();
  });
  onlineSocket.addEventListener('error', () => setConnectionStatus(false, 'Error de conexión'));
}

function scheduleSocketReconnect(reason = '') {
  if (!shouldReconnectSocket || !currentUser || reconnectTimer) return;
  reconnectAttempts += 1;
  if (reason) console.warn('WebSocket:', reason);
  if (reconnectAttempts > 10) {
    setConnectionStatus(false, 'Servidor no disponible');
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      try {
        await apiRequest('/api/me');
        reconnectAttempts = 0;
        connectSocket();
      } catch (error) {
        if (error.status === 401) {
          shouldReconnectSocket = false;
          currentUser = null;
          $('auth-modal')?.classList.remove('hidden');
          $('user-profile-bar')?.classList.add('hidden');
          showMessage('La sesión ha caducado. Inicia sesión de nuevo.');
        } else {
          setConnectionStatus(false, 'Servidor sin respuesta');
          reconnectAttempts = 10;
          scheduleSocketReconnect();
        }
      }
    }, 30000);
    return;
  }
  const delay = Math.min(15000, 800 * (2 ** Math.min(reconnectAttempts, 4)));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, delay);
}

function setConnectionStatus(connected, label) {
  const dot = $('status-dot');
  if (dot) dot.className = `w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-600'}`;
  setText('status-text', label);
}

function sendSocket(type, payload = {}) {
  const message = { type, ...payload };
  if (onlineSocket?.readyState === WebSocket.OPEN) {
    onlineSocket.send(JSON.stringify(message));
    return true;
  }
  if (pendingSocketMessages.length < 50) pendingSocketMessages.push(message);
  connectSocket();
  if (!currentUser) showMessage('Inicia sesión para usar el multijugador.');
  else showMessage('Conectando con el servidor…');
  return false;
}

function handleSocketMessage(message) {
  switch (message.type) {
    case 'hello':
      if (message.profile) {
        currentUser = message.profile;
        updateRankDisplay();
        setText('my-peer-id', currentUser.code || '—');
      }
      break;
    case 'rooms:list':
      renderPublicRooms(message.rooms || []);
      break;
    case 'room:created':
      currentRoomCode = message.room?.code || '';
      setText('room-code-display', currentRoomCode || '—');
      const joinInput = $('join-peer-id');
      if (joinInput) joinInput.value = currentRoomCode;
      showMessage(`Sala ${currentRoomCode} creada. Comparte el código con tu rival.`);
      if (pendingChallengeTarget) {
        sendSocket('friend:invite', { target: pendingChallengeTarget });
        pendingChallengeTarget = null;
      }
      break;
    case 'room:left':
      currentRoomCode = '';
      setText('room-code-display', '—');
      break;
    case 'room:expired':
      currentRoomCode = '';
      setText('room-code-display', '—');
      showMessage('La sala ha caducado por inactividad.');
      break;
    case 'queue:status':
      rankedQueueActive = message.status === 'searching';
      updateQueueButton();
      if (rankedQueueActive) showMessage(`Buscando rival cercano a ${message.rating} ELO…`);
      else if (message.status === 'cancelled') showMessage('Búsqueda cancelada.');
      break;
    case 'match:found':
      rankedQueueActive = false;
      updateQueueButton();
      isOnlineMode = true;
      selectedAttackerId = null;
      showMessage(`¡Rival encontrado! ${message.opponent ? `Contra ${message.opponent}.` : ''}`);
      break;
    case 'match:state':
      onlineSnapshot = message.state;
      isOnlineMode = true;
      selectedAttackerId = null;
      switchTab('battle');
      renderBattle(message.state);
      break;
    case 'match:ended':
      if (message.profile) currentUser = message.profile;
      updateRankDisplay();
      refreshLeaderboard();
      if (message.draw) showMessage('Partida empatada.');
      else showMessage(message.winner ? `¡Victoria! ${message.ratingChange ? `Has ganado ${message.ratingChange} ELO.` : ''}` : `Derrota. ${message.ratingChange ? `Has perdido ${Math.abs(message.ratingChange)} ELO.` : ''}`);
      refreshProfile();
      break;
    case 'match:emote':
      showFloatingEmote(message.emoji, 'enemy');
      break;
    case 'friend:invite':
      if (window.confirm(`${message.from} te ha invitado a una partida. ¿Unirte a la sala ${message.code}?`)) {
        switchTab('online');
        if ($('join-peer-id')) $('join-peer-id').value = message.code;
        joinOnlineRoom();
      }
      break;
    case 'friend:invite-sent':
      showMessage(`Invitación enviada a ${message.target}.`);
      break;
    case 'friends:update':
      renderFriendsList();
      break;
    case 'error':
      showMessage(message.error || 'Ha ocurrido un error.');
      break;
    default:
      break;
  }
}

async function saveUserData() {
  if (!currentUser) return;
  try {
    await apiRequest('/api/deck', { method: 'PUT', body: JSON.stringify({ deck: playerDeck }) });
    currentUser.deck = [...playerDeck];
  } catch (error) {
    showMessage(error.message);
  }
}

/* FRIENDS: backed by the central server, not localStorage. */
function toggleFriendsModal() {
  $('friends-modal')?.classList.toggle('hidden');
  renderFriendsList();
}

async function sendFriendRequest() {
  const target = $('add-friend-input')?.value.trim() || '';
  if (!target) return showMessage('Escribe un nombre o código de jugador.');
  try {
    const result = await apiRequest('/api/friends/request', { method: 'POST', body: JSON.stringify({ target }) });
    if ($('add-friend-input')) $('add-friend-input').value = '';
    showMessage(result.message || 'Solicitud enviada.');
  } catch (error) {
    showMessage(error.message);
  }
}

async function acceptFriendRequest(userId) {
  try {
    await apiRequest('/api/friends/respond', { method: 'POST', body: JSON.stringify({ userId, accept: true }) });
    await renderFriendsList();
  } catch (error) {
    showMessage(error.message);
  }
}

async function rejectFriendRequest(userId) {
  try {
    await apiRequest('/api/friends/respond', { method: 'POST', body: JSON.stringify({ userId, accept: false }) });
    await renderFriendsList();
  } catch (error) {
    showMessage(error.message);
  }
}

async function renderFriendsList() {
  const list = $('friends-list');
  const pendingList = $('pending-requests-list');
  const pendingContainer = $('pending-requests-container');
  if (!list || !pendingList || !pendingContainer || !currentUser) return;
  list.replaceChildren();
  pendingList.replaceChildren();
  try {
    const data = await apiRequest('/api/friends');
    const pending = data.pendingRequests || [];
    pendingContainer.classList.toggle('hidden', pending.length === 0);
    $('friends-badge')?.classList.toggle('hidden', pending.length === 0);
    pending.forEach((friend) => {
      const row = makeElement('div', 'flex items-center justify-between text-xs bg-slate-900 p-1.5 rounded border border-amber-700/40');
      row.append(makeElement('span', 'font-bold text-amber-300', friend.username));
      const actions = makeElement('div', 'flex gap-1');
      const accept = makeElement('button', 'px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-[10px]', 'Aceptar');
      accept.addEventListener('click', () => acceptFriendRequest(friend.id));
      const reject = makeElement('button', 'px-2 py-0.5 bg-slate-700 hover:bg-slate-600 text-white rounded font-bold text-[10px]', 'Rechazar');
      reject.addEventListener('click', () => rejectFriendRequest(friend.id));
      actions.append(accept, reject);
      row.append(actions);
      pendingList.append(row);
    });
    if (!data.friends?.length) {
      list.append(makeElement('div', 'text-center text-xs text-slate-500 py-8', 'No tienes amigos añadidos.'));
      return;
    }
    data.friends.forEach((friend) => {
      const row = makeElement('div', 'flex items-center justify-between bg-slate-900 border border-slate-800 p-2.5 rounded-xl text-xs');
      const info = makeElement('div', 'flex items-center space-x-2');
      info.append(makeElement('div', `w-2.5 h-2.5 rounded-full ${friend.online ? 'bg-emerald-500' : 'bg-slate-600'}`));
      info.append(makeElement('span', 'font-bold text-slate-200', friend.username));
      const challenge = makeElement('button', 'px-3 py-1 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-slate-950 font-black rounded-lg text-[10px] shadow', '⚔ Desafiar');
      challenge.disabled = !friend.online;
      challenge.title = friend.online ? 'Crear una sala privada e invitar' : 'No está conectado';
      challenge.addEventListener('click', () => challengeFriend(friend.username));
      row.append(info, challenge);
      list.append(row);
    });
  } catch (error) {
    list.append(makeElement('div', 'text-center text-xs text-red-400 py-8', error.message));
  }
}

function challengeFriend(friendName) {
  $('friends-modal')?.classList.add('hidden');
  pendingChallengeTarget = friendName;
  switchTab('online');
  createOnlineRoom('private');
}

/* CARD COLLECTION: filtering and page boundaries are clamped. */
function filterCollection() { currentPage = 1; renderCollection(); }

function getFilteredCards() {
  const search = ($('collection-search')?.value || '').trim().toLocaleLowerCase('es');
  const manaFilter = $('filter-mana')?.value || 'all';
  const tribeFilter = $('filter-tribe')?.value || 'all';
  return CARD_DATABASE.filter((card) => {
    const matchesSearch = !search || card.name.toLocaleLowerCase('es').includes(search) || card.description.toLocaleLowerCase('es').includes(search);
    const matchesMana = manaFilter === 'all' || (manaFilter === '0' ? card.mana <= 1 : (manaFilter === '6' ? card.mana >= 6 : card.mana === Number(manaFilter)));
    const matchesTribe = tribeFilter === 'all' || card.tribe === tribeFilter;
    return matchesSearch && matchesMana && matchesTribe;
  });
}

function renderCollection() {
  const grid = $('collection-grid');
  if (!grid) return;
  const filtered = getFilteredCards();
  const totalPages = Math.max(1, Math.ceil(filtered.length / CARDS_PER_PAGE));
  currentPage = Math.max(1, Math.min(currentPage, totalPages));
  setText('page-num', currentPage);
  setText('total-pages', totalPages);
  const previous = $('btn-prev-page');
  const next = $('btn-next-page');
  if (previous) previous.disabled = currentPage <= 1;
  if (next) next.disabled = currentPage >= totalPages;
  const start = (currentPage - 1) * CARDS_PER_PAGE;
  const fragment = document.createDocumentFragment();
  filtered.slice(start, start + CARDS_PER_PAGE).forEach((card) => fragment.append(createCardUI(card)));
  grid.replaceChildren(fragment);
}

function changePage(delta) {
  const totalPages = Math.max(1, Math.ceil(getFilteredCards().length / CARDS_PER_PAGE));
  currentPage = Math.max(1, Math.min(totalPages, currentPage + Number(delta || 0)));
  renderCollection();
}

/* DECK BUILDER: all 500 cards searchable, copy limits and 30-card validation. */
function renderDeckbuilder() {
  const grid = $('deck-cards-grid');
  const list = $('deck-list-items');
  if (!grid || !list) return;
  list.replaceChildren();
  grid.replaceChildren();
  setText('deck-count-nav', playerDeck.length);
  setText('deck-card-count', playerDeck.length);

  const deckCounts = new Map();
  playerDeck.forEach((id) => deckCounts.set(id, (deckCounts.get(id) || 0) + 1));
  playerDeck.forEach((cardId, index) => {
    const card = CARD_DATABASE[cardId];
    if (!card) return;
    const row = makeElement('div', 'flex items-center justify-between bg-slate-900 border border-slate-700/60 p-2 rounded-lg text-xs');
    row.append(makeElement('span', 'font-semibold text-slate-200 truncate', card.name));
    const remove = makeElement('button', 'text-red-400 font-bold px-2', '×');
    remove.setAttribute('aria-label', `Quitar ${card.name}`);
    remove.addEventListener('click', () => removeFromDeck(index));
    row.append(remove);
    list.append(row);
  });

  const query = ($('deck-search')?.value || '').trim().toLocaleLowerCase('es');
  const filtered = CARD_DATABASE.filter((card) => !query || card.name.toLocaleLowerCase('es').includes(query) || card.description.toLocaleLowerCase('es').includes(query));
  const visible = filtered.slice(0, deckBuilderVisibleCount);
  const fragment = document.createDocumentFragment();
  visible.forEach((card) => {
    const ui = createCardUI(card);
    const count = deckCounts.get(card.id) || 0;
    const max = card.rarity === 'legendary' ? 1 : 2;
    ui.classList.toggle('opacity-50', playerDeck.length >= 30 || count >= max);
    ui.title = `En el mazo: ${count}/${max}`;
    ui.addEventListener('click', () => addToDeck(card.id));
    fragment.append(ui);
  });
  if (visible.length < filtered.length) {
    const more = makeElement('button', 'col-span-full w-full py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-xs font-bold border border-amber-600/30', `Mostrar más (${filtered.length - visible.length} restantes)`);
    more.addEventListener('click', () => { deckBuilderVisibleCount += DECK_BUILDER_BATCH; renderDeckbuilder(); });
    fragment.append(more);
  }
  grid.append(fragment);
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  const status = $('deck-validation-status');
  if (status) {
    status.textContent = validation.valid ? 'Mazo válido para jugar' : validation.reason || `Faltan ${30 - playerDeck.length} cartas.`;
    status.className = `text-[10px] ${validation.valid ? 'text-emerald-400' : 'text-amber-400'}`;
  }
}

function addToDeck(id) {
  const card = CARD_DATABASE[id];
  if (!card) return;
  if (playerDeck.length >= 30) return showMessage('El mazo ya tiene 30 cartas.');
  const count = playerDeck.filter((cardId) => cardId === id).length;
  const max = card.rarity === 'legendary' ? 1 : 2;
  if (count >= max) return showMessage(`${card.name}: máximo ${max} copia(s).`);
  playerDeck.push(id);
  renderDeckbuilder();
  saveUserData();
}

function removeFromDeck(index) {
  if (!Number.isInteger(index) || index < 0 || index >= playerDeck.length) return;
  playerDeck.splice(index, 1);
  renderDeckbuilder();
  saveUserData();
}

function clearDeck() {
  playerDeck = [];
  renderDeckbuilder();
  saveUserData();
}

function autoFillDeck() {
  const deck = [];
  const counts = new Map();
  while (deck.length < 30) {
    const id = Math.floor(Math.random() * CARD_DATABASE.length);
    const card = CARD_DATABASE[id];
    const cap = card.rarity === 'legendary' ? 1 : 2;
    const count = counts.get(id) || 0;
    if (count >= cap) continue;
    deck.push(id);
    counts.set(id, count + 1);
  }
  playerDeck = deck;
  renderDeckbuilder();
  saveUserData();
}

function confirmDeckReady() {
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  if (!validation.valid) return showMessage(validation.reason);
  saveUserData();
  switchTab('online');
  showMessage('Mazo validado. Ya puedes buscar partida.');
}

/* Shared card rendering: dynamic text is assigned with textContent, never interpolated into HTML. */
function createCardUI(card) {
  const container = makeElement('div', `card-container relative w-36 h-52 bg-slate-900 rounded-xl border-2 ${card.rarity === 'legendary' ? 'border-amber-400' : (card.rarity === 'epic' ? 'border-purple-500' : (card.rarity === 'rare' ? 'border-blue-500' : 'border-slate-700'))} p-2 flex flex-col justify-between shadow-md cursor-pointer select-none overflow-hidden`);
  const cost = makeElement('div', 'absolute top-1 left-1 w-6 h-6 rounded-full bg-blue-600 border border-blue-300 flex items-center justify-center text-white font-black text-xs z-20 shadow', card.mana);
  const header = makeElement('div', 'text-center pt-1 px-1');
  header.append(makeElement('div', 'font-cinzel font-bold text-[10px] text-amber-200 truncate', card.name));
  header.append(makeElement('div', 'text-[8px] uppercase text-slate-400 font-semibold', card.tribe));
  const art = makeElement('div', 'my-1 h-14 rounded bg-slate-950 flex items-center justify-center border border-slate-800 text-amber-500');
  const icon = makeElement('i', `fa-solid ${card.icon} text-2xl`);
  icon.setAttribute('aria-hidden', 'true');
  art.append(icon);
  const description = makeElement('div', 'text-[8px] text-slate-300 leading-tight bg-slate-950/80 p-1 rounded border border-slate-800 text-center flex-1 flex items-center justify-center', card.description || 'Sin descripción.');
  container.append(cost, header, art, description);
  if (card.type === 'minion') {
    const stats = makeElement('div', 'flex justify-between items-center pt-1');
    stats.append(makeElement('span', 'w-5 h-5 rounded-full bg-red-700 text-white font-bold text-xs flex items-center justify-center', card.attack));
    stats.append(makeElement('span', 'w-5 h-5 rounded-full bg-emerald-700 text-white font-bold text-xs flex items-center justify-center', card.health));
    container.append(stats);
  } else {
    container.append(makeElement('div', 'text-center text-[9px] text-blue-400 font-bold', 'HECHIZO'));
  }
  return container;
}

/* TAB NAVIGATION */
function switchTab(tabId) {
  const tabs = ['main-menu', 'collection', 'deckbuilder', 'online', 'battle', 'ranked'];
  if (!tabs.includes(tabId)) return;
  tabs.forEach((id) => $(`view-${id}`)?.classList.toggle('hidden', id !== tabId));
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.className = 'nav-btn px-4 py-1.5 rounded-lg text-sm font-semibold transition-all duration-200 text-slate-400 hover:text-amber-300 hover:bg-slate-800/60';
  });
  $(`btn-tab-${tabId}`)?.classList.remove('text-slate-400', 'hover:text-amber-300', 'hover:bg-slate-800/60');
  $(`btn-tab-${tabId}`)?.classList.add('text-amber-400', 'bg-amber-950/40', 'border', 'border-amber-600/30');
  if (tabId === 'collection') renderCollection();
  if (tabId === 'deckbuilder') renderDeckbuilder();
  if (tabId === 'online') sendSocket('rooms:list');
  if (tabId === 'ranked') refreshLeaderboard();
}

/* ONLINE PUBLIC ROOMS + PRIVATE ROOM CODES + RANKED MATCHMAKING. */
function createOnlineRoom(visibility = 'private') {
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  if (!validation.valid) return showMessage(validation.reason);
  switchTab('online');
  const roomName = $('room-name-input')?.value.trim() || '';
  sendSocket('room:create', { visibility, name: roomName });
}

function leaveRoom() { sendSocket('room:leave'); }

function createPublicRoom() { createOnlineRoom('public'); }
function createPrivateRoom() { createOnlineRoom('private'); }

function joinOnlineRoom() {
  const code = ($('join-peer-id')?.value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return showMessage('Introduce un código de sala válido de 6 caracteres.');
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  if (!validation.valid) return showMessage(validation.reason);
  sendSocket('room:join', { code });
}

function joinPublicRoom(roomId) {
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  if (!validation.valid) return showMessage(validation.reason);
  sendSocket('room:join-public', { roomId });
}

function renderPublicRooms(rooms) {
  const list = $('public-rooms-list');
  if (!list) return;
  list.replaceChildren();
  if (!rooms.length) {
    list.append(makeElement('div', 'text-center text-xs text-slate-500 py-4', 'No hay salas públicas esperando. ¡Crea la primera!'));
    return;
  }
  rooms.forEach((room) => {
    const row = makeElement('div', 'flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-950/80 border border-slate-800 rounded-lg p-3');
    const details = makeElement('div', 'min-w-0');
    details.append(makeElement('div', 'text-sm font-bold text-amber-300 truncate', room.name));
    details.append(makeElement('div', 'text-[10px] text-slate-400', `Anfitrión: ${room.host} · ${room.rating} ELO · Código ${room.code}`));
    const join = makeElement('button', 'px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-xs font-bold', 'Unirse');
    join.addEventListener('click', () => joinPublicRoom(room.id));
    row.append(details, join);
    list.append(row);
  });
}

function queueRanked() {
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  if (!validation.valid) return showMessage(validation.reason);
  if (rankedQueueActive) {
    rankedQueueActive = false;
    sendSocket('queue:leave');
  } else {
    rankedQueueActive = true;
    sendSocket('queue:join');
  }
  updateQueueButton();
}

function updateQueueButton() {
  const button = $('ranked-queue-btn');
  if (!button) return;
  button.textContent = rankedQueueActive ? 'CANCELAR BÚSQUEDA' : 'BUSCAR PARTIDA CLASIFICATORIA';
  button.classList.toggle('from-red-700', rankedQueueActive);
  button.classList.toggle('to-red-800', rankedQueueActive);
}

function copyMyId() {
  const value = currentUser?.code || '';
  if (!value) return showMessage('Inicia sesión para ver tu código.');
  const fallback = () => {
    const input = document.createElement('textarea');
    input.value = value;
    document.body.append(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    showMessage('Código copiado.');
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(() => showMessage('Código copiado.')).catch(fallback);
  else fallback();
}

async function refreshLeaderboard() {
  const list = $('leaderboard-list');
  if (!list) return;
  list.replaceChildren(makeElement('div', 'text-center text-xs text-slate-500 py-4', 'Cargando clasificación…'));
  try {
    const data = await apiRequest('/api/leaderboard?limit=50');
    list.replaceChildren();
    if (!data.leaderboard?.length) {
      list.append(makeElement('div', 'text-center text-xs text-slate-500 py-4', 'Aún no hay jugadores clasificados.'));
      return;
    }
    data.leaderboard.forEach((row) => {
      const item = makeElement('div', 'grid grid-cols-[36px_1fr_auto] items-center gap-3 bg-slate-950/80 border border-slate-800 rounded-lg px-3 py-2');
      item.append(makeElement('span', 'text-center text-sm font-black text-amber-400', `#${row.position}`));
      const identity = makeElement('div', 'min-w-0');
      identity.append(makeElement('div', 'text-xs font-bold text-slate-100 truncate', row.username));
      identity.append(makeElement('div', 'text-[10px] text-slate-500', `${row.rank} · ${row.wins} V / ${row.losses} D`));
      item.append(identity, makeElement('span', 'text-sm font-black text-blue-300 tabular-nums', `${row.rating} ELO`));
      list.append(item);
    });
  } catch (error) {
    list.replaceChildren(makeElement('div', 'text-center text-xs text-red-400 py-4', error.message));
  }
}

/* LOCAL VS AI: same rules engine as the competitive server. */
function startVsAI() {
  const validation = window.ArcaneEngine.validateDeck(playerDeck);
  if (!validation.valid) return showMessage(validation.reason);
  if (onlineSocket?.readyState === WebSocket.OPEN) { sendSocket('queue:leave'); sendSocket('room:leave'); }
  if (aiTimer) clearTimeout(aiTimer);
  aiTimer = null;
  isOnlineMode = false;
  onlineSnapshot = null;
  selectedAttackerId = null;
  const player = { id: currentUser?.id || 'local-player', username: currentUser?.username || 'Jugador', rating: currentUser?.rating || 1000 };
  const ai = { id: 'arcane-ai', username: 'Arconte CPU', rating: 1000 };
  localMatch = window.ArcaneEngine.createMatch(player, ai, playerDeck, DEFAULT_DECK, { mode: 'ai', rated: false, firstSeat: 'A' });
  localEndHandledMatchId = null;
  switchTab('battle');
  renderLocalBattle();
}

function renderLocalBattle() {
  if (!localMatch) return;
  renderBattle(window.ArcaneEngine.getView(localMatch, 'A'));
  if (localMatch.status === 'playing' && localMatch.turn === 'B') scheduleAITurn();
  if (localMatch.status === 'ended') finishLocalMatch();
}

let aiTimer = null;
function scheduleAITurn() {
  if (aiTimer) clearTimeout(aiTimer);
  aiTimer = setTimeout(playAITurn, 550);
}

function playAITurn() {
  aiTimer = null;
  if (!localMatch || localMatch.status !== 'playing' || localMatch.turn !== 'B') return;
  try {
    // Play affordable cards, preferring higher-cost minions but allowing spells.
    let guard = 0;
    while (guard < 7 && localMatch.status === 'playing' && localMatch.turn === 'B') {
      guard += 1;
      const enemy = localMatch.players.B;
      const affordable = enemy.hand.map((card, index) => ({ card, index }))
        .filter(({ card }) => card.mana <= enemy.mana && (card.type !== 'minion' || enemy.board.length < 7))
        .sort((a, b) => b.card.mana - a.card.mana);
      if (!affordable.length) break;
      window.ArcaneEngine.applyAction(localMatch, 'B', { type: 'play_card', index: affordable[0].index });
    }

    const attackers = [...localMatch.players.B.board].filter((minion) => minion.canAttack && !minion.hasAttacked);
    for (const attacker of attackers) {
      if (localMatch.status !== 'playing') break;
      const player = localMatch.players.A;
      const taunts = player.board.filter((minion) => minion.taunt);
      if (taunts.length) {
        const target = [...taunts].sort((a, b) => a.health - b.health)[0];
        window.ArcaneEngine.applyAction(localMatch, 'B', { type: 'attack', attackerId: attacker.instanceId, targetType: 'minion', targetId: target.instanceId });
      } else {
        const trade = [...player.board].filter((minion) => minion.health <= attacker.attack).sort((a, b) => a.attack - b.attack)[0];
        if (trade && trade.attack >= attacker.health) {
          window.ArcaneEngine.applyAction(localMatch, 'B', { type: 'attack', attackerId: attacker.instanceId, targetType: 'minion', targetId: trade.instanceId });
        } else {
          window.ArcaneEngine.applyAction(localMatch, 'B', { type: 'attack', attackerId: attacker.instanceId, targetType: 'hero' });
        }
      }
    }
    if (localMatch.status === 'playing' && localMatch.turn === 'B') window.ArcaneEngine.applyAction(localMatch, 'B', { type: 'end_turn' });
  } catch (error) {
    console.error('Turno de IA:', error);
  }
  renderLocalBattle();
}

function submitLocalAction(action) {
  if (!localMatch || localMatch.status !== 'playing') return;
  try {
    window.ArcaneEngine.applyAction(localMatch, 'A', action);
    selectedAttackerId = null;
    renderLocalBattle();
  } catch (error) {
    showMessage(error.message);
  }
}

function finishLocalMatch() {
  if (!localMatch || localMatch.status !== 'ended' || localEndHandledMatchId === localMatch.id) return;
  localEndHandledMatchId = localMatch.id;
  const won = localMatch.winner === 'A';
  window.setTimeout(() => {
    window.alert(won ? '¡VICTORIA!' : (localMatch.winner === 'draw' ? '¡EMPATE!' : 'DERROTA'));
    switchTab('main-menu');
  }, 250);
}

function startOnlineMatch() {
  showMessage('La partida online la inicia el servidor cuando se une un rival.');
}

/* BATTLE RENDERING */
function renderBattle(snapshot) {
  const you = snapshot.you;
  const opponent = snapshot.opponent;
  if (!you || !opponent) return;
  const isMyTurn = Boolean(snapshot.myTurn);
  setText('player-hero-name', you.username || currentUser?.username || 'Jugador');
  setText('enemy-name', opponent.username || 'Oponente');
  setText('player-hp', you.hp);
  setText('player-armor', you.armor);
  setText('player-mana', you.mana);
  setText('player-max-mana', you.maxMana);
  setText('enemy-hp', opponent.hp);
  setText('enemy-armor', opponent.armor);
  setText('enemy-mana', opponent.mana);
  setText('enemy-max-mana', opponent.maxMana);
  setText('current-turn-indicator', isMyTurn ? 'Tu turno' : 'Rival');

  const endButton = $('btn-end-turn');
  if (endButton) {
    endButton.disabled = !isMyTurn || snapshot.status !== 'playing';
    endButton.classList.toggle('opacity-50', !isMyTurn);
    endButton.textContent = isMyTurn ? 'TERMINAR TURNO' : 'TURNO DEL RIVAL';
  }

  const pHand = $('player-hand');
  if (pHand) {
    const fragment = document.createDocumentFragment();
    (you.hand || []).forEach((card, index) => {
      const ui = createCardUI(card);
      ui.classList.add('hand-card');
      if (!isMyTurn || card.mana > you.mana + (you.tempMana || 0) || (card.type === 'minion' && you.board.length >= 7)) ui.classList.add('opacity-60');
      ui.addEventListener('click', () => playCard(index));
      fragment.append(ui);
    });
    pHand.replaceChildren(fragment);
  }

  const eHand = $('enemy-hand');
  if (eHand) {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < (opponent.handCount || 0); i += 1) {
      const back = makeElement('div', 'w-10 h-14 bg-amber-950 border border-amber-600/40 rounded shadow flex items-center justify-center text-amber-500/40 text-xs');
      const icon = makeElement('i', 'fa-solid fa-shield');
      back.append(icon);
      fragment.append(back);
    }
    eHand.replaceChildren(fragment);
  }

  renderBoard('player-board', you.board || [], 'player');
  renderBoard('enemy-board', opponent.board || [], 'enemy');
}

function renderBoard(containerId, board, side) {
  const container = $(containerId);
  if (!container) return;
  const fragment = document.createDocumentFragment();
  board.forEach((minion) => fragment.append(createBoardSlot(minion, side)));
  container.replaceChildren(fragment);
}

function createBoardSlot(minion, side) {
  const selected = side === 'player' && selectedAttackerId === minion.instanceId;
  const slot = makeElement('div', `board-slot w-24 h-28 bg-slate-900 border-2 ${selected ? 'selected-attacker' : 'border-slate-700'} rounded-lg p-1 flex flex-col justify-between cursor-pointer`);
  if (minion.taunt) slot.classList.add('border-amber-400');
  const name = makeElement('div', 'text-[9px] font-bold text-amber-200 text-center truncate', minion.name);
  const art = makeElement('div', 'h-10 bg-slate-950 flex items-center justify-center text-amber-400');
  const icon = makeElement('i', `fa-solid ${minion.icon || 'fa-paw'}`);
  art.append(icon);
  const stats = makeElement('div', 'flex justify-between text-xs font-black');
  stats.append(makeElement('span', 'text-red-400', minion.attack));
  stats.append(makeElement('span', 'text-emerald-400', minion.health));
  slot.append(name, art, stats);
  slot.title = [minion.taunt ? 'Provocar' : '', minion.shieldActive ? 'Escudo divino' : '', minion.canAttack ? 'Puede atacar' : ''].filter(Boolean).join(' · ');
  slot.addEventListener('click', () => handleTargetClick(side === 'player' ? 'player_minion' : 'enemy_minion', minion.instanceId));
  return slot;
}

function playCard(index) {
  if (isOnlineMode) return sendSocket('match:action', { action: { type: 'play_card', index } });
  submitLocalAction({ type: 'play_card', index });
}

function handleTargetClick(type, targetId = null) {
  const snapshot = isOnlineMode ? onlineSnapshot : (localMatch ? window.ArcaneEngine.getView(localMatch, 'A') : null);
  if (!snapshot?.myTurn) return;
  if (type === 'player_minion') {
    const minion = snapshot.you.board.find((item) => item.instanceId === targetId);
    if (!minion || !minion.canAttack || minion.hasAttacked || minion.isFrozen) return showMessage('Ese esbirro no puede atacar ahora.');
    selectedAttackerId = selectedAttackerId === targetId ? null : targetId;
    renderBattle(snapshot);
    showMessage(selectedAttackerId ? 'Atacante seleccionado. Elige un objetivo.' : 'Selección cancelada.');
    return;
  }
  if (!selectedAttackerId) return;
  let action;
  if (type === 'enemy_hero') action = { type: 'attack', attackerId: selectedAttackerId, targetType: 'hero' };
  else if (type === 'enemy_minion') action = { type: 'attack', attackerId: selectedAttackerId, targetType: 'minion', targetId };
  else return;
  selectedAttackerId = null;
  if (isOnlineMode) sendSocket('match:action', { action });
  else submitLocalAction(action);
}

function endTurn() {
  if (isOnlineMode) sendSocket('match:action', { action: { type: 'end_turn' } });
  else submitLocalAction({ type: 'end_turn' });
}

function concedeMatch() {
  if (isOnlineMode) sendSocket('match:action', { action: { type: 'concede' } });
  else if (localMatch?.status === 'playing') {
    try { window.ArcaneEngine.applyAction(localMatch, 'A', { type: 'concede' }); renderLocalBattle(); }
    catch (error) { showMessage(error.message); }
  }
}

function sendEmote(emoji) {
  if (!['🔥', '⚔️', '💀', '👑'].includes(emoji)) return;
  showFloatingEmote(emoji, 'player');
  if (isOnlineMode) sendSocket('match:emote', { emoji });
}

function showFloatingEmote(emoji, side) {
  const layer = $('emote-layer');
  if (!layer) return;
  const el = makeElement('div', `absolute text-4xl animate-emoji ${side === 'player' ? 'bottom-20 left-1/4' : 'top-20 right-1/4'}`, emoji);
  layer.append(el);
  setTimeout(() => el.remove(), 2000);
}

function showMessage(message) {
  const el = $('app-toast') || $('game-message');
  if (!el) { console.info(message); return; }
  if (messageTimer) clearTimeout(messageTimer);
  el.textContent = String(message);
  el.classList.remove('hidden');
  messageTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function validateInitialDOM() {
  const requiredIds = [
    'auth-modal', 'main-menu', 'collection-grid', 'deck-cards-grid', 'deck-list-items',
    'view-online', 'view-battle', 'player-hand', 'enemy-hand', 'player-board', 'enemy-board',
    'btn-tab-main-menu', 'btn-tab-online', 'btn-tab-ranked'
  ];
  const missing = requiredIds.filter((id) => !$(id));
  if (missing.length) console.warn('Elementos de interfaz ausentes:', missing.join(', '));
}

window.addEventListener('DOMContentLoaded', async () => {
  validateInitialDOM();
  switchTab('main-menu');
  await checkStoredSession();
});

// Expose inline HTML handlers and the console test surface.
Object.assign(window, {
  handleAuthSubmit, toggleAuthMode, logout, toggleFriendsModal, sendFriendRequest, acceptFriendRequest,
  challengeFriend, filterCollection, changePage, renderDeckbuilder, clearDeck, autoFillDeck, confirmDeckReady,
  switchTab, startVsAI, startOnlineMatch, createOnlineRoom, createPublicRoom, createPrivateRoom,
  joinOnlineRoom, joinPublicRoom, leaveRoom, queueRanked, copyMyId, sendEmote, endTurn, concedeMatch,
  handleTargetClick, playCard, sendSocket, refreshLeaderboard
});
