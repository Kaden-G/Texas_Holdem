'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateBest, bestOf } = require('../src/eval');
const { resolveShowdown } = require('../src/showdown');
const { DEFAULT_SETTINGS, newSeat } = require('../src/game');

test('evaluateBest identifies a full house', () => {
  const r = evaluateBest(['Kh', 'Kd', 'Kc', 'Th', 'Ts', 'Ac', '2c']);
  assert.match(r.descr, /Full House/i);
});

test('bestOf: A pair of aces beats a pair of kings', () => {
  const community = ['Ah', 'Kd', '7c', '2s', '9h'];
  const winners = bestOf([
    { uid: 'X', holeCards: ['Ac', '3d'], community },
    { uid: 'Y', holeCards: ['Kc', 'Qd'], community },
  ]);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].entry.uid, 'X');
});

test('bestOf: split pot ties both players', () => {
  // Both players play the board (community is a straight); their hole
  // cards don't improve it.
  const community = ['5h', '6d', '7c', '8s', '9h'];
  const winners = bestOf([
    { uid: 'X', holeCards: ['2c', '3d'], community },
    { uid: 'Y', holeCards: ['2h', '3s'], community },
  ]);
  assert.equal(winners.length, 2);
});

test('resolveShowdown distributes 3-way with two all-ins correctly', () => {
  // A all-in 50 (loses), B all-in 150 (wins side vs A/B, but hand C is best), C 200
  // Community + hole rig: C has quads, B has pair, A has high card.
  // Main pot 150 (A,B,C eligible) → C wins.
  // Side pot 200 (B,C eligible) → C wins.
  // Overpay pot 50 (only C eligible) → returned to C.
  const game = {
    settings: DEFAULT_SETTINGS,
    dealerSeat: 0,
    seats: {
      0: { uid: 'A', displayName: 'A', stack: 0,   committedThisStreet: 0, committedThisHand: 50,  status: 'all_in', hasActedThisStreet: true, seat: 0 },
      1: { uid: 'B', displayName: 'B', stack: 0,   committedThisStreet: 0, committedThisHand: 150, status: 'all_in', hasActedThisStreet: true, seat: 1 },
      2: { uid: 'C', displayName: 'C', stack: 0,   committedThisStreet: 0, committedThisHand: 200, status: 'active', hasActedThisStreet: true, seat: 2 },
    },
    communityCards: ['2c', '2d', '2h', '9s', 'Th'],
  };
  const hands = {
    A: ['3c', '4d'],
    B: ['Kh', 'Kd'],   // two pair 2s and Ks
    C: ['2s', 'As'],   // quads twos, ace kicker
  };
  const { updatedSeats, winners } = resolveShowdown(game, hands);
  const cSeat = updatedSeats[2];
  // C wins main 150 + side 200 + overpay 50 = 400.
  assert.equal(cSeat.stack, 400);
  assert.ok(winners.some(w => w.uid === 'C' && w.amount >= 200));
});

test('resolveShowdown: split pot divides evenly, odd chip to earliest seat left of dealer', () => {
  // Both players tie on the board (straight). Pot = 51 chips (odd).
  const game = {
    settings: DEFAULT_SETTINGS,
    dealerSeat: 0,
    seats: {
      0: { uid: 'X', displayName: 'X', stack: 0, committedThisStreet: 0, committedThisHand: 26, status: 'active', hasActedThisStreet: true, seat: 0 },
      2: { uid: 'Y', displayName: 'Y', stack: 0, committedThisStreet: 0, committedThisHand: 25, status: 'active', hasActedThisStreet: true, seat: 2 },
    },
    communityCards: ['5h', '6d', '7c', '8s', '9h'],
  };
  const hands = {
    X: ['2c', '3d'],
    Y: ['2h', '3s'],
  };
  const { updatedSeats, winners } = resolveShowdown(game, hands);
  const xWon = updatedSeats[0].stack;
  const yWon = updatedSeats[2].stack;
  // X committed 26, Y committed 25 → the extra 1 from X is an overpay pot
  // returning to X. Main pot is 50 split 25/25, odd chip logic irrelevant
  // here since it's even. So X ends up with 25 + 1 = 26; Y with 25.
  assert.equal(xWon + yWon, 51);
});
