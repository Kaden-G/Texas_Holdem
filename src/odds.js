// Hand-rank probabilities for the Hand Rankings panel.
//
// STATIC_ODDS: prior probability that your best 5-of-7 in Texas Hold'em
// finishes at each rank (widely cited textbook values). Shown always.
//
// computeMyOdds(hole, community): given the player's private hole cards
// and the currently-dealt community cards, returns the exact probability
// that their best 5-of-7 will finish at each rank, over uniformly random
// completions of the remaining community from the unseen deck. Only
// computed for flop / turn / river — preflop enumeration (~2M combos) is
// too slow; we return null there and the UI shows a dash.
//
// Runs client-side only, from the player's own hole cards, so the odds
// are never sent over the network — nothing to leak.

import { createDeck, cardId } from './cards.js';
import { evaluateHand, HAND_NAMES } from './hand-eval.js';

// Standard 7-card Hold'em odds (probability that best 5-of-7 lands at
// each rank, given a uniformly random 7-card hand). Indexed by
// HAND_RANKS value: 0=High Card ... 9=Royal Flush. Values are the raw
// probability [0..1].
//
// Sources: standard combinatorial enumeration of C(52,7). Non-royal
// straight flushes and non-straight-flush flushes are counted separately
// so the categories are mutually exclusive.
export const STATIC_ODDS = [
  0.17411920,  // 0 High Card
  0.43822546,  // 1 One Pair
  0.23495536,  // 2 Two Pair
  0.04829870,  // 3 Three of a Kind
  0.04619382,  // 4 Straight
  0.03025494,  // 5 Flush
  0.02596102,  // 6 Full House
  0.00168067,  // 7 Four of a Kind
  0.00027851,  // 8 Straight Flush
  0.00003232,  // 9 Royal Flush
];

// Human-readable formatter. <1% shows two decimals, ≥1% shows one, ≥10% shows integer.
export function fmtPct(p) {
  if (p == null || Number.isNaN(p)) return '—';
  if (p === 0) return '0%';
  const pct = p * 100;
  if (pct < 0.01) return '<0.01%';
  if (pct < 1) return pct.toFixed(2) + '%';
  if (pct < 10) return pct.toFixed(1) + '%';
  return Math.round(pct) + '%';
}

// Return a 52-card deck minus the given known cards (matched by id).
function remainingDeck(known) {
  const knownIds = new Set(known.map(cardId));
  return createDeck().filter(c => !knownIds.has(cardId(c)));
}

// Enumerate all size-k subsets of arr as index-tuples (avoids allocating
// intermediate arrays for large enumerations).
function forEachCombo(arr, k, cb) {
  const n = arr.length;
  if (k === 0) { cb([]); return; }
  if (k === 1) { for (let i = 0; i < n; i++) cb([arr[i]]); return; }
  if (k === 2) {
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) cb([arr[i], arr[j]]);
    }
    return;
  }
  // General fallback (unused today: flop/turn only need k=2 and k=1).
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    cb(idx.map(i => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Compute the probability distribution over final rank for the given
// hole cards + partial community.
//
// Returns an array of 10 probabilities indexed by rank (0..9), or null
// if computation isn't meaningful (missing input, or preflop).
export function computeMyOdds(hole, community) {
  if (!hole || hole.length !== 2) return null;
  if (!community) community = [];
  if (community.length === 0) return null;   // preflop — too expensive
  if (community.length > 5) return null;

  const known = [...hole, ...community];
  const need = 5 - community.length;
  const deck = remainingDeck(known);
  if (deck.length < need) return null;

  const counts = new Array(10).fill(0);
  let total = 0;

  if (need === 0) {
    // River: deterministic — one 7-card hand to evaluate.
    const r = evaluateHand(hole, community);
    counts[r.rank] += 1;
    total = 1;
  } else {
    forEachCombo(deck, need, (extra) => {
      const board = [...community, ...extra];
      const r = evaluateHand(hole, board);
      counts[r.rank] += 1;
      total += 1;
    });
  }

  if (total === 0) return null;
  return counts.map(c => c / total);
}

// UI helpers: labels in the same order as the HAND RANKINGS panel
// (best-first). We map to the internal rank indices (worst-first) so the
// two orderings stay in sync.
export const PANEL_RANK_ORDER = [
  9,   // Royal Flush
  8,   // Straight Flush
  7,   // Four of a Kind
  6,   // Full House
  5,   // Flush
  4,   // Straight
  3,   // Three of a Kind
  2,   // Two Pair
  1,   // One Pair
  0,   // High Card
];

export const RANK_LABELS = HAND_NAMES;
