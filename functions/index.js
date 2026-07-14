'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 20 });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const { freshShuffledDeck } = require('./src/deck');
const {
  DEFAULT_SETTINGS, newSeat, newAiSeat, pickOpenSeat, nextDealerSeat, blindSeats,
  firstToActPreflop, firstToActPostflop, roundIsComplete, foldAround,
} = require('./src/game');

// 4-letter room code alphabet: unambiguous (no 0/O, 1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return s;
}
function codeRef(code) { return db.doc(`codes/${code}`); }
function aiHandRef(gameId, seatIdx) { return db.doc(`games/${gameId}/aiHands/${seatIdx}`); }
const {
  ActionError, validateAndApply, advanceActionSeat, beginStreet,
} = require('./src/actions');
const {
  seatIndices, occupiedSeats, livingSeats, inHandSeats,
  nextSeatWithStatus, findSeatByUid, firstSeatWithStatusFrom,
} = require('./src/seats');
const { resolveShowdown, resolveFoldAround } = require('./src/showdown');

// ---------- helpers ----------

function requireAuth(req) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  return uid;
}

function gameRef(gameId) { return db.doc(`games/${gameId}`); }
function privateRef(gameId, uid) { return db.doc(`games/${gameId}/private/${uid}`); }
function deckRef(gameId) { return db.doc(`games/${gameId}/server/deck`); }

function sanitizeSettings(overrides) {
  const s = { ...DEFAULT_SETTINGS, ...(overrides || {}) };
  s.smallBlind = Math.max(1, Math.min(1000, s.smallBlind | 0));
  s.bigBlind = Math.max(s.smallBlind + 1, Math.min(2000, s.bigBlind | 0));
  s.startingStack = Math.max(s.bigBlind * 10, Math.min(1_000_000, s.startingStack | 0));
  s.maxPlayers = Math.max(2, Math.min(6, s.maxPlayers | 0));
  return s;
}

// After validateAndApply, advance the game state: next actor, next
// street, showdown, or fold-around. Mutates `game` in place; returns
// { needsShowdown, needsFoldAround, deckMutations }.
function progressAfterAction(game) {
  // Fold-around ends the hand immediately.
  if (foldAround(game.seats)) {
    return { needsFoldAround: true };
  }
  if (!roundIsComplete(game.seats, game.currentBet)) {
    advanceActionSeat(game);
    return {};
  }
  // Round is done. Collect committedThisStreet into pot (informational —
  // pots are recomputed at showdown from committedThisHand).
  for (const k of seatIndices(game.seats)) {
    const s = game.seats[k];
    game.pot = (game.pot || 0) + s.committedThisStreet;
  }
  return { streetComplete: true };
}

// Advance to the next street or showdown. Deals from the passed deck
// object (mutates `deck.cards`), sets game.communityCards.
function advanceStreet(game, deck) {
  const stillActionable = inHandSeats(game.seats).filter(s => s.status === 'active');
  const inHandCount = inHandSeats(game.seats).length;

  // If only one 'active' player and everyone else is all-in, still deal
  // out remaining community cards and go to showdown.
  const skipBetting = stillActionable.length <= 1 && inHandCount >= 2;

  const dealBurnFlop = () => {
    deck.burned.push(deck.cards.shift());
    game.communityCards.push(deck.cards.shift(), deck.cards.shift(), deck.cards.shift());
  };
  const dealBurnOne = () => {
    deck.burned.push(deck.cards.shift());
    game.communityCards.push(deck.cards.shift());
  };

  const next = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[game.phase];
  if (!next) throw new Error(`Cannot advance from phase ${game.phase}`);

  if (next === 'flop') dealBurnFlop();
  else if (next === 'turn' || next === 'river') dealBurnOne();

  if (next === 'showdown') {
    game.phase = 'showdown';
    return { showdownReady: true, skipBetting };
  }

  // Postflop: first-to-act is first active seat left of dealer (or BB if heads-up)
  const first = firstToActPostflop(game.seats, game.dealerSeat, game.settings.maxPlayers);
  beginStreet(game, next, first);

  if (skipBetting) {
    // Everyone all-in; recurse straight to next street.
    return advanceStreet(game, deck);
  }
  return {};
}

// ---------- createGame ----------

