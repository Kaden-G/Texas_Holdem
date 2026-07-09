'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPots } = require('../src/sidepots');

test('single pot when everyone commits the same', () => {
  const pots = buildPots([
    { uid: 'a', committedThisHand: 100, folded: false },
    { uid: 'b', committedThisHand: 100, folded: false },
    { uid: 'c', committedThisHand: 100, folded: false },
  ]);
  assert.deepEqual(pots, [{ amount: 300, eligibleUids: ['a', 'b', 'c'] }]);
});

test('3-way with two all-ins produces main + two side pots', () => {
  // A all-in for 50, B all-in for 150, C matches 200.
  const pots = buildPots([
    { uid: 'A', committedThisHand: 50,  folded: false },
    { uid: 'B', committedThisHand: 150, folded: false },
    { uid: 'C', committedThisHand: 200, folded: false },
  ]);
  // Main pot: 50 × 3 = 150, everyone eligible
  // Side 1:  (150-50) × 2 = 200, only B & C eligible
  // Side 2:  (200-150) × 1 = 50, only C eligible (returned to C effectively)
  assert.deepEqual(pots, [
    { amount: 150, eligibleUids: ['A', 'B', 'C'] },
    { amount: 200, eligibleUids: ['B', 'C'] },
    { amount: 50,  eligibleUids: ['C'] },
  ]);
});

test('folded contributor stays in pot but is not eligible to win', () => {
  const pots = buildPots([
    { uid: 'A', committedThisHand: 100, folded: true },
    { uid: 'B', committedThisHand: 100, folded: false },
    { uid: 'C', committedThisHand: 100, folded: false },
  ]);
  assert.deepEqual(pots, [{ amount: 300, eligibleUids: ['B', 'C'] }]);
});

test('folded short-stack: main pot excludes them, side pot has active players only', () => {
  const pots = buildPots([
    { uid: 'A', committedThisHand: 20,  folded: true  },
    { uid: 'B', committedThisHand: 100, folded: false },
    { uid: 'C', committedThisHand: 100, folded: false },
  ]);
  // Level 20: 20×3=60, eligible = B,C (A folded)
  // Level 100: 80×2=160, eligible = B,C
  // These have identical eligibility → merge → single pot of 220.
  assert.deepEqual(pots, [{ amount: 220, eligibleUids: ['B', 'C'] }]);
});

test('zero commit does not create a pot layer', () => {
  const pots = buildPots([
    { uid: 'A', committedThisHand: 0, folded: false },
    { uid: 'B', committedThisHand: 40, folded: false },
    { uid: 'C', committedThisHand: 40, folded: false },
  ]);
  assert.deepEqual(pots, [{ amount: 80, eligibleUids: ['B', 'C'] }]);
});
