'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const WebSocket = require('ws');
const { CARD_DATABASE, DEFAULT_DECK, validateDeck, createMatch, applyAction, getView } = require('./shared/game-engine.js');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'arcane-db.json');
const SESSION_COOKIE = 'arcane_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const RECONNECT_GRACE_MS = 45_000;
const MATCH_CLEANUP_MS = 120_000;
const ALLOWED_EMOTES = new Set(['🔥', '⚔️', '💀', '👑']);

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadDatabase() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (parsed && parsed.users && typeof parsed.users === 'object') return parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('No se pudo leer la base de datos; se iniciará una vacía:', error.message);
  }
  return { users: {} };
}

let database = loadDatabase();
let dirtyWriteScheduled = false;
function saveDatabase() {
  const tempFile = `${DB_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(database, null, 2), { mode: 0o600 });
  fs.renameSync(tempFile, DB_FILE);
}
function scheduleSave() {
  if (dirtyWriteScheduled) return;
  dirtyWriteScheduled = true;
  setTimeout(() => {
    dirtyWriteScheduled = false;
    try { saveDatabase(); } catch (error) { console.error('Error guardando datos:', error); }
  }, 80).unref?.();
}

const sessions = new Map(); // token -> { userId, expiresAt }
const clients = new Map(); // userId -> WebSocket
const publicRooms = new Map(); // roomId -> room
const rankedQueue = new Map(); // userId -> queue entry
const matches = new Map(); // matchId -> { engine, users, timers }
const userMatch = new Map(); // userId -> matchId
const authAttempts = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

function getRank(rating) {
  if (rating >= 2200) return 'Gran Maestro';
  if (rating >= 1900) return 'Diamante';
  if (rating >= 1600) return 'Platino';
  if (rating >= 1300) return 'Oro';
  if (rating >= 1100) return 'Plata';
  if (rating >= 900) return 'Bronce';
  return 'Aprendiz Arcano';
}

function safeProfile(user) {
  return {
    id: user.id,
    username: user.username,
    code: user.code,
    rating: user.rating,
    rank: getRank(user.rating),
    wins: user.wins,
    losses: user.losses,
    gamesPlayed: user.wins + user.losses,
    deck: [...user.deck],
    friends: [...user.friends],
    pendingRequests: [...user.pendingRequests]
  };
}

function findUserByNameOrCode(value) {
  const target = String(value || '').trim().toLowerCase();
  return Object.values(database.users).find((user) => user.username.toLowerCase() === target || user.code.toLowerCase() === target) || null;
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); } catch { return null; }
    }
  }
  return null;
}

function currentSession(req) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = database.users[session.userId];
  return user ? { token, session, user } : null;
}

function requireAuth(req, res, next) {
  const auth = currentSession(req);
  if (!auth) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  req.user = auth.user;
  req.sessionToken = auth.token;
  next();
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origen no permitido.' });
  } catch {
    return res.status(403).json({ error: 'Origen no válido.' });
  }
  next();
}
app.use('/api', sameOrigin);

function checkAuthRateLimit(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entries = (authAttempts.get(key) || []).filter((time) => now - time < 15 * 60_000);
  if (entries.length >= 10) return res.status(429).json({ error: 'Demasiados intentos. Prueba de nuevo dentro de unos minutos.' });
  entries.push(now);
  authAttempts.set(key, entries);
  next();
}

function issueSession(user, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  const flags = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${IS_PRODUCTION ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${flags}`);
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}

app.post('/api/register', checkAuthRateLimit, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: 'El usuario debe tener entre 3 y 16 caracteres: letras, números o guion bajo.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
  if (findUserByNameOrCode(username)) return res.status(409).json({ error: 'Ese nombre de usuario ya está registrado.' });

  const salt = crypto.randomBytes(16).toString('hex');
  let code;
  do { code = `ARC-${crypto.randomInt(100000, 999999)}`; } while (findUserByNameOrCode(code));
  const id = crypto.randomUUID();
  const user = {
    id, username, code,
    passwordSalt: salt,
    passwordHash: passwordHash(password, salt),
    rating: 1000, wins: 0, losses: 0,
    deck: [...DEFAULT_DECK],
    friends: [], pendingRequests: [],
    createdAt: Date.now()
  };
  database.users[id] = user;
  saveDatabase();
  issueSession(user, res);
  res.status(201).json({ user: safeProfile(user) });
});