exports.createGame = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const settings = sanitizeSettings(req.data && req.data.settings);
  const displayName = (req.data && req.data.displayName) || 'host';
  const avatarId = (req.data && req.data.avatarId) || null;
  const deckId = (req.data && req.data.deckId) || null;

  const gameId = db.collection('games').doc().id;
  const now = FieldValue.serverTimestamp();

  const seats = { 0: newSeat(uid, displayName, 0, settings, { avatarId }) };

  // Reserve a unique 4-letter room code. Retry on collision.
  let code = null;
  for (let attempt = 0; attempt < 12 && !code; attempt++) {
    const candidate = randomCode();
    const reserved = await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef(candidate));
      if (snap.exists) return false;
      tx.set(codeRef(candidate), { gameId, createdAt: now });
      return true;
    });
    if (reserved) code = candidate;
  }
  if (!code) throw new HttpsError('resource-exhausted', 'Could not allocate a room code, try again');

  await gameRef(gameId).set({
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
    hostUid: uid,
    settings,
    code,
    deckId,
    handNumber: 0,
    phase: 'between_hands',
    communityCards: [],
    pot: 0,
    sidePots: [],
    currentBet: 0,
    minRaise: settings.bigBlind,
    dealerSeat: 0,
    actionSeat: -1,
    actionDeadline: null,
    lastAction: null,
    seats,
    showdown: null,
  });
  return { gameId, code };
});

// ---------- joinByCode ----------

exports.joinByCode = onCall({ enforceAppCheck: false }, async (req) => {
  requireAuth(req);
  const code = String((req.data && req.data.code) || '').toUpperCase().trim();
  if (code.length !== 4) throw new HttpsError('invalid-argument', 'Enter a 4-letter code');
  const snap = await codeRef(code).get();
  if (!snap.exists) throw new HttpsError('not-found', 'No game with that code');
  return { gameId: snap.data().gameId };
});

// ---------- addAiSeat ----------

exports.addAiSeat = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const gameId = req.data && req.data.gameId;
  const displayName = (req.data && req.data.displayName) || 'Bot';
  const avatarId = (req.data && req.data.avatarId) || null;
  const personalityId = (req.data && req.data.personalityId) || null;
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId required');

  const seatAssigned = await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    if (!snap.exists) throw new HttpsError('not-found', 'Game not found');
    const g = snap.data();
    if (g.hostUid !== uid) throw new HttpsError('permission-denied', 'Only host may add AI seats');
    if (!['waiting', 'between_hands'].includes(g.phase) && g.status !== 'waiting') {
      throw new HttpsError('failed-precondition', 'Cannot add AI mid-hand');
    }
    const seatIdx = pickOpenSeat(g.seats || {}, g.settings.maxPlayers);
    if (seatIdx === -1) throw new HttpsError('failed-precondition', 'Table full');
    const seat = newAiSeat(seatIdx, g.settings, { displayName, avatarId, personalityId });
    tx.update(gameRef(gameId), {
      [`seats.${seatIdx}`]: seat,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return seatIdx;
  });
  return { seat: seatAssigned };
});

// ---------- joinGame ----------

exports.joinGame = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const gameId = req.data && req.data.gameId;
  const displayName = (req.data && req.data.displayName) || 'stranger';
  const avatarId = (req.data && req.data.avatarId) || null;
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId required');

  const seatAssigned = await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    if (!snap.exists) throw new HttpsError('not-found', 'Game not found');
    const g = snap.data();
    if (g.status === 'finished') throw new HttpsError('failed-precondition', 'Game finished');
    // Already seated?
    for (const k of Object.keys(g.seats || {})) {
      if (g.seats[k].uid === uid) return parseInt(k, 10);
    }
    const seatIdx = pickOpenSeat(g.seats || {}, g.settings.maxPlayers);
    if (seatIdx === -1) throw new HttpsError('failed-precondition', 'Table full');
    const seat = newSeat(uid, displayName, seatIdx, g.settings, { avatarId });
    tx.update(gameRef(gameId), {
      [`seats.${seatIdx}`]: seat,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return seatIdx;
  });
  return { seat: seatAssigned };
});

// ---------- startHand ----------

