// Secure online Hold'em client. All game mutations go through Cloud
// Functions; the client only reads Firestore. Uses the modular v10 SDK
// via ESM CDN.

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore, doc, onSnapshot, connectFirestoreEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getFunctions, httpsCallable, connectFunctionsEmulator,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

// Reuse Dead Hand Saloon's Firebase project. In a real deploy you would
// point this at the poker-specific project.
const firebaseConfig = {
  apiKey: "AIzaSyBEffNIGoD-YWJjU43yQwx6aX_QrgA5LBI",
  authDomain: "dead-hand-saloon.firebaseapp.com",
  projectId: "dead-hand-saloon",
  storageBucket: "dead-hand-saloon.firebasestorage.app",
  messagingSenderId: "794338177634",
  appId: "1:794338177634:web:7b33ad15747e2626d6173b",
  measurementId: "G-ZXB1VJFHMD"
};

const useEmulator = new URLSearchParams(location.search).has('emu')
  || location.hostname === 'localhost'
  || location.hostname === '127.0.0.1';

const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);
export const dbFs = getFirestore(app);
export const fns = getFunctions(app, 'us-central1');

if (useEmulator) {
  try { connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); } catch (_) {}
  try { connectFirestoreEmulator(dbFs, '127.0.0.1', 8080); } catch (_) {}
  try { connectFunctionsEmulator(fns, '127.0.0.1', 5001); } catch (_) {}
}

let currentUid = null;
const authReady = new Promise(resolve => {
  onAuthStateChanged(auth, (user) => {
    if (user) { currentUid = user.uid; resolve(user.uid); }
    else signInAnonymously(auth).catch(err => console.error('anon sign-in failed', err));
  });
});

export function uid() { return currentUid; }
export function waitForAuth() { return authReady; }

// --- Callables ---
const _create = httpsCallable(fns, 'createGame');
const _join   = httpsCallable(fns, 'joinGame');
const _start  = httpsCallable(fns, 'startHand');
const _act    = httpsCallable(fns, 'playerAction');
const _leave  = httpsCallable(fns, 'leaveGame');

export async function createGame(displayName, settings) {
  await waitForAuth();
  const res = await _create({ displayName, settings });
  return res.data;   // { gameId }
}
export async function joinGame(gameId, displayName) {
  await waitForAuth();
  const res = await _join({ gameId, displayName });
  return res.data;   // { seat }
}
export async function startHand(gameId) {
  await waitForAuth();
  return (await _start({ gameId })).data;
}
export async function playerAction(gameId, action, amount) {
  await waitForAuth();
  return (await _act({ gameId, action, amount })).data;
}
export async function leaveGame(gameId) {
  await waitForAuth();
  return (await _leave({ gameId })).data;
}

// --- Listeners ---
export function watchGame(gameId, onData, onError) {
  return onSnapshot(doc(dbFs, 'games', gameId), (s) => {
    if (s.exists()) onData(s.data());
  }, onError || (e => console.error('game snapshot error', e)));
}

export function watchMyPrivate(gameId, onData, onError) {
  if (!currentUid) throw new Error('not signed in');
  return onSnapshot(doc(dbFs, 'games', gameId, 'private', currentUid), (s) => {
    if (s.exists()) onData(s.data());
    else onData(null);
  }, onError || (e => console.error('private snapshot error', e)));
}
