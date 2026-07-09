'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildDeck, shuffle, freshShuffledDeck, isValidCard } = require('../src/deck');

test('deck contains 52 unique cards', () => {
  const d = buildDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  for (const c of d) assert.ok(isValidCard(c), `invalid card ${c}`);
});

test('shuffle preserves multiset (no cards lost or duplicated)', () => {
  for (let i = 0; i < 20; i++) {
    const d = freshShuffledDeck();
    assert.equal(d.length, 52);
    assert.equal(new Set(d).size, 52);
  }
});

test('shuffle uniformity: each card lands at each position within tolerance', () => {
  // 52 positions × 52 cards. With N=20000 shuffles, expected count per
  // cell is 20000/52 ≈ 385. Any single cell being extremely far from that
  // suggests bias. We use a loose ±80 tolerance.
  const N = 20000;
  const counts = new Map();  // key = position, val = Map(card→count)
  const deck = buildDeck();
  for (let i = 0; i < 52; i++) counts.set(i, new Map(deck.map(c => [c, 0])));

  for (let s = 0; s < N; s++) {
    const d = shuffle(deck);
    for (let i = 0; i < 52; i++) {
      const m = counts.get(i);
      m.set(d[i], m.get(d[i]) + 1);
    }
  }
  const expected = N / 52;
  const tol = 80;
  for (const [pos, m] of counts) {
    for (const [card, c] of m) {
      assert.ok(
        Math.abs(c - expected) <= tol,
        `pos ${pos} card ${card}: count ${c} outside expected ${expected} ± ${tol}`
      );
    }
  }
});
