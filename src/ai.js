import { evaluateHand, HAND_RANKS } from './hand-eval.js';
import { computeMyOdds } from './odds.js';

// Bold cow-poke handles for the non-human players, split by gender so an AI's
// name matches the gender of the portrait it's dealt.
const AI_NAMES = {
  m: [
    'Rattlesnake Pete', 'Black Jack Mahoney', 'Dead-Eye Dawson', 'Cactus Joe',
    'Whiskey Bill', 'Doc Holloway', 'Preacher Quaid', 'Buckshot Riley',
    'Diamondback Dan', 'Sundown Slade', 'One-Eyed Cole', 'Mad Dog Morgan',
    'Lefty Malone', 'Ace McGraw', 'Tombstone Tate', 'Wild Bill Hawkins',
    'Reno Kid', 'Snake-Bite Sawyer', 'Colt Jackson', 'Bronco Burns',
    'Faro Frank', 'Lucky Luke Dempsey', 'Dusty Granger', 'Hangtree Harlan',
    'Coyote Cassidy', 'Gambler Gus', 'Iron Tom Bricks', 'Silver Dollar Sam',
    'Texas Red', 'Bloody Bob Vance', 'Lonesome Levi', 'Banjo Briggs',
    'Rusty Calhoun', 'Maverick Doyle', 'Cinch Carter', 'Outlaw Odell',
    'Vinegar Joe', 'Quickdraw Quinn', 'Powder Keg Pruitt', "Ramblin' Cy",
    'High-Card Holt',
  ],
  f: [
    'Iron Belle', 'Calamity Sue', 'Gunsmoke Gracie', 'Stagecoach Mary',
    'Six-Gun Sallie', 'Comanche Kate', 'Dakota Rose', 'Apache Annie',
    'Pistol Pearl', 'Sharpshooter Sadie', 'Deadwood Dot', 'Outlaw Opal',
    'Lola Vasquez', 'Cherokee Jane', 'Ruby Vane', 'Whiskey Winnie',
    'Gold-Tooth Greta', 'Dynamite Dolly',
  ],
  nb: [
    'Indigo Rivers', 'Sage Ardmore', 'Charlie Quicksilver', 'Jesse Wilder',
    'Marlowe Rourke', 'Ash Calloway', 'Marion Stark', 'Rory Blackwood',
    'Wren Tucker', 'Rowan Bly', 'Lane Sutter', 'Frankie Dell',
    'Quill Magee', 'Shiloh Hart',
  ],
};