app.post('/api/migrate-local', checkAuthRateLimit, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const deckValidation = validateDeckDraft(req.body?.deck);
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: 'El usuario local no cumple el formato actual.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'La contraseña debe tener entre 8 y 128 caracteres.' });
  if (!deckValidation.valid) return res.status(400).json({ error: `No se pudo transferir el mazo: ${deckValidation.reason}` });
  if (findUserByNameOrCode(username)) return res.status(409).json({ error: 'Ya existe una cuenta de servidor con ese nombre. Inicia sesión normalmente.' });

  const salt = crypto.randomBytes(16).toString('hex');
  let code;
  do { code = `ARC-${crypto.randomInt(100000, 999999)}`; } while (findUserByNameOrCode(code));
  const id = crypto.randomUUID();
  const user = {
    id, username, code,
    passwordSalt: salt,
    passwordHash: passwordHash(password, salt),
    rating: 1000, wins: 0, losses: 0,
    deck: [...req.body.deck],
    friends: [], pendingRequests: [],
    createdAt: Date.now(),
    migratedLocalProfile: true
  };
  database.users[id] = user;
  saveDatabase();
  issueSession(user, res);
  res.status(201).json({ user: safeProfile(user), migrated: true });
});

app.post('/api/login', checkAuthRateLimit, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = findUserByNameOrCode(username);
  if (!user || password.length > 128) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  const candidate = Buffer.from(passwordHash(password, user.passwordSalt), 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  if (candidate.length !== expected.length || !crypto.timingSafeEqual(candidate, expected)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  issueSession(user, res);
  res.json({ user: safeProfile(user) });
});

app.post('/api/logout', (req, res) => {
  const auth = currentSession(req);
  if (auth) sessions.delete(auth.token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${IS_PRODUCTION ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: safeProfile(req.user) }));

function validateDeckDraft(deck) {
  if (!Array.isArray(deck) || deck.length > 30) return { valid: false, reason: 'El mazo no puede superar las 30 cartas.' };
  const counts = new Map();
  for (const id of deck) {
    if (!Number.isInteger(id) || id < 0 || id >= CARD_DATABASE.length) return { valid: false, reason: 'El mazo contiene una carta inexistente.' };
    const count = (counts.get(id) || 0) + 1;
    counts.set(id, count);
    const max = CARD_DATABASE[id].rarity === 'legendary' ? 1 : 2;
    if (count > max) return { valid: false, reason: `${CARD_DATABASE[id].name}: máximo ${max} copia(s).` };
  }
  return { valid: true, reason: '' };
}

app.put('/api/deck', requireAuth, (req, res) => {
  const result = validateDeckDraft(req.body?.deck);
  if (!result.valid) return res.status(400).json({ error: result.reason });
  req.user.deck = [...req.body.deck];
  scheduleSave();
  res.json({ deck: [...req.user.deck] });
});

app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const rows = Object.values(database.users)
    .sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.username.localeCompare(b.username))
    .slice(0, limit)
    .map((user, index) => ({ position: index + 1, username: user.username, rating: user.rating, rank: getRank(user.rating), wins: user.wins, losses: user.losses }));
  res.json({ leaderboard: rows });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const friends = req.user.friends.map((id) => database.users[id]).filter(Boolean).map((user) => ({ id: user.id, username: user.username, code: user.code, online: clients.has(user.id) }));
  const pendingRequests = req.user.pendingRequests.map((id) => database.users[id]).filter(Boolean).map((user) => ({ id: user.id, username: user.username }));
  res.json({ friends, pendingRequests });
});