exports.startHand = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const gameId = req.data && req.data.gameId;
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId required');

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    if (!snap.exists) throw new HttpsError('not-found', 'Game not found');
    const g = snap.data();
    if (g.hostUid !== uid) throw new HttpsError('permission-denied', 'Only host may start hands');
    // 'showdown' means the previous hand's reveal is up — that's also a
    // valid start-the-next-hand state.
    if (!['waiting', 'between_hands', 'showdown'].includes(g.phase) && g.status !== 'waiting') {
      throw new HttpsError('failed-precondition', 'A hand is already in progress');
    }
    const maxSeats = g.settings.maxPlayers;

    // Mark seats: bring living players in, exclude busted / opted-out.
    // Players with `sittingOutForNextHand` (set by leaveGame during a
    // live hand) transition to sitting_out and are skipped this hand.
    for (const k of Object.keys(g.seats || {})) {
      const s = g.seats[k];
      s.committedThisStreet = 0;
      s.committedThisHand = 0;
      s.hasActedThisStreet = false;
      if (s.stack <= 0) { s.status = 'busted'; continue; }
      if (s.sittingOutForNextHand) {
        s.status = 'sitting_out';
        s.sittingOutForNextHand = false;
        continue;
      }
      // Everyone else — including seats that just joined and are marked
      // sitting_out by default — comes into the hand active.
      if (s.status !== 'busted') s.status = 'active';
    }
    const eligible = livingSeats(g.seats).filter(s => g.seats[s.seat].stack > 0);
    if (eligible.length < 2) throw new HttpsError('failed-precondition', 'Need ≥2 living players');

    // Advance dealer to next living seat (first hand: seat 0 or hostSeat).
    let dealerSeat = g.dealerSeat;
    if (g.handNumber > 0) dealerSeat = nextDealerSeat(g.seats, dealerSeat, maxSeats);
    // Ensure dealer is on an active seat; walk if not.
    if (!g.seats[dealerSeat] || g.seats[dealerSeat].status !== 'active') {
      dealerSeat = firstSeatWithStatusFrom(g.seats, dealerSeat, ['active'], maxSeats);
    }

    const blinds = blindSeats(g.seats, dealerSeat, maxSeats);
    if (!blinds) throw new HttpsError('failed-precondition', 'Cannot assign blinds');

    // Post blinds (capped at stack).
    const sbAmount = Math.min(g.settings.smallBlind, g.seats[blinds.sb].stack);
    const bbAmount = Math.min(g.settings.bigBlind, g.seats[blinds.bb].stack);
    g.seats[blinds.sb].stack -= sbAmount;
    g.seats[blinds.sb].committedThisStreet = sbAmount;
    g.seats[blinds.sb].committedThisHand = sbAmount;
    if (g.seats[blinds.sb].stack === 0) g.seats[blinds.sb].status = 'all_in';
    g.seats[blinds.bb].stack -= bbAmount;
    g.seats[blinds.bb].committedThisStreet = bbAmount;
    g.seats[blinds.bb].committedThisHand = bbAmount;
    if (g.seats[blinds.bb].stack === 0) g.seats[blinds.bb].status = 'all_in';

    // Shuffle deck and deal 2 hole cards to each in-hand player.
    const deck = { cards: freshShuffledDeck(), burned: [] };
    const inHand = inHandSeats(g.seats);
    const holeMap = {};
    // Standard deal order: 1 card to each starting SB, then round 2.
    for (let round = 0; round < 2; round++) {
      let cursor = blinds.sb;
      for (let n = 0; n < inHand.length; n++) {
        const seatObj = g.seats[cursor];
        const card = deck.cards.shift();
        holeMap[seatObj.uid] = holeMap[seatObj.uid] || [];
        holeMap[seatObj.uid].push(card);
        cursor = nextSeatWithStatus(g.seats, cursor, ['active', 'all_in'], maxSeats);
        if (cursor === -1) break;
      }
    }

    // Preflop first-to-act.
    const firstAct = firstToActPreflop(g.seats, blinds, maxSeats);

    const handNumber = (g.handNumber || 0) + 1;
    const currentBet = bbAmount;
    const minRaise = g.settings.bigBlind;

    tx.set(deckRef(gameId), {
      cards: deck.cards, burned: deck.burned, handNumber,
    });
    // Write hole cards: humans to /private/{uid} (owner-readable),
    // AI seats to /aiHands/{seatIdx} (host-readable via firestore.rules).
    for (const seatObj of inHand) {
      const cards = holeMap[seatObj.uid];
      if (!cards) continue;
      if (seatObj.isAI) {
        tx.set(aiHandRef(gameId, seatObj.seat), { holeCards: cards, handNumber });
      } else {
        tx.set(privateRef(gameId, seatObj.uid), { holeCards: cards, handNumber });
      }
    }
    tx.update(gameRef(gameId), {
      status: 'playing',
      phase: 'preflop',
      handNumber,
      dealerSeat,
      actionSeat: firstAct,
      currentBet,
      minRaise,
      pot: 0,
      sidePots: [],
      communityCards: [],
      showdown: null,
      lastAction: { uid: 'system', type: 'deal', amount: 0 },
      seats: g.seats,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { handNumber };
  });
  return result;
});

// ---------- playerAction ----------

