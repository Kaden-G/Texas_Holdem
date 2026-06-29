const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDVa8eOLH6CXTt1nbgH9v7mkAb-RtgcbXg",
  authDomain: "fracture-105c1.firebaseapp.com",
  databaseURL: "https://fracture-105c1-default-rtdb.firebaseio.com",
  projectId: "fracture-105c1",
  storageBucket: "fracture-105c1.firebasestorage.app",
  messagingSenderId: "926577785338",
  appId: "1:926577785338:web:8c5170c92ced85e7b9cc43",
};

let db = null;
let roomRef = null;
let clientId = null;
let onRemoteUpdate = null;

export function initFirebase() {
  if (db) return;
  if (!window.firebase) {
    console.error('Firebase SDK not loaded');
    return;
  }
  const app = firebase.app ? firebase.app() : firebase.initializeApp(FIREBASE_CONFIG);
  try { firebase.initializeApp(FIREBASE_CONFIG); } catch (e) {}
  db = firebase.database();
  clientId = sessionStorage.getItem('poker_cid');
  if (!clientId) {
    clientId = 'p_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('poker_cid', clientId);
  }
}

export function getClientId() { return clientId; }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export async function createRoom(playerName, avatar = null) {
  initFirebase();
  const code = genCode();
  roomRef = db.ref('poker_rooms/' + code);
  const room = {
    host: clientId,
    created: Date.now(),
    started: false,
    players: {
      [clientId]: { name: playerName, avatar, ready: false, seat: 0 }
    },
    state: null,
  };
  await roomRef.set(room);
  return code;
}

export async function joinRoom(code, playerName, avatar = null) {
  initFirebase();
  roomRef = db.ref('poker_rooms/' + code);
  const snap = await roomRef.once('value');
  if (!snap.exists()) throw new Error('Room not found');
  const room = snap.val();
  if (room.started) throw new Error('Game already started');
  const playerCount = room.players ? Object.keys(room.players).length : 0;
  if (playerCount >= 6) throw new Error('Room is full');
  await roomRef.child('players/' + clientId).set({
    name: playerName,
    avatar,
    ready: false,
    seat: playerCount,
  });
  return room;
}

export function listenRoom(callback) {
  if (!roomRef) return;
  onRemoteUpdate = callback;
  roomRef.on('value', snap => {
    if (!snap.exists()) return;
    callback(snap.val());
  });
}

export function stopListening() {
  if (roomRef) roomRef.off('value');
}

export async function setReady(ready) {
  if (!roomRef) return;
  await roomRef.child('players/' + clientId + '/ready').set(ready);
}

export async function pushGameState(state, seq) {
  if (!roomRef) return;
  await roomRef.update({ state: JSON.stringify(state), seq, lastUpdate: clientId });
}

export async function startOnlineGame() {
  if (!roomRef) return;
  await roomRef.child('started').set(true);
}

export async function pushAction(action) {
  if (!roomRef) return;
  await roomRef.child('pendingAction').set({
    ...action,
    from: clientId,
    ts: Date.now(),
  });
}

export async function clearAction() {
  if (!roomRef) return;
  await roomRef.child('pendingAction').remove();
}

export function isHost(room) {
  return room && room.host === clientId;
}

// ── Leaderboard (global, humans only, net profit) ──
function sanitizeKey(name) {
  // Firebase keys can't contain . # $ [ ] / — collapse the name to a safe key.
  return (name || 'stranger').toLowerCase().replace(/[.#$/\[\]]/g, '_').slice(0, 40) || 'stranger';
}

function todayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Record a human player's win, adding their net profit to today's board and
// the all-time board (atomic increments).
export async function submitScore(name, winnings) {
  initFirebase();
  if (!db || !(winnings > 0)) return;
  const key = sanitizeKey(name);
  const bump = ref => ref.transaction(cur => {
    cur = cur || { name, winnings: 0, wins: 0 };
    cur.name = name;
    cur.winnings = (cur.winnings || 0) + winnings;
    cur.wins = (cur.wins || 0) + 1;
    return cur;
  });
  try {
    await Promise.all([
      bump(db.ref(`leaderboard/daily/${todayKey()}/${key}`)),
      bump(db.ref(`leaderboard/lifetime/${key}`)),
    ]);
  } catch (e) {
    console.error('submitScore failed', e);
  }
}

// Top 10 for today and all-time, each sorted high→low by winnings.
export async function fetchLeaderboards() {
  initFirebase();
  if (!db) return { daily: [], lifetime: [] };
  const toArr = snap => {
    const arr = [];
    snap.forEach(c => { arr.push(c.val()); });
    return arr.sort((a, b) => (b.winnings || 0) - (a.winnings || 0));
  };
  try {
    const [d, l] = await Promise.all([
      db.ref(`leaderboard/daily/${todayKey()}`).orderByChild('winnings').limitToLast(10).once('value'),
      db.ref('leaderboard/lifetime').orderByChild('winnings').limitToLast(10).once('value'),
    ]);
    return { daily: toArr(d), lifetime: toArr(l) };
  } catch (e) {
    console.error('fetchLeaderboards failed', e);
    return { daily: [], lifetime: [] };
  }
}
