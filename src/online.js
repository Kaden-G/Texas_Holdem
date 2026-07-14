import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore, doc, collection, onSnapshot, query, orderBy, limit, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: "AIzaSyBEffNIGoD-YWJjU43yQwx6aX_QrgA5LBI",
  authDomain: "dead-hand-saloon.firebaseapp.com",
  projectId: "dead-hand-saloon",
  storageBucket: "dead-hand-saloon.firebasestorage.app",
  messagingSenderId: "794338177634",
  appId: "1:794338177634:web:7b33ad15747e2626d6173b",
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, 'us-central1');

let currentUid = null;
const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) { currentUid = user.uid; resolve(user.uid); }
    else signInAnonymously(auth).catch(err => console.error('anon sign-in failed', err));
  });
});

export function myUid() { return currentUid; }
export function waitForAuth() { return authReady; }

const call = name => httpsCallable(fns, name);
const _createGame = call('createGame');
const _joinByCode = call('joinByCode');
const _joinGame   = call('joinGame');
const _addAiSeat  = call('addAiSeat');
const _startHand  = call('startHand');
const _playerAct  = call('playerAction');
const _leaveGame  = call('leaveGame');
const _submitWin  = call('submitWin');

export async function createGame({ displayName, avatarId, deckId }) {
  await waitForAuth();
  const res = await _createGame({ displayName, avatarId, deckId, settings: {} });
  return res.data;   // { gameId, code }
}
export async function joinByCode(code) {
  await waitForAuth();
  const res = await _joinByCode({ code });
  return res.data;   // { gameId }
}
export async function joinGame(gameId, { displayName, avatarId }) {
  await waitForAuth();
  const res = await _joinGame({ gameId, displayName, avatarId });
  return res.data;   // { seat }
}
export async function addAiSeat(gameId, { displayName, avatarId, personalityId }) {
  await waitForAuth();
  const res = await _addAiSeat({ gameId, displayName, avatarId, personalityId });
  return res.data;   // { seat }
}
export async function startHand(gameId) {
  await waitForAuth();
  return (await _startHand({ gameId })).data;
}
export async function playerAction(gameId, action, amount) {
  await waitForAuth();
  return (await _playerAct({ gameId, action, amount })).data;
}
export async function leaveGame(gameId) {
  await waitForAuth();
  return (await _leaveGame({ gameId })).data;
}

// Top Guns global leaderboard: submit a win for the current player.
// Called after a game (single-player or online) is won by a human.
export async function submitWin(name, winnings) {
  await waitForAuth();
  return (await _submitWin({ name, winnings })).data;
}

// Fetch the current global boards. Returns { daily, lifetime } arrays
// sorted high→low by winnings, top 10 each. Throws on network / rule
// error; callers should catch and fall back to local storage.
export async function fetchLeaderboards() {
  await waitForAuth();
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const toArr = (snap) => snap.docs.map(x => x.data());
  const [dailySnap, lifetimeSnap] = await Promise.all([
    getDocs(query(collection(db, `leaderboard/daily/${today}/entries`), orderBy('winnings', 'desc'), limit(10))),
    getDocs(query(collection(db, `leaderboard/lifetime/entries`), orderBy('winnings', 'desc'), limit(10))),
  ]);
  return { daily: toArr(dailySnap), lifetime: toArr(lifetimeSnap) };
}

// --- Subscriptions ---

// Live game document.
export function subscribeGame(gameId, cb) {
  return onSnapshot(doc(db, 'games', gameId), snap => cb(snap.exists() ? snap.data() : null));
}

// My own hole cards for the current hand.
export function subscribeMyHand(gameId, uid, cb) {
  return onSnapshot(doc(db, 'games', gameId, 'private', uid),
    snap => cb(snap.exists() ? snap.data() : null));
}

// AI hole cards (host only, read authorized by firestore.rules).
export function subscribeAiHands(gameId, cb) {
  return onSnapshot(collection(db, 'games', gameId, 'aiHands'), snap => {
    const bySeat = {};
    snap.forEach(d => { bySeat[parseInt(d.id, 10)] = d.data(); });
    cb(bySeat);
  });
}