app.post('/api/friends/request', requireAuth, (req, res) => {
  const target = findUserByNameOrCode(req.body?.target);
  if (!target) return res.status(404).json({ error: 'Jugador no encontrado.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'No puedes añadirte a ti mismo.' });
  if (req.user.friends.includes(target.id)) return res.status(409).json({ error: 'Ya sois amigos.' });
  if (target.pendingRequests.includes(req.user.id)) return res.status(409).json({ error: 'Ya has enviado esa solicitud.' });
  if (!target.pendingRequests.includes(req.user.id)) target.pendingRequests.push(req.user.id);
  scheduleSave();
  const targetSocket = clients.get(target.id);
  if (targetSocket) send(targetSocket, { type: 'friends:update' });
  res.json({ ok: true, message: `Solicitud enviada a ${target.username}.` });
});

app.post('/api/friends/respond', requireAuth, (req, res) => {
  const target = database.users[String(req.body?.userId || '')];
  if (!target || !req.user.pendingRequests.includes(target.id)) return res.status(404).json({ error: 'Solicitud no encontrada.' });
  req.user.pendingRequests = req.user.pendingRequests.filter((id) => id !== target.id);
  if (req.body?.accept === true) {
    if (!req.user.friends.includes(target.id)) req.user.friends.push(target.id);
    if (!target.friends.includes(req.user.id)) target.friends.push(req.user.id);
  }
  scheduleSave();
  const targetSocket = clients.get(target.id);
  if (targetSocket) send(targetSocket, { type: 'friends:update' });
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Arcane Battles', cards: CARD_DATABASE.length }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta API no encontrada.' }));

// Serve the client and shared scripts from the same origin so HttpOnly session cookies work for WebSocket too.
app.use(express.static(PUBLIC_ROOT, { index: 'index.html', extensions: ['html'], etag: true, maxAge: IS_PRODUCTION ? '1h' : 0 }));
app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_ROOT, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function sendUser(userId, payload) { send(clients.get(userId), payload); }
function notifyFriendsPresence(user) {
  for (const friendId of user.friends || []) sendUser(friendId, { type: 'friends:update' });
}
function parseCookies(header = '') {
  const result = {};
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index > 0) {
      const key = pair.slice(0, index).trim();
      const rawValue = pair.slice(index + 1).trim();
      try { result[key] = decodeURIComponent(rawValue); } catch { result[key] = ''; }
    }
  }
  return result;
}
function publicRoomList() {
  return [...publicRooms.values()]
    .filter((room) => room.visibility === 'public')
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((room) => ({ id: room.id, code: room.code, name: room.name, host: room.hostName, rating: database.users[room.hostId]?.rating || 1000, createdAt: room.createdAt }));
}
function broadcastRooms() {
  const payload = { type: 'rooms:list', rooms: publicRoomList() };
  for (const ws of clients.values()) send(ws, payload);
}
function removeRoomForHost(userId) {
  for (const [roomId, room] of publicRooms) {
    if (room.hostId === userId) publicRooms.delete(roomId);
  }
  broadcastRooms();
}
function cleanUserQueue(userId) {
  rankedQueue.delete(userId);
}
function validDeckForUser(user) {
  const validation = validateDeck(user.deck);
  return validation.valid ? [...user.deck] : [...DEFAULT_DECK];
}
function getMatchSeat(matchInfo, userId) {
  if (matchInfo.engine.players.A.userId === userId) return 'A';
  if (matchInfo.engine.players.B.userId === userId) return 'B';
  return null;
}
function sendMatchState(matchInfo) {
  for (const seat of ['A', 'B']) {
    const userId = matchInfo.users[seat];
    const ws = clients.get(userId);
    send(ws, { type: 'match:state', state: getView(matchInfo.engine, seat) });
  }
}
function updateRating(winnerUser, loserUser) {
  const expectedWinner = 1 / (1 + (10 ** ((loserUser.rating - winnerUser.rating) / 400)));
  const expectedLoser = 1 - expectedWinner;
  const winnerDelta = Math.max(1, Math.round(32 * (1 - expectedWinner)));
  const loserDelta = Math.max(1, Math.round(32 * expectedLoser));
  winnerUser.rating = Math.min(3000, winnerUser.rating + winnerDelta);
  loserUser.rating = Math.max(0, loserUser.rating - loserDelta);
  winnerUser.wins += 1;
  loserUser.losses += 1;
  return { winnerDelta, loserDelta };
}
function finishMatch(matchInfo) {
  const engine = matchInfo.engine;
  if (engine.status !== 'ended' || matchInfo.resultRecorded) return;
  matchInfo.resultRecorded = true;
  let changes = { A: 0, B: 0 };
  if (engine.rated && engine.winner !== 'draw') {
    const winnerId = matchInfo.users[engine.winner];
    const loserSeat = engine.winner === 'A' ? 'B' : 'A';
    const loserId = matchInfo.users[loserSeat];
    const winner = database.users[winnerId];
    const loser = database.users[loserId];
    if (winner && loser) {
      const delta = updateRating(winner, loser);
      changes[engine.winner] = delta.winnerDelta;
      changes[loserSeat] = -delta.loserDelta;
      scheduleSave();
    }
  }
  for (const seat of ['A', 'B']) {
    const userId = matchInfo.users[seat];
    const winner = engine.winner === seat;
    sendUser(userId, {
      type: 'match:ended',
      winner,
      draw: engine.winner === 'draw',
      reason: engine.resultReason,
      ratingChange: changes[seat],
      profile: database.users[userId] ? safeProfile(database.users[userId]) : null
    });
    userMatch.delete(userId);
  }
  sendMatchState(matchInfo);
  if (matchInfo.cleanupTimer) clearTimeout(matchInfo.cleanupTimer);
  matchInfo.cleanupTimer = setTimeout(() => matches.delete(engine.id), MATCH_CLEANUP_MS);
  broadcastRooms();
}
function startMatch(userA, userB, mode, rated) {
  cleanUserQueue(userA.id);
  cleanUserQueue(userB.id);
  removeRoomForHost(userA.id);
  removeRoomForHost(userB.id);
  const engine = createMatch(
    { id: userA.id, username: userA.username, rating: userA.rating },
    { id: userB.id, username: userB.username, rating: userB.rating },
    validDeckForUser(userA),
    validDeckForUser(userB),
    { mode, rated }
  );
  const info = { engine, users: { A: engine.players.A.userId, B: engine.players.B.userId }, disconnectTimers: {}, cleanupTimer: null, resultRecorded: false };
  matches.set(engine.id, info);
  userMatch.set(info.users.A, engine.id);
  userMatch.set(info.users.B, engine.id);
  for (const seat of ['A', 'B']) sendUser(info.users[seat], { type: 'match:found', mode, rated, opponent: engine.players[seat === 'A' ? 'B' : 'A'].username });
  sendMatchState(info);
  return info;
}

