'use strict';

const crypto = require('crypto');

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];

function buildDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

// Fisher–Yates using crypto.randomInt (uniform, cryptographically secure).
function shuffle(cards) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function freshShuffledDeck() {
  return shuffle(buildDeck());
}

function isValidCard(c) {
  return typeof c === 'string' && c.length === 2 && RANKS.includes(c[0]) && SUITS.includes(c[1]);
}

module.exports = { RANKS, SUITS, buildDeck, shuffle, freshShuffledDeck, isValidCard };
