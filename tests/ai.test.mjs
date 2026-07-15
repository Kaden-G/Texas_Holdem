// AI decision-logic tests. Pure ESM — run with:  node --test tests/
// Personalities are passed explicitly with bluff: 0 so decisions that
// matter to each assertion are deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiDecision, estimateStrength, personalityFromStyle, tablePosition,
} from '../src/ai.js';

const S = '♠', H = '♥', D = '♦', C = '♣';
const V = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
const card = (r, s) => ({ rank: String(r), suit: s, value: V[r] });

const CALC = { name: 'T', style: 'calculated', aggression: 0.5, bluff: 0 };

function player(over = {}) {
  return {
    name: 'T', chips: 1000, currentBet: 0, totalBet: 0, hand: [],
    personality: CALC, ...over,
  };
}

// ── #1 draw equity ──

test('flush draw on the flop rates far above air', () => {
  const draw = estimateStrength([card('A', H), card('K', H)], [card('Q', H), card(7, H), card(2, S)]);
  const air = estimateStrength([card(9, C), card(4, D)], [card('Q', H), card(7, H), card(2, S)]);
  assert.ok(draw > 0.4, `flush draw strength ${draw} should be > 0.4`);
  assert.ok(air < 0.35, `air strength ${air} should be < 0.35`);
  assert.ok(draw - air > 0.15, 'draw must clearly outrate air');
});

test('flush draw calls a half-pot bet; air folds it', () => {
  const board = [card('Q', H), card(7, H), card(2, S)];
  const state = { communityCards: board, pot: 300, currentBet: 100, minRaise: 40, bigBlind: 20 };
  const drawD = aiDecision(player({ hand: [card('A', H), card('K', H)] }), state);
  assert.notEqual(drawD.action, 'fold', 'flush draw must not fold to a half-pot bet');
  const airD = aiDecision(player({ hand: [card(9, C), card(4, D)] }), state);
  assert.equal(airD.action, 'fold', 'air should fold to a half-pot bet');
});

test('made flush on the river keeps premium rating (no draws to come)', () => {
  const s = estimateStrength(
    [card('A', H), card('K', H)],
    [card('Q', H), card(7, H), card(2, H), card(3, C), card(5, D)],
  );
  assert.ok(s > 0.6, `made flush ${s} should stay strong on the river`);
});

// ── #2 pot commitment ──

test('pot-committed player calls instead of folding for a cheap price', () => {
  // 600 already in, 400 behind. Facing 300 into a 900 pot: potOdds = 0.25,
  // callFrac = 0.75 — the old cap logic folded here. Commitment overrides.
  const junk = [card(9, C), card(4, D)];
  const board = [card('Q', H), card(7, D), card(2, S)];
  const d = aiDecision(
    player({ hand: junk, chips: 400, totalBet: 600 }),
    { communityCards: board, pot: 900, currentBet: 300, minRaise: 40, bigBlind: 20 },
  );
  assert.equal(d.action, 'call', 'committed stack must see it through at ≤25% pot odds');
});

test('uncommitted player still folds the same junk spot', () => {
  const junk = [card(9, C), card(4, D)];
  const board = [card('Q', H), card(7, D), card(2, S)];
  const d = aiDecision(
    player({ hand: junk, chips: 400, totalBet: 40 }),
    { communityCards: board, pot: 900, currentBet: 300, minRaise: 40, bigBlind: 20 },
  );
  assert.equal(d.action, 'fold');
});

// ── #3 personalities ──

test('personalityFromStyle is deterministic and style-faithful', () => {
  const a1 = personalityFromStyle('aggressive', 'Iron Belle');
  const a2 = personalityFromStyle('aggressive', 'Iron Belle');
  assert.deepEqual(a1, a2, 'same inputs → identical personality');
  assert.equal(a1.style, 'aggressive');
  const t = personalityFromStyle('tight', 'Iron Belle');
  assert.equal(t.style, 'tight');
  assert.ok(a1.aggression > t.aggression, 'aggressive archetype must out-aggress tight');
  const fallback = personalityFromStyle(null, 'Nameless');
  assert.equal(fallback.style, 'calculated', 'unknown style falls back to calculated');
});