function attemptRankedPairing() {
  const waiting = [...rankedQueue.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  if (waiting.length < 2) return;
  for (let i = 0; i < waiting.length; i += 1) {
    const a = waiting[i];
    if (!rankedQueue.has(a.userId)) continue;
    for (let j = i + 1; j < waiting.length; j += 1) {
      const b = waiting[j];
      if (!rankedQueue.has(b.userId)) continue;
      const waitSeconds = Math.min(120, (Date.now() - Math.min(a.queuedAt, b.queuedAt)) / 1000);
      const allowedDifference = Math.min(600, 100 + Math.floor(waitSeconds / 8) * 50);
      if (Math.abs(a.rating - b.rating) <= allowedDifference) {
        const userA = database.users[a.userId];
        const userB = database.users[b.userId];
        if (userA && userB) startMatch(userA, userB, 'ranked', true);
        return attemptRankedPairing();
      }
    }
  }
}

function createRoom(user, visibility, name) {
  removeRoomForHost(user.id);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  } while ([...publicRooms.values()].some((room) => room.code === code));
  const room = {
    id: crypto.randomUUID(), code,
    hostId: user.id,
    hostName: user.username,
    visibility: visibility === 'public' ? 'public' : 'private',
    name: String(name || `${user.username} — Sala`).trim().slice(0, 32) || 'Sala Arcana',
    createdAt: Date.now()
  };
  publicRooms.set(room.id, room);
  sendUser(user.id, { type: 'room:created', room: { id: room.id, code: room.code, visibility: room.visibility, name: room.name } });
  broadcastRooms();
}