exports.playerAction = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const gameId = req.data && req.data.gameId;
  const action = req.data && req.data.action;
  const amount = req.data && req.data.amount;
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId required');

  await db.runTransaction(async (tx) => {
    // Firestore transactions require ALL reads before ANY writes. Pull
    // game + deck + every seated player's hole-card doc upfront;
    // we may not use them all, but we cannot go back and read after a
    // write.
    const gSnap = await tx.get(gameRef(gameId));
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found');
    const g = gSnap.data();

    const seatedSeats = Object.values(g.seats || {});
    const humanSeats = seatedSeats.filter(s => !s.isAI);
    const aiSeats = seatedSeats.filter(s => s.isAI);
    const [deckSnap, ...allSnaps] = await Promise.all([
      tx.get(deckRef(gameId)),
      ...humanSeats.map(s => tx.get(privateRef(gameId, s.uid))),
      ...aiSeats.map(s => tx.get(aiHandRef(gameId, s.seat))),
    ]);
    const handMap = {};
    humanSeats.forEach((s, i) => {
      const snap = allSnaps[i];
      if (snap.exists) handMap[s.uid] = snap.data().holeCards;
    });
    aiSeats.forEach((s, i) => {
      const snap = allSnaps[humanSeats.length + i];
      if (snap.exists) handMap[s.uid] = snap.data().holeCards;
    });
    const deck = deckSnap.exists
      ? {
          cards: (deckSnap.data().cards || []).slice(),
          burned: (deckSnap.data().burned || []).slice(),
        }
      : null;

    // Host may act for AI seats. For all other seats the actor must be
    // the seat's own uid.
    let actorUid = uid;
    const actionSeat = g.seats && g.seats[g.actionSeat];
    if (actionSeat && actionSeat.isAI) {
      if (uid !== g.hostUid) {
        throw new HttpsError('permission-denied', 'Only host may act for AI seats');
      }
      actorUid = actionSeat.uid;
    }

    try {
      validateAndApply(g, actorUid, action, amount);
    } catch (e) {
      if (e instanceof ActionError) throw new HttpsError(e.code, e.message);
      throw e;
    }

    const progress = progressAfterAction(g);

    if (progress.needsFoldAround) {
      const { updatedSeats, winners } = resolveFoldAround(g);
      g.seats = updatedSeats;
      applyEndOfHand(g, { winners, revealed: {} });
      tx.update(gameRef(gameId), gameUpdatePayload(g));
      return;
    }

    if (progress.streetComplete) {
      if (!deck) throw new HttpsError('failed-precondition', 'No deck for this hand');
      let showdownReady = false;
      while (!showdownReady && g.phase !== 'showdown') {
        const res = advanceStreet(g, deck);
        showdownReady = !!res.showdownReady;
        if (!res.showdownReady && !res.skipBetting) break;
      }
      tx.update(deckRef(gameId), { cards: deck.cards, burned: deck.burned });

      if (showdownReady) {
        const contenders = inHandSeats(g.seats);
        const showdownHands = {};
        for (const s of contenders) {
          if (handMap[s.uid]) showdownHands[s.uid] = handMap[s.uid];
        }
        const { updatedSeats, winners, revealed } = resolveShowdown(g, showdownHands);
        g.seats = updatedSeats;
        applyEndOfHand(g, { winners, revealed });
        tx.update(gameRef(gameId), gameUpdatePayload(g));
        return;
      }
    }

    tx.update(gameRef(gameId), gameUpdatePayload(g));
  });
  return { ok: true };
});

// After showdown or fold-around: bust zero-stack players, reset
// pot/street state, park phase at 'between_hands'.
function applyEndOfHand(g, { winners, revealed }) {
  g.showdown = { revealed, winners };
  g.phase = 'showdown';
  // Bust players.
  for (const k of Object.keys(g.seats || {})) {
    const s = g.seats[k];
    if (s.stack <= 0 && s.status !== 'busted') s.status = 'busted';
    // Reset per-hand counters for next hand.
    s.committedThisStreet = 0;
    s.committedThisHand = 0;
    s.hasActedThisStreet = false;
  }
  g.pot = 0;
  g.currentBet = 0;
  g.actionSeat = -1;
  // If the current host busted, hand the "Next Hand" control to another
  // human still in the game. Never to an AI — bots can't click. Walk
  // clockwise from the busted host so the transfer is deterministic.
  reassignHostIfNeeded(g);
  // Host must call startHand to move to next; we leave phase='showdown'
  // and expose the reveal.
  const alive = livingSeats(g.seats).filter(s => g.seats[s.seat].stack > 0);
  if (alive.length < 2) {
    g.status = 'finished';
  }
}