// ── #4 bet sizing ──

test('value raises come out as multiples of the big blind', () => {
  // Quads on the flop — premium branch always raises here.
  const hand = [card('A', S), card('A', H)];
  const board = [card('A', D), card('A', C), card(2, H)];
  for (const bb of [20, 40, 150]) {
    const d = aiDecision(
      player({ hand, chips: 5000 }),
      { communityCards: board, pot: 300, currentBet: 0, minRaise: bb, bigBlind: bb },
    );
    if (d.action === 'raise') {
      assert.equal(d.amount % bb, 0, `raise ${d.amount} must be a multiple of bb ${bb}`);
      assert.ok(d.amount >= bb, 'raise must be at least the min raise');
    } else {
      assert.equal(d.action, 'all-in', 'premium hand may shove but never checks/folds');
    }
  }
});

// ── #5 short-stack push/fold ──

test('short stack shoves strong hands preflop, folds junk to a raise', () => {
  const state = { communityCards: [], pot: 60, currentBet: 120, minRaise: 40, bigBlind: 40 };
  const strong = aiDecision(player({ hand: [card('A', S), card('K', S)], chips: 200 }), state);
  assert.equal(strong.action, 'all-in', '5BB with AKs must shove');
  const junk = aiDecision(player({ hand: [card(7, C), card(2, D)], chips: 200 }), state);
  assert.equal(junk.action, 'fold', '5BB with 72o facing a raise must fold');
});

test('short stack checks its option instead of shoving junk', () => {
  const d = aiDecision(
    player({ hand: [card(7, C), card(2, D)], chips: 200, currentBet: 40 }),
    { communityCards: [], pot: 60, currentBet: 40, minRaise: 40, bigBlind: 40 },
  );
  assert.equal(d.action, 'check', 'BB with junk and no raise checks for free');
});

// ── #6 position ──

test('preflop strength is shaded up on the button, down in the blinds', () => {
  const hand = [card('K', S), card(9, S)];
  const button = estimateStrength(hand, [], 1);
  const blind = estimateStrength(hand, [], 0);
  assert.ok(button > blind, `button ${button} must rate above blind ${blind}`);
  assert.ok(Math.abs((button - blind) - 0.12) < 1e-9, 'full positional spread is 0.12');
});

test('tablePosition: dealer is 1, first-to-act is 0, folded players excluded', () => {
  const players = [
    { folded: false, chips: 100, allIn: false },  // dealer
    { folded: false, chips: 100, allIn: false },  // SB — first to act
    { folded: true,  chips: 100, allIn: false },  // folded, excluded
    { folded: false, chips: 100, allIn: false },
  ];
  assert.equal(tablePosition(players, 0, 0), 1, 'dealer acts last → 1');
  assert.equal(tablePosition(players, 0, 1), 0, 'SB acts first → 0');
  const mid = tablePosition(players, 0, 3);
  assert.ok(mid > 0 && mid < 1, 'middle seat lands strictly between');
});

// ── regression: decisions are always action-legal ──

test('never returns call with nothing to call, never checks facing a bet', () => {
  const spots = [
    { hand: [card('A', S), card('A', H)], board: [card('A', D), card(7, C), card(2, H)], bet: 0 },
    { hand: [card('K', S), card('K', H)], board: [card('K', D), card(7, C), card(2, H)], bet: 0 },
    { hand: [card(8, S), card(9, S)], board: [card(2, D), card(7, C), card('Q', H)], bet: 200 },
  ];
  for (const s of spots) {
    for (let i = 0; i < 25; i++) {
      const d = aiDecision(
        player({ hand: s.hand }),
        { communityCards: s.board, pot: 200, currentBet: s.bet, minRaise: 40, bigBlind: 20 },
      );
      if (s.bet === 0) assert.notEqual(d.action, 'call', 'no call when toCall === 0');
      else assert.notEqual(d.action, 'check', 'no check facing a bet');
      if (d.action === 'raise') assert.ok(d.amount >= 40, 'raise increment ≥ minRaise');
    }
  }
});
