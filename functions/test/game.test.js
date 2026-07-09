'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS, newSeat, blindSeats, firstToActPreflop, firstToActPostflop,
} = require('../src/game');

function mkSeats(uids) {
  const seats = {};
  uids.forEach((uid, i) => {
    seats[i] = newSeat(uid, uid, i, DEFAULT_SETTINGS);
    seats[i].status = 'active';
  });
  return seats;
}

test('heads-up: dealer is small blind and acts first preflop', () => {
  const seats = mkSeats(['A', 'B']);
  const dealer = 0;
  const b = blindSeats(seats, dealer, 6);
  assert.equal(b.sb, 0, 'dealer is SB heads-up');
  assert.equal(b.bb, 1, 'other player is BB heads-up');
  const first = firstToActPreflop(seats, b, 6);
  assert.equal(first, 0, 'SB acts first preflop heads-up');
});

test('heads-up: BB acts first postflop', () => {
  const seats = mkSeats(['A', 'B']);
  const dealer = 0;
  const first = firstToActPostflop(seats, dealer, 6);
  assert.equal(first, 1, 'non-dealer (BB) acts first postflop heads-up');
});

test('3-handed: SB and BB are seats after dealer; UTG (dealer wraps) acts first preflop', () => {
  const seats = mkSeats(['A', 'B', 'C']);
  const dealer = 0;
  const b = blindSeats(seats, dealer, 6);
  assert.equal(b.sb, 1);
  assert.equal(b.bb, 2);
  const first = firstToActPreflop(seats, b, 6);
  // With 3 players, seat after BB = seat 0 (dealer). Dealer acts first
  // preflop in 3-handed play.
  assert.equal(first, 0);
});

test('3-handed: SB acts first postflop', () => {
  const seats = mkSeats(['A', 'B', 'C']);
  const dealer = 0;
  const first = firstToActPostflop(seats, dealer, 6);
  // First active seat left of dealer = seat 1 (SB).
  assert.equal(first, 1);
});

test('6-handed: standard blind positions', () => {
  const seats = mkSeats(['A', 'B', 'C', 'D', 'E', 'F']);
  const b = blindSeats(seats, 2, 6);
  assert.equal(b.sb, 3);
  assert.equal(b.bb, 4);
  // First to act preflop = seat 5 (UTG).
  assert.equal(firstToActPreflop(seats, b, 6), 5);
  // First to act postflop = seat 3 (SB).
  assert.equal(firstToActPostflop(seats, 2, 6), 3);
});
