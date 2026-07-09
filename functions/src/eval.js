'use strict';

// Bridge to the pokersolver npm package. We convert our 2-char server
// encoding (e.g. "As", "Td") to pokersolver's uppercase encoding.
// pokersolver returns a Hand with .rank (1-10, higher is better) and
// .descr ("Full House, Kings over Tens"). We use Hand.winners() to
// resolve ties.

const { Hand } = require('pokersolver');

// Our decks use ranks 2-9,T,J,Q,K,A and suits s,h,d,c. pokersolver expects
// the same format but the rank "T" must be uppercase. Our encoding is
// already compatible; just normalize case defensively.
function toSolver(card) {
  return card[0].toUpperCase() + card[1].toLowerCase();
}

function evaluateBest(cards) {
  if (!Array.isArray(cards) || cards.length < 5) {
    throw new Error(`evaluateBest requires ≥5 cards, got ${cards && cards.length}`);
  }
  const solved = Hand.solve(cards.map(toSolver));
  return {
    rank: solved.rank,        // integer, higher = stronger category
    name: solved.name,        // "Two Pair" etc.
    descr: solved.descr,      // "Full House, Kings over Tens"
    _solved: solved,
  };
}

// Given an array of { uid, holeCards, community } entries, returns the
// subset that ties for best. pokersolver.Hand.winners handles ties
// correctly (including kicker comparisons).
function bestOf(entries) {
  if (!entries.length) return [];
  const solved = entries.map(e => {
    const hand = Hand.solve([...e.holeCards, ...e.community].map(toSolver));
    hand._entry = e;
    return hand;
  });
  const winners = Hand.winners(solved);
  return winners.map(w => ({ entry: w._entry, hand: {
    rank: w.rank, name: w.name, descr: w.descr,
  }}));
}

module.exports = { evaluateBest, bestOf };
