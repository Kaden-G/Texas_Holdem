'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_SETTINGS, newSeat } = require('../src/game');
const {
  validateAndApply, advanceActionSeat, ActionError,
} = require('../src/actions');
const { roundIsComplete } = require('../src/game');

function baseGame(uids) {
  const seats = {};
  uids.forEach((u, i) => {
    seats[i] = newSeat(u, u, i, DEFAULT_SETTINGS);
    seats[i].status = 'active';
  });
  return {
    status: 'playing',
    phase: 'preflop',
    settings: DEFAULT_SETTINGS,
    handNumber: 1,
    seats,
    pot: 0,
    currentBet: DEFAULT_SETTINGS.bigBlind,
    minRaise: DEFAULT_SETTINGS.bigBlind,
    dealerSeat: 0,
    actionSeat: 0,
    communityCards: [],
  };
}

test('fold sets status folded and marks acted', () => {
  const g = baseGame(['A', 'B', 'C']);
  validateAndApply(g, 'A', 'fold');
  assert.equal(g.seats[0].status, 'folded');
  assert.equal(g.seats[0].hasActedThisStreet, true);
});

test('check illegal when facing a bet', () => {
  const g = baseGame(['A', 'B']);
  g.currentBet = 40;
  g.seats[0].committedThisStreet = 0;
  assert.throws(() => validateAndApply(g, 'A', 'check'), ActionError);
});

test('call pays the difference and marks acted', () => {
  const g = baseGame(['A', 'B']);
  g.currentBet = 40;
  g.seats[0].committedThisStreet = 20;
  g.seats[0].stack = 1000;
  validateAndApply(g, 'A', 'call');
  assert.equal(g.seats[0].stack, 980);
  assert.equal(g.seats[0].committedThisStreet, 40);
  assert.equal(g.seats[0].hasActedThisStreet, true);
});

test('call with insufficient stack turns into an all-in call', () => {
  const g = baseGame(['A', 'B']);
  g.currentBet = 200;
  g.seats[0].committedThisStreet = 0;
  g.seats[0].stack = 50;
  validateAndApply(g, 'A', 'call');
  assert.equal(g.seats[0].stack, 0);
  assert.equal(g.seats[0].status, 'all_in');
  assert.equal(g.seats[0].committedThisStreet, 50);
});

test('raise-to requires at least previous + minRaise', () => {
  const g = baseGame(['A', 'B']);
  g.currentBet = 40;
  g.minRaise = 40;
  g.seats[0].committedThisStreet = 0;
  g.seats[0].stack = 1000;
  assert.throws(() => validateAndApply(g, 'A', 'raise', 60), ActionError);
  validateAndApply(g, 'A', 'raise', 80);
  assert.equal(g.seats[0].committedThisStreet, 80);
  assert.equal(g.currentBet, 80);
  assert.equal(g.minRaise, 40);   // raise increment 40 == old minRaise
});

test('roundIsComplete when everyone matched and acted', () => {
  const g = baseGame(['A', 'B']);
  g.seats[0].hasActedThisStreet = true;
  g.seats[1].hasActedThisStreet = true;
  g.seats[0].committedThisStreet = 40;
  g.seats[1].committedThisStreet = 40;
  g.currentBet = 40;
  assert.equal(roundIsComplete(g.seats, 40), true);
});

test('roundIsComplete false when someone has not acted yet', () => {
  const g = baseGame(['A', 'B']);
  g.seats[0].hasActedThisStreet = true;
  g.seats[1].hasActedThisStreet = false;
  g.seats[0].committedThisStreet = 40;
  g.seats[1].committedThisStreet = 40;
  assert.equal(roundIsComplete(g.seats, 40), false);
});
