'use strict';

// End-to-end play-a-hand test that exercises the pure game logic
// (no Firestore) by simulating what the Cloud Function would do in a
// transaction. This proves the state machine is coherent — preflop
// betting → flop → turn → river → showdown — with no Firebase running.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS, newSeat, blindSeats, firstToActPreflop,
  firstToActPostflop, roundIsComplete, foldAround,
} = require('../src/game');
const {
  validateAndApply, advanceActionSeat, beginStreet,
} = require('../src/actions');
const { resolveShowdown, resolveFoldAround } = require('../src/showdown');
const { freshShuffledDeck } = require('../src/deck');
const {
  seatIndices, nextSeatWithStatus, inHandSeats,
} = require('../src/seats');

function buildTable(uids) {
  const settings = { ...DEFAULT_SETTINGS };
  const seats = {};
  uids.forEach((u, i) => {
    seats[i] = newSeat(u, u, i, settings);
    seats[i].status = 'active';
  });
  return {
    status: 'playing',
    phase: 'preflop',
    settings,
    handNumber: 1,
    seats,
    pot: 0,
    sidePots: [],
    currentBet: 0,
    minRaise: settings.bigBlind,
    dealerSeat: 0,
    actionSeat: -1,
    communityCards: [],
    lastAction: null,
    showdown: null,
  };
}

// Deal blinds and hole cards to prepare the table.
function dealHand(g, holeOverride) {
  const b = blindSeats(g.seats, g.dealerSeat, g.settings.maxPlayers);
  g.seats[b.sb].stack -= g.settings.smallBlind;
  g.seats[b.sb].committedThisStreet = g.settings.smallBlind;
  g.seats[b.sb].committedThisHand = g.settings.smallBlind;
  g.seats[b.bb].stack -= g.settings.bigBlind;
  g.seats[b.bb].committedThisStreet = g.settings.bigBlind;
  g.seats[b.bb].committedThisHand = g.settings.bigBlind;
  g.currentBet = g.settings.bigBlind;
  g.minRaise = g.settings.bigBlind;
  g.actionSeat = firstToActPreflop(g.seats, b, g.settings.maxPlayers);
  const deck = { cards: freshShuffledDeck(), burned: [] };
  const hole = holeOverride || {};
  if (!holeOverride) {
    // Standard deal from SB.
    let cursor = b.sb;
    const inHand = inHandSeats(g.seats);
    for (let r = 0; r < 2; r++) {
      for (let n = 0; n < inHand.length; n++) {
        const s = g.seats[cursor];
        hole[s.uid] = hole[s.uid] || [];
        hole[s.uid].push(deck.cards.shift());
        cursor = nextSeatWithStatus(g.seats, cursor, ['active', 'all_in'], g.settings.maxPlayers);
      }
    }
  }
  return { deck, hole, blinds: b };
}

function progressAfterAction(g) {
  if (foldAround(g.seats)) return { needsFoldAround: true };
  if (!roundIsComplete(g.seats, g.currentBet)) {
    advanceActionSeat(g);
    return {};
  }
  for (const k of seatIndices(g.seats)) g.pot += g.seats[k].committedThisStreet;
  return { streetComplete: true };
}

function advanceStreet(g, deck) {
  const next = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[g.phase];
  if (next === 'flop') { deck.burned.push(deck.cards.shift()); g.communityCards.push(deck.cards.shift(), deck.cards.shift(), deck.cards.shift()); }
  else if (next === 'turn' || next === 'river') { deck.burned.push(deck.cards.shift()); g.communityCards.push(deck.cards.shift()); }
  if (next === 'showdown') { g.phase = 'showdown'; return true; }
  const first = firstToActPostflop(g.seats, g.dealerSeat, g.settings.maxPlayers);
  beginStreet(g, next, first);
  return false;
}

test('fold-around: everyone folds to one player, pot awarded without reveal', () => {
  const g = buildTable(['A', 'B', 'C']);
  dealHand(g);
  // Dealer (seat 0) acts first preflop. Fold A, fold B — C wins BB blinds.
  validateAndApply(g, 'A', 'fold');   assert.equal(progressAfterAction(g).needsFoldAround, undefined);
  validateAndApply(g, 'B', 'fold');   assert.equal(progressAfterAction(g).needsFoldAround, true);
  const { winners, revealed } = resolveFoldAround(g);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].uid, 'C');
  assert.equal(Object.keys(revealed).length, 0, 'fold-around must not reveal cards');
  // C collected SB(10) + BB(20) = 30.
  assert.equal(winners[0].amount, 30);
});

