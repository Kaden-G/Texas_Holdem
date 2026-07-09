'use strict';

// Given a list of contestants { uid, committedThisHand, folded }, compute
// main + side pots. Folded players' chips are still in the pot but they
// aren't eligible to win any of it.
//
// Algorithm: walk unique committed levels ascending. At each level, the
// pot layer is (level - previousLevel) * (# players who committed >= level).
// Eligible winners of that layer are non-folded players who committed >=
// level.
//
// Returns [{ amount, eligibleUids: [...] }, ...], in order main → outer.
// Layers with amount === 0 are skipped. If every eligible player at a
// layer has folded (edge case where the last non-fold committed less than
// someone who folded), the layer is folded into the next outer layer or,
// if none, awarded back — but that scenario can't occur in real play
// because betting can't proceed past the last non-folded player.
function buildPots(contestants) {
  const contribs = contestants.map(c => ({
    uid: c.uid,
    amount: c.committedThisHand | 0,
    folded: !!c.folded,
  }));

  const uniqueLevels = Array.from(new Set(
    contribs.filter(c => c.amount > 0).map(c => c.amount)
  )).sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of uniqueLevels) {
    const layer = level - prev;
    const contributors = contribs.filter(c => c.amount >= level);
    const amount = layer * contributors.length;
    const eligibleUids = contributors.filter(c => !c.folded).map(c => c.uid);
    if (amount > 0) pots.push({ amount, eligibleUids });
    prev = level;
  }

  // Merge consecutive pots with identical eligibility sets so the main
  // pot doesn't fragment when several players committed equal totals.
  const merged = [];
  for (const p of pots) {
    const last = merged[merged.length - 1];
    if (last && sameSet(last.eligibleUids, p.eligibleUids)) {
      last.amount += p.amount;
    } else {
      merged.push({ amount: p.amount, eligibleUids: p.eligibleUids.slice() });
    }
  }
  return merged;
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

module.exports = { buildPots };
