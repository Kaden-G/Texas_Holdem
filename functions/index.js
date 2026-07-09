'use strict';

const admin = require('firebase-admin');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1', maxInstances: 20 });

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const { freshShuffledDeck } = require('./src/deck');
const {
  DEFAULT_SETTINGS, newSeat, pickOpenSeat, nextDealerSeat, blindSeats,
  firstToActPreflop, firstToActPostflop, roundIsComplete, foldAround,
} = require('./src/game');
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

  const gameId = db.collection('games').doc().id;
  const now = FieldValue.serverTimestamp();

  const seats = { 0: newSeat(uid, displayName, 0, settings) };
  await gameRef(gameId).set({
    status: 'waiting',
    createdAt: now,
    updatedAt: now,
    hostUid: uid,
    settings,
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
  return { gameId };
});

// ---------- joinGame ----------

exports.joinGame = onCall({ enforceAppCheck: false }, async (req) => {
  const uid = requireAuth(req);
  const gameId = req.data && req.data.gameId;
  const displayName = (req.data && req.data.displayName) || 'stranger';
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
    const seat = newSeat(uid, displayName, seatIdx, g.settings);
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
    if (!['waiting', 'between_hands'].includes(g.phase) && g.status !== 'waiting') {
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
      if (s.status !== 'sitting_out') s.status = 'active';
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
    for (const uid2 of Object.keys(holeMap)) {
      tx.set(privateRef(gameId, uid2), {
        holeCards: holeMap[uid2],
        handNumber,
      });
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
    // game + deck + every seated player's private hole-card doc upfront;
    // we may not use them all, but we cannot go back and read after a
    // write.
    const gSnap = await tx.get(gameRef(gameId));
    if (!gSnap.exists) throw new HttpsError('not-found', 'Game not found');
    const g = gSnap.data();

    const seatedUids = Object.values(g.seats || {}).map(s => s.uid);
    const [deckSnap, ...privSnaps] = await Promise.all([
      tx.get(deckRef(gameId)),
      ...seatedUids.map(u => tx.get(privateRef(gameId, u))),
    ]);
    const handMap = {};
    privSnaps.forEach((p, i) => {
      if (p.exists) handMap[seatedUids[i]] = p.data().holeCards;
    });
    const deck = deckSnap.exists
      ? {
          cards: (deckSnap.data().cards || []).slice(),
          burned: (deckSnap.data().burned || []).slice(),
        }
      : null;

    try {
      validateAndApply(g, uid, action, amount);
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
  // Host must call startHand to move to next; we leave phase='showdown'
  // and expose the reveal.
  const alive = livingSeats(g.seats).filter(s => g.seats[s.seat].stack > 0);
  if (alive.length < 2) {
    g.status = 'finished';
  }
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