// Transfer host to the next non-AI seat with chips, clockwise from the
// current host's seat. No-op if the current host is still solvent, or
// if no other human is eligible (leaves hostUid alone — game likely ends
// anyway when <2 alive).
function reassignHostIfNeeded(g) {
  if (!g.hostUid || !g.seats) return;
  const seatEntries = Object.keys(g.seats).map(k => ({ idx: parseInt(k, 10), s: g.seats[k] }));
  const host = seatEntries.find(e => e.s.uid === g.hostUid);
  if (!host) return;
  if (host.s.stack > 0 && host.s.status !== 'busted') return;   // still fine
  const maxSeats = g.settings.maxPlayers;
  for (let step = 1; step <= maxSeats; step++) {
    const idx = (host.idx + step) % maxSeats;
    const s = g.seats[idx];
    if (!s) continue;
    if (s.isAI) continue;
    if ((s.stack | 0) <= 0) continue;
    if (s.status === 'busted') continue;
    g.hostUid = s.uid;
    return;
  }
  // No eligible human — leave hostUid alone; game will finish anyway.
}

function gameUpdatePayload(g) {
  const payload = {
    status: g.status,
    phase: g.phase,
    seats: g.seats,
    communityCards: g.communityCards,
    pot: g.pot,
    sidePots: g.sidePots || [],
    currentBet: g.currentBet,
    minRaise: g.minRaise,
    dealerSeat: g.dealerSeat,
    actionSeat: g.actionSeat,
    lastAction: g.lastAction || null,
    showdown: g.showdown || null,
    hostUid: g.hostUid,
    updatedAt: FieldValue.serverTimestamp(),
  };
  return payload;
}

// ---------- leaveGame ----------

exports.leaveGame = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const gameId = req.data && req.data.gameId;
  if (!gameId) throw new HttpsError('invalid-argument', 'gameId required');

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef(gameId));
    if (!snap.exists) return;
    const g = snap.data();
    const seatIdx = findSeatByUid(g.seats, uid);
    if (seatIdx === -1) return;

    if (g.status === 'playing' && ['preflop', 'flop', 'turn', 'river'].includes(g.phase)) {
      // Mid-hand: fold them so pot logic still credits their forfeit,
      // then flag them to sit out starting next hand.
      if (g.seats[seatIdx].status === 'active') {
        g.seats[seatIdx].status = 'folded';
        g.seats[seatIdx].hasActedThisStreet = true;
        if (g.actionSeat === seatIdx) {
          const next = nextSeatWithStatus(g.seats, seatIdx, ['active'], g.settings.maxPlayers);
          g.actionSeat = next === -1 ? -1 : next;
        }
      }
      g.seats[seatIdx].sittingOutForNextHand = true;
      tx.update(gameRef(gameId), {
        seats: g.seats,
        actionSeat: g.actionSeat,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // Not in a hand — vacate the seat entirely.
      tx.update(gameRef(gameId), {
        [`seats.${seatIdx}`]: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
  return { ok: true };
});

// ---------- submitWin — Top Guns global leaderboard ----------
//
// Called by any authenticated client when they've won a game (single
// player against AI, or online multiplayer). Accumulates the player's
// net-profit winnings into two collections:
//   /leaderboard/lifetime/entries/{key}
//   /leaderboard/daily/{yyyy-mm-dd}/entries/{key}
// Uses FieldValue.increment so concurrent writes from different clients
// don't lose updates. Rules deny direct client writes to /leaderboard/**
// — this callable is the only write path.
exports.submitWin = onCall({ enforceAppCheck: false }, async (req) => {
  requireAuth(req);
  const rawName = String((req.data && req.data.name) || 'stranger').trim();
  const name = rawName.slice(0, 40) || 'stranger';
  const winnings = Math.max(0, Math.min(10_000_000, (req.data && req.data.winnings) | 0));
  if (winnings <= 0) return { ok: true, recorded: false };
  const key = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 40) || 'stranger';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const today = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  const now = FieldValue.serverTimestamp();
  const payload = {
    name,
    winnings: FieldValue.increment(winnings),
    wins: FieldValue.increment(1),
    updatedAt: now,
  };
  await Promise.all([
    db.doc(`leaderboard/lifetime/entries/${key}`).set(payload, { merge: true }),
    db.doc(`leaderboard/daily/${today}/entries/${key}`).set(payload, { merge: true }),
  ]);
  return { ok: true, recorded: true };
});
