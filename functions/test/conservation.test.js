'use strict';

// Chip-conservation invariants. For every hand played through the pure
// engine, the sum of all seat stacks + game.pot should equal the total
// chips at hand-start. Winners get their pot share added to stack, losers
// lose their commitment — nothing evaporates, nothing appears.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS, newSeat, blindSeats, firstToActPreflop,
  firstToActPostflop, roundIsComplete, foldAround,
} = require('../src/game');
const { validateAndApply, advanceActionSeat, beginStreet } = require('../src/actions');
const { resolveShowdown, resolveFoldAround } = require('../src/showdown');
const { freshShuffledDeck } = require('../src/deck');
const { seatIndices, nextSeatWithStatus, inHandSeats } = require('../src/seats');

// Coherent total: stacks + pot + any chips still in front of players on
// the current street. Note: between progressAfterAction (which folds
// committedThisStreet INTO pot) and beginStreet (which zeros
// committedThisStreet), the transient state DOUBLE-counts. Callers must
// assert either before progressAfterAction or after beginStreet — never
// in between (that intermediate state isn't observable in production
// because both happen inside one transaction).
function totalChips(g) {
  let s = g.pot || 0;
  for (const k of seatIndices(g.seats)) s += g.seats[k].stack + (g.seats[k].committedThisStreet || 0);
  return s;
}
// Post-street-complete variant: pot already has committedThisStreet folded
// in, so don't count it again.
function totalChipsAfterCollect(g) {
  let s = g.pot || 0;
  for (const k of seatIndices(g.seats)) s += g.seats[k].stack;
  return s;
}

function baseGame(uids) {
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
    currentBet: 0,
    minRaise: settings.bigBlind,
    dealerSeat: 0,
    actionSeat: -1,
    communityCards: [],
  };
}

function postBlindsAndDeal(g, holes) {
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
  return b;
}

function stepAction(g) {
  if (foldAround(g.seats)) return { needsFoldAround: true };
  if (!roundIsComplete(g.seats, g.currentBet)) {
    advanceActionSeat(g);
    return {};
  }
  for (const k of seatIndices(g.seats)) g.pot += g.seats[k].committedThisStreet;
  return { streetComplete: true };
}

function advanceStreetSim(g, deck) {
  const next = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[g.phase];
  if (next === 'flop') { deck.burned.push(deck.cards.shift()); g.communityCards.push(deck.cards.shift(), deck.cards.shift(), deck.cards.shift()); }
  else if (next === 'turn' || next === 'river') { deck.burned.push(deck.cards.shift()); g.communityCards.push(deck.cards.shift()); }
  if (next === 'showdown') { g.phase = 'showdown'; return true; }
  const first = firstToActPostflop(g.seats, g.dealerSeat, g.settings.maxPlayers);
  beginStreet(g, next, first);
  return false;
}

function finalize(g, hands, foldAroundHit) {
  const { updatedSeats, winners } = foldAroundHit
    ? resolveFoldAround(g)
    : resolveShowdown(g, hands);
  g.seats = updatedSeats;
  g.pot = 0;
  for (const k of seatIndices(g.seats)) {
    g.seats[k].committedThisStreet = 0;
    g.seats[k].committedThisHand = 0;
  }
  return winners;
}

test('conservation: fold-around preserves total chips', () => {
  const g = baseGame(['A', 'B', 'C']);
  const start = totalChips(g);
  postBlindsAndDeal(g, {});
  // 3-handed preflop: seat 0 (dealer=A) is UTG and acts first. Fold, fold
  // → C (BB) wins.
  validateAndApply(g, 'A', 'fold');
  const step1 = stepAction(g);
  assert.deepEqual(step1, {}, 'still one player left to act');
  validateAndApply(g, 'B', 'fold');
  const step2 = stepAction(g);
  assert.equal(step2.needsFoldAround, true, 'fold-around triggered');
  finalize(g, {}, true);
  assert.equal(totalChipsAfterCollect(g), start, 'chip total unchanged after fold-around');
});

test('conservation: full hand heads-up preserves total chips', () => {
  const g = baseGame(['A', 'B']);
  const start = totalChips(g);
  const { deck } = { deck: { cards: freshShuffledDeck(), burned: [] } };
  postBlindsAndDeal(g, {});
  // Preflop: A (SB heads-up) calls; B checks.
  validateAndApply(g, 'A', 'call'); stepAction(g);
  validateAndApply(g, 'B', 'check');
  let step = stepAction(g);
  assert.equal(step.streetComplete, true);
  advanceStreetSim(g, deck);
  // Rig hole cards so B wins with a pair of kings.
  const hole = { A: ['2c', '7d'], B: ['Kh', 'Kd'] };
  // Ensure community has a K so B has trips (or a pair of kings + kickers).
  g.communityCards = ['Ks', '3c', '9h']; deck.burned.push('Xx');
  // Postflop heads-up: BB acts first (seat 1 = B).
  validateAndApply(g, 'B', 'check'); stepAction(g);
  validateAndApply(g, 'A', 'check');
  step = stepAction(g);
  advanceStreetSim(g, deck);
  g.communityCards = ['Ks', '3c', '9h', '5s']; // turn
  validateAndApply(g, 'B', 'check'); stepAction(g);
  validateAndApply(g, 'A', 'check');
  step = stepAction(g);
  advanceStreetSim(g, deck);
  g.communityCards = ['Ks', '3c', '9h', '5s', '4d']; // river
  validateAndApply(g, 'B', 'check'); stepAction(g);
  validateAndApply(g, 'A', 'check');
  step = stepAction(g);
  advanceStreetSim(g, deck);
  assert.equal(g.phase, 'showdown');
  finalize(g, hole, false);
  assert.equal(totalChips(g), start, 'chip total unchanged after full hand');
});

test('conservation: raise + call preserves total chips', () => {
  const g = baseGame(['A', 'B']);
  const start = totalChips(g);
  postBlindsAndDeal(g, {});
  // A (SB heads-up) raises to 60. B calls. Preflop closes.
  validateAndApply(g, 'A', 'raise', 60); stepAction(g);
  validateAndApply(g, 'B', 'call');
  const step = stepAction(g);
  assert.equal(step.streetComplete, true);
  // After progressAfterAction pulls committedThisStreet into pot, the
  // "after collect" total is the coherent one until beginStreet runs.
  assert.equal(totalChipsAfterCollect(g), start, 'chip total unchanged after street closes');
});

test('conservation: all-in preflop preserves total chips', () => {
  const g = baseGame(['A', 'B']);
  g.seats[0].stack = 100;   // A short
  const start = totalChips(g);
  postBlindsAndDeal(g, {});
  const deck = { cards: freshShuffledDeck(), burned: [] };
  validateAndApply(g, 'A', 'all_in'); stepAction(g);
  validateAndApply(g, 'B', 'call');
  let step = stepAction(g);
  assert.equal(step.streetComplete, true);
  // Walk remaining streets (skipBetting semantics: only 1 active player left)
  while (g.phase !== 'showdown') {
    // Manually flip phase since our simulation harness doesn't recurse skipBetting.
    if (advanceStreetSim(g, deck)) break;
    const active = Object.values(g.seats).filter(s => s.status === 'active');
    if (active.length <= 1) {
      for (const s of active) s.hasActedThisStreet = true;
    }
  }
  finalize(g, { A: ['Ah', 'Kh'], B: ['9c', '2d'] }, false);
  assert.equal(totalChips(g), start, 'chip total unchanged after all-in');
});