test('full hand: heads-up preflop raise, call, three streets of check-check, correct winner', () => {
  const g = buildTable(['A', 'B']);
  const { deck, hole, blinds } = dealHand(g, {
    A: ['Ah', 'Kh'],   // dealer/SB
    B: ['9c', '2d'],
  });
  // Force community rig by pre-inserting the desired cards on top.
  deck.cards.unshift('Xx');  // burn
  deck.cards.splice(1, 0, 'Qh', 'Jh', 'Th');   // flop → straight flush for A
  deck.cards.splice(4, 0, 'Xx', '2c');   // burn + turn
  deck.cards.splice(6, 0, 'Xx', '3c');   // burn + river
  // Preflop: A (SB heads-up) acts first. A raises to 60.
  assert.equal(g.actionSeat, blinds.sb);
  validateAndApply(g, 'A', 'raise', 60);
  progressAfterAction(g);   // B to act
  assert.equal(g.actionSeat, blinds.bb);
  validateAndApply(g, 'B', 'call');
  let step = progressAfterAction(g);
  assert.equal(step.streetComplete, true);
  advanceStreet(g, deck);
  assert.equal(g.phase, 'flop');
  // Postflop heads-up: BB acts first.
  assert.equal(g.actionSeat, blinds.bb);
  validateAndApply(g, 'B', 'check');   progressAfterAction(g);
  validateAndApply(g, 'A', 'check');   step = progressAfterAction(g);
  assert.equal(step.streetComplete, true);
  advanceStreet(g, deck);
  assert.equal(g.phase, 'turn');
  validateAndApply(g, 'B', 'check');   progressAfterAction(g);
  validateAndApply(g, 'A', 'check');   step = progressAfterAction(g);
  advanceStreet(g, deck);
  assert.equal(g.phase, 'river');
  validateAndApply(g, 'B', 'check');   progressAfterAction(g);
  validateAndApply(g, 'A', 'check');   step = progressAfterAction(g);
  advanceStreet(g, deck);
  assert.equal(g.phase, 'showdown');
  const { winners } = resolveShowdown(g, hole);
  assert.equal(winners[0].uid, 'A');
  assert.equal(winners[0].amount, 120, 'A wins the entire pot');
});

test('all-in preflop: shorter stack all-in, larger calls, remaining streets deal without betting', () => {
  const g = buildTable(['A', 'B']);
  g.seats[0].stack = 100;   // A short
  const { deck, hole, blinds } = dealHand(g, {
    A: ['Ah', 'Kh'],
    B: ['9c', '2d'],
  });
  // Force straight flush for A on the board.
  deck.cards.unshift('Xx', 'Qh', 'Jh', 'Th', 'Xx', '2c', 'Xx', '3c');
  // A (SB heads-up) shoves all-in.
  validateAndApply(g, 'A', 'all_in');
  progressAfterAction(g);
  validateAndApply(g, 'B', 'call');
  let step = progressAfterAction(g);
  assert.equal(step.streetComplete, true);
  // A is all-in, B has chips but no one left to bet against → deal all
  // remaining streets, no betting.
  while (g.phase !== 'showdown') {
    if (!advanceStreet(g, deck)) {
      // In this simulation harness we skip betting when only one active
      // remains — but our advanceStreet stub doesn't; act it out.
      const active = Object.values(g.seats).filter(s => s.status === 'active');
      if (active.length <= 1) {
        // Force a check-through by manually completing the street.
        for (const s of active) s.hasActedThisStreet = true;
        for (const k of seatIndices(g.seats)) g.pot += g.seats[k].committedThisStreet;
        for (const k of seatIndices(g.seats)) g.seats[k].committedThisStreet = 0;
      }
    }
  }
  const { winners } = resolveShowdown(g, hole);
  assert.equal(winners[0].uid, 'A');
  assert.equal(winners[0].amount, 200, 'A wins main pot of 200 (100 each)');
});