// Playing-style archetypes; each chosen AI gets one (with a little jitter).
const STYLES = [
  { style: 'tight',      aggression: 0.30, bluff: 0.07 },
  { style: 'aggressive', aggression: 0.70, bluff: 0.20 },
  { style: 'calculated', aggression: 0.50, bluff: 0.12 },
  { style: 'loose',      aggression: 0.60, bluff: 0.28 },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const jitter = mag => (Math.random() * 2 - 1) * mag;
const shuffle = arr => [...arr].sort(() => Math.random() - 0.5);

// `genders` is an array of 'm'/'f'/'nb', one per AI seat (from the dealt
// portraits). Returns a personality per seat whose name matches that gender.
export function getAIPersonalities(genders) {
  // Back-compat: a number means "this many AIs" with random genders.
  if (typeof genders === 'number') {
    const opts = ['m', 'f', 'nb'];
    genders = Array.from({ length: genders }, () => opts[Math.floor(Math.random() * opts.length)]);
  }
  const pools = { m: shuffle(AI_NAMES.m), f: shuffle(AI_NAMES.f), nb: shuffle(AI_NAMES.nb) };
  // If a gender's pool runs dry, borrow from any remaining handle.
  const drawAny = () => {
    for (const k of ['nb', 'm', 'f']) if (pools[k].length) return pools[k].shift();
    return 'The Stranger';
  };
  return genders.map(g => {
    const pool = pools[g];
    const name = pool && pool.length ? pool.shift() : drawAny();
    const base = STYLES[Math.floor(Math.random() * STYLES.length)];
    return {
      name,
      gender: g,
      style: base.style,
      aggression: clamp(base.aggression + jitter(0.1), 0.15, 0.9),
      bluff: clamp(base.bluff + jitter(0.05), 0.03, 0.35),
    };
  });
}

// Rebuild the personality that addAiSeat stored as a style id. Jitter is
// derived from the bot's name so the same bot plays consistently across
// turns and browser sessions (the online host re-derives this every turn).
export function personalityFromStyle(styleId, name = '') {
  const base = STYLES.find(s => s.style === styleId) || STYLES[2]; // default: calculated
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  hash = Math.abs(hash);
  const jitterA = ((hash % 21) - 10) / 100;        // ±0.10
  const jitterB = (((hash >> 3) % 11) - 5) / 100;  // ±0.05
  return {
    name,
    style: base.style,
    aggression: clamp(base.aggression + jitterA, 0.15, 0.9),
    bluff: clamp(base.bluff + jitterB, 0.03, 0.35),
  };
}

// Table position ∈ [0,1] among players still in the hand: 0 = first to act
// postflop (small blind), 1 = dealer/button (acts last). Used to widen or
// tighten preflop ranges.
export function tablePosition(players, dealerIndex, myIndex) {
  const inHand = players
    .map((p, i) => ({ p, i }))
    .filter(x => !x.p.folded && (x.p.chips > 0 || x.p.allIn));
  const n = inHand.length;
  if (n <= 1) return 0.5;
  // Postflop act order: seat after the dealer acts first, dealer acts last.
  const order = x => {
    const d = (x.i - dealerIndex + players.length) % players.length;
    return d === 0 ? players.length : d;   // dealer sorts last
  };
  const ranked = inHand.slice().sort((a, b) => order(a) - order(b));
  const idx = ranked.findIndex(x => x.i === myIndex);
  return idx < 0 ? 0.5 : idx / (n - 1);
}

// Round a raise increment to a human-looking size: a multiple of the big
// blind, at least the legal minimum, at most what the stack affords.
function sizeRaise(increment, minRaise, maxIncrement, bigBlind) {
  let a = Math.round(increment / bigBlind) * bigBlind;
  a = Math.max(minRaise, a);
  a = Math.min(a, maxIncrement);
  return a;
}

export function aiDecision(player, gameState) {
  const { communityCards, pot, currentBet, minRaise } = gameState;
  const bigBlind = gameState.bigBlind || minRaise || 20;
  const position = gameState.position ?? 0.5;
  const personality = player.personality || personalityFromStyle('calculated', player.name);
  const toCall = Math.max(0, currentBet - player.currentBet);

  const handStrength = estimateStrength(player.hand, communityCards, position);
  // Pot odds: the equity you need to profitably call.
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  // How big the call is relative to our stack.
  const callFrac = player.chips > 0 ? toCall / player.chips : 1;
  // Raise semantics: decision.amount is the increment above the table's
  // currentBet; chips spent by the raiser = toCall + increment.
  const maxIncrement = Math.max(0, player.chips - toCall);

  // Short stack preflop: push/fold. Blinds escalate in this game, so a
  // ≤12BB stack that limp-calls just blinds away — shove playable hands,
  // fold the rest (checking when it's free, calling when priced in).
  const stackBB = player.chips / bigBlind;
  if (communityCards.length === 0 && stackBB > 0 && stackBB <= 12) {
    const threshold = 0.40 + stackBB * 0.012;   // 2BB→0.42 … 12BB→0.54
    if (handStrength >= threshold) return { action: 'all-in' };
    if (toCall === 0) return { action: 'check' };
    if (potOdds < 0.2 && handStrength >= 0.3) return { action: 'call' };
    return { action: 'fold' };
  }

  // Pot commitment: once ~1/3 of our chips for this hand are in the pot
  // and the price to continue is small, we don't fold — kills the
  // "committed 40% of the stack then folded to a min-bet" look.
  const committed = player.totalBet ?? player.committedThisHand ?? player.currentBet ?? 0;
  const commitFrac = committed / ((committed + player.chips) || 1);
  const potCommitted = commitFrac >= 0.35 && potOdds <= 0.25;

  // Occasional bluff-raise, but only when nobody has bet into us.
  if (toCall === 0 && Math.random() < personality.bluff && maxIncrement >= minRaise) {
    const bluff = sizeRaise(minRaise + pot * (0.3 + Math.random() * 0.4), minRaise, maxIncrement, bigBlind);
    return { action: 'raise', amount: bluff };
  }

  // Premium hands: bet/raise for value; never fold.
  if (handStrength > 0.8) {
    if (maxIncrement >= minRaise) {
      const target = pot * (0.5 + personality.aggression * 0.6);
      const inc = sizeRaise(target, minRaise, maxIncrement, bigBlind);
      // A raise that commits nearly the whole stack reads better as a shove.
      if (inc >= maxIncrement * 0.85) return { action: 'all-in' };
      return { action: 'raise', amount: inc };
    }
    // No legal raise left: call off (engine caps at stack) or shove when free.
    return toCall > 0 ? { action: 'call' } : { action: 'all-in' };
  }

  // Strong hands: usually just call any bet, sometimes re-raise.
  if (handStrength > 0.6) {
    if (Math.random() < personality.aggression * 0.6 && callFrac < 0.3 && maxIncrement >= minRaise) {
      const inc = sizeRaise(minRaise + pot * (0.2 + Math.random() * 0.3), minRaise, maxIncrement, bigBlind);
      return { action: 'raise', amount: inc };
    }
    return toCall > 0 ? { action: 'call' } : { action: 'check' };
  }

  if (toCall === 0) return { action: 'check' };

  // Committed and the price is right — see it through.
  if (potCommitted) return { action: 'call' };

  // Marginal hands: defend by pot odds. This is what punishes constant
  // over-betting — a big bluff lays the table a good price, so decent hands
  // call instead of always folding.
  const slack = personality.style === 'loose' ? 0.14
    : personality.style === 'tight' ? -0.05 : 0.06;
  if (handStrength >= potOdds - slack) {
    // ...but don't stack off light: cap how much of our stack we'll commit.
    const maxFrac = 0.3 + handStrength * 0.6;
    if (callFrac <= maxFrac) return { action: 'call' };
  }

  // Sometimes call a small bet to keep aggressors honest.
  if (callFrac < 0.06 && Math.random() < 0.5) return { action: 'call' };

  return { action: 'fold' };
}

export function estimateStrength(hand, community, position = 0.5) {
  if (!hand || hand.length < 2) return 0.3;

  if (!community || community.length === 0) {
    // Preflop: static table, shaded by position (±0.06 button vs blinds).
    const posAdj = (position - 0.5) * 0.12;
    return clamp(preflopStrength(hand) + posAdj, 0.05, 0.95);
  }

  const eval_ = evaluateHand(hand, community);
  const rankNorm = eval_.rank / 9;
  const kickerBonus = (eval_.kickers[0] || 2) / 14 * 0.1;
  // High-card-only hands are air: score them well below one pair so the
  // pot-odds defense doesn't turn the bots into call-stations with 9-high.
  // Draws still rescue them below via max(made, drawStrength).
  const made = eval_.rank === HAND_RANKS.HIGH_CARD
    ? 0.10 + ((eval_.kickers[0] || 2) / 14) * 0.08
    : Math.min(rankNorm * 0.8 + kickerBonus + 0.15, 1);
  if (community.length >= 5) return made;   // river: no cards to come

  // Flop/turn: fold real equity in so draws aren't scored as air. Reuses
  // the odds engine (exact enumeration of remaining boards; 990 evals on
  // the flop, 44 on the turn) and weights strong finishes (straight+)
  // heavily, medium finishes (two pair / trips) lightly. A four-flush
  // lands ≈0.47 (callable, semi-bluffable) instead of the old 0.23.
  const dist = computeMyOdds(hand, community);
  if (!dist) return made;
  let pStrong = 0;
  for (let r = HAND_RANKS.STRAIGHT; r <= HAND_RANKS.ROYAL_FLUSH; r++) pStrong += dist[r];
  const pMedium = dist[HAND_RANKS.TWO_PAIR] + dist[HAND_RANKS.THREE_KIND];
  const drawStrength = Math.min(pStrong * 1.05 + pMedium * 0.35, 0.95);
  return Math.max(made, drawStrength);
}

function preflopStrength(hand) {
  const [a, b] = hand;
  const high = Math.max(a.value, b.value);
  const low = Math.min(a.value, b.value);
  const suited = a.suit === b.suit;
  const paired = a.value === b.value;

  if (paired) {
    if (high >= 12) return 0.9;
    if (high >= 8) return 0.7;
    return 0.55;
  }
  if (high === 14 && low >= 12) return suited ? 0.85 : 0.8;
  if (high === 14 && low >= 10) return suited ? 0.7 : 0.6;
  if (high === 14) return suited ? 0.55 : 0.45;
  if (high === 13 && low >= 11) return suited ? 0.65 : 0.55;
  if (suited && high - low <= 2) return 0.5;
  if (suited) return 0.4;
  if (high - low <= 2) return 0.35;
  return 0.25;
}
