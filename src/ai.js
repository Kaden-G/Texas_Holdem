import { evaluateHand, HAND_RANKS } from './hand-eval.js';

// 50 bold cow-poke handles for the non-human players. One is drawn per AI seat.
const AI_NAMES = [
  'Rattlesnake Pete', 'Black Jack Mahoney', 'Dead-Eye Dawson', 'Cactus Joe',
  'Whiskey Bill', 'Iron Belle', 'Calamity Sue', 'Doc Holloway',
  'Preacher Quaid', 'Buckshot Riley', 'Diamondback Dan', 'Sundown Slade',
  'Gunsmoke Gracie', 'One-Eyed Cole', 'Mad Dog Morgan', 'Stagecoach Mary',
  'Lefty Malone', 'Ace McGraw', 'Six-Gun Sallie', 'Comanche Kate',
  'Tombstone Tate', 'Wild Bill Hawkins', 'Reno Kid', 'Dakota Rose',
  'Snake-Bite Sawyer', 'Colt Jackson', 'Bronco Burns', 'Faro Frank',
  'Lucky Luke Dempsey', 'Dusty Granger', 'Hangtree Harlan', 'Apache Annie',
  'Coyote Cassidy', 'Gambler Gus', 'Iron Tom Bricks', 'Silver Dollar Sam',
  'Texas Red', 'Bloody Bob Vance', 'Lonesome Levi', 'Pistol Pearl',
  'Banjo Briggs', 'Rusty Calhoun', 'Maverick Doyle', 'Cinch Carter',
  'Outlaw Odell', 'Vinegar Joe', 'Quickdraw Quinn', 'Powder Keg Pruitt',
  "Ramblin' Cy", 'High-Card Holt',
];

// Playing-style archetypes; each chosen AI gets one (with a little jitter).
const STYLES = [
  { style: 'tight',      aggression: 0.30, bluff: 0.07 },
  { style: 'aggressive', aggression: 0.70, bluff: 0.20 },
  { style: 'calculated', aggression: 0.50, bluff: 0.12 },
  { style: 'loose',      aggression: 0.60, bluff: 0.28 },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const jitter = mag => (Math.random() * 2 - 1) * mag;

export function getAIPersonalities(count) {
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5).slice(0, count);
  return names.map(name => {
    const base = STYLES[Math.floor(Math.random() * STYLES.length)];
    return {
      name,
      style: base.style,
      aggression: clamp(base.aggression + jitter(0.1), 0.15, 0.9),
      bluff: clamp(base.bluff + jitter(0.05), 0.03, 0.35),
    };
  });
}

export function aiDecision(player, gameState) {
  const { communityCards, pot, currentBet, minRaise } = gameState;
  const personality = player.personality;
  const toCall = currentBet - player.currentBet;

  const handStrength = estimateStrength(player.hand, communityCards);
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

  if (Math.random() < personality.bluff && toCall < player.chips * 0.15) {
    const bluffAmount = minRaise + Math.floor(Math.random() * minRaise);
    if (bluffAmount <= player.chips) {
      return { action: 'raise', amount: Math.min(bluffAmount, player.chips) };
    }
  }

  if (handStrength > 0.8) {
    const raiseAmount = Math.floor(pot * (0.5 + personality.aggression * 0.5));
    if (raiseAmount >= minRaise && raiseAmount <= player.chips) {
      return { action: 'raise', amount: raiseAmount };
    }
    return toCall <= player.chips ? { action: 'call' } : { action: 'fold' };
  }

  if (handStrength > 0.6) {
    if (Math.random() < personality.aggression && toCall < player.chips * 0.2) {
      const raiseAmount = minRaise + Math.floor(Math.random() * pot * 0.3);
      if (raiseAmount <= player.chips) {
        return { action: 'raise', amount: raiseAmount };
      }
    }
    return toCall <= player.chips * 0.3 ? { action: 'call' } : { action: 'fold' };
  }

  if (handStrength > 0.4) {
    if (toCall === 0) return { action: 'check' };
    return toCall <= player.chips * 0.15 ? { action: 'call' } : { action: 'fold' };
  }

  if (toCall === 0) return { action: 'check' };

  if (personality.style === 'loose' && toCall < player.chips * 0.08) {
    return { action: 'call' };
  }

  return { action: 'fold' };
}

function estimateStrength(hand, community) {
  if (!hand || hand.length < 2) return 0.3;

  if (community.length === 0) {
    return preflopStrength(hand);
  }

  const eval_ = evaluateHand(hand, community);
  const rankNorm = eval_.rank / 9;
  const kickerBonus = (eval_.kickers[0] || 2) / 14 * 0.1;
  return Math.min(rankNorm * 0.8 + kickerBonus + 0.15, 1);
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