function joinRoom(user, room) {
  if (!room) return sendUser(user.id, { type: 'error', error: 'La sala ya no existe.' });
  if (room.hostId === user.id) return sendUser(user.id, { type: 'error', error: 'No puedes unirte a tu propia sala.' });
  const host = database.users[room.hostId];
  if (!host || !clients.has(host.id)) {
    publicRooms.delete(room.id);
    broadcastRooms();
    return sendUser(user.id, { type: 'error', error: 'El anfitrión ya no está conectado.' });
  }
  const validationA = validateDeck(host.deck);
  const validationB = validateDeck(user.deck);
  if (!validationA.valid || !validationB.valid) return sendUser(user.id, { type: 'error', error: 'Uno de los dos jugadores tiene un mazo no válido.' });
  startMatch(host, user, room.visibility === 'public' ? 'public' : 'private', false);
}

function handleMessage(user, ws, message) {
  if (!message || typeof message.type !== 'string') return send(ws, { type: 'error', error: 'Mensaje no válido.' });
  if (message.type === 'rooms:list') {
    send(ws, { type: 'rooms:list', rooms: publicRoomList() });
  } else if (message.type === 'room:create') {
    if (userMatch.has(user.id) || rankedQueue.has(user.id)) return send(ws, { type: 'error', error: 'Sal de la cola o de la partida actual antes de crear una sala.' });
    if (!validateDeck(user.deck).valid) return send(ws, { type: 'error', error: 'Tu mazo debe tener 30 cartas válidas.' });
    createRoom(user, message.visibility, message.name);
  } else if (message.type === 'room:join') {
    if (userMatch.has(user.id) || rankedQueue.has(user.id)) return send(ws, { type: 'error', error: 'Ya estás en cola o en una partida.' });
    const code = String(message.code || '').trim().toUpperCase();
    const room = [...publicRooms.values()].find((item) => item.code === code);
    joinRoom(user, room);
  } else if (message.type === 'room:join-public') {
    if (userMatch.has(user.id) || rankedQueue.has(user.id)) return send(ws, { type: 'error', error: 'Ya estás en cola o en una partida.' });
    joinRoom(user, publicRooms.get(String(message.roomId || '')));
  } else if (message.type === 'room:leave') {
    removeRoomForHost(user.id);
    send(ws, { type: 'room:left' });
  } else if (message.type === 'queue:join') {
    if (userMatch.has(user.id)) return send(ws, { type: 'error', error: 'Ya estás en una partida.' });
    if (!validateDeck(user.deck).valid) return send(ws, { type: 'error', error: 'Necesitas un mazo válido de 30 cartas.' });
    removeRoomForHost(user.id);
    if (!rankedQueue.has(user.id)) rankedQueue.set(user.id, { userId: user.id, rating: user.rating, queuedAt: Date.now() });
    send(ws, { type: 'queue:status', status: 'searching', rating: user.rating });
    attemptRankedPairing();
  } else if (message.type === 'queue:leave') {
    cleanUserQueue(user.id);
    send(ws, { type: 'queue:status', status: 'cancelled' });
  } else if (message.type === 'match:action') {
    const matchId = userMatch.get(user.id);
    const info = matchId && matches.get(matchId);
    if (!info) return send(ws, { type: 'error', error: 'No tienes ninguna partida activa.' });
    const seat = getMatchSeat(info, user.id);
    if (!seat) return send(ws, { type: 'error', error: 'No se reconoce tu asiento en la partida.' });
    try {
      applyAction(info.engine, seat, message.action);
      if (info.engine.status === 'ended') finishMatch(info);
      else sendMatchState(info);
    } catch (error) {
      send(ws, { type: 'error', error: error.message || 'No se pudo realizar esa acción.' });
    }
  } else if (message.type === 'match:emote') {
    const matchId = userMatch.get(user.id);
    const info = matchId && matches.get(matchId);
    if (!info || !ALLOWED_EMOTES.has(message.emoji)) return;
    const opponentSeat = getMatchSeat(info, user.id) === 'A' ? 'B' : 'A';
    sendUser(info.users[opponentSeat], { type: 'match:emote', emoji: message.emoji });
  } else if (message.type === 'friend:invite') {
    const target = findUserByNameOrCode(message.target);
    if (!target || !user.friends.includes(target.id)) return send(ws, { type: 'error', error: 'Solo puedes invitar a alguien de tu lista de amigos.' });
    const room = [...publicRooms.values()].find((item) => item.hostId === user.id);
    if (!room) return send(ws, { type: 'error', error: 'Primero crea una sala privada.' });
    const targetSocket = clients.get(target.id);
    if (!targetSocket) return send(ws, { type: 'error', error: 'Tu amigo no está conectado ahora mismo.' });
    send(targetSocket, { type: 'friend:invite', from: user.username, code: room.code });
    send(ws, { type: 'friend:invite-sent', target: target.username });
  } else {
    send(ws, { type: 'error', error: 'Tipo de mensaje desconocido.' });
  }
}

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
  if (pathname !== '/') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
  let origin;
  try { origin = new URL(req.headers.origin || ''); } catch { socket.destroy(); return; }
  if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const cookies = parseCookies(req.headers.cookie || '');
  const session = sessions.get(cookies[SESSION_COOKIE]);
  if (!session || session.expiresAt <= Date.now() || !database.users[session.userId]) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  req.arcaneUserId = session.userId;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const userId = req.arcaneUserId;
  const user = database.users[userId];
  if (!user) { ws.close(1008, 'Sesión no válida'); return; }
  const previous = clients.get(userId);
  if (previous && previous !== ws) previous.close(4001, 'Nueva conexión iniciada');
  clients.set(userId, ws);
  notifyFriendsPresence(user);
  ws.isAlive = true;
  ws.messageTimes = [];
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'hello', profile: safeProfile(user) });
  send(ws, { type: 'rooms:list', rooms: publicRoomList() });

  const activeMatchId = userMatch.get(userId);
  const activeMatch = activeMatchId && matches.get(activeMatchId);
  if (activeMatch) {
    if (activeMatch.disconnectTimers[userId]) clearTimeout(activeMatch.disconnectTimers[userId]);
    delete activeMatch.disconnectTimers[userId];
    sendMatchState(activeMatch);
  }

  ws.on('message', (raw) => {
    const now = Date.now();
    ws.messageTimes = ws.messageTimes.filter((time) => now - time < 1000);
    if (ws.messageTimes.length >= 35) return send(ws, { type: 'error', error: 'Estás enviando demasiadas acciones.' });
    ws.messageTimes.push(now);
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', error: 'JSON no válido.' }); }
    handleMessage(user, ws, message);
  });

  ws.on('close', () => {
    // A replaced tab may close after the new socket has already registered.
    if (clients.get(userId) !== ws) return;
    clients.delete(userId);
    notifyFriendsPresence(user);
    cleanUserQueue(userId);
    removeRoomForHost(userId);
    const matchId = userMatch.get(userId);
    const info = matchId && matches.get(matchId);
    if (info && info.engine.status === 'playing') {
      const timer = setTimeout(() => {
        if (clients.has(userId) || info.engine.status !== 'playing') return;
        const seat = getMatchSeat(info, userId);
        if (seat) {
          try { applyAction(info.engine, seat, { type: 'concede' }); } catch { /* Match may already have ended. */ }
          finishMatch(info);
        }
      }, RECONNECT_GRACE_MS);
      info.disconnectTimers[userId] = timer;
    }
  });
  ws.on('error', (error) => console.warn('WebSocket error:', error.message));
});

const janitor = setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [roomId, room] of publicRooms) {
    if (now - room.createdAt > 15 * 60_000) {
      publicRooms.delete(roomId);
      sendUser(room.hostId, { type: 'room:expired' });
    }
  }
  broadcastRooms();
}, 60_000);
janitor.unref();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);
heartbeat.unref();

server.listen(PORT, HOST, () => {
  console.log(`Arcane Battles está disponible en http://localhost:${PORT}`);
  console.log(`Cartas cargadas: ${CARD_DATABASE.length}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(janitor);
  try { saveDatabase(); } catch (error) { console.error(error); }
  for (const ws of wss.clients) ws.close(1001, 'Servidor apagándose');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
