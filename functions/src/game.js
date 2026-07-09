'use strict';

const {
  seatIndices, occupiedSeats, livingSeats, inHandSeats,
  nextSeatWithStatus, firstSeatWithStatusFrom, findSeatByUid, countBy,
} = require('./seats');

const DEFAULT_SETTINGS = {
  smallBlind: 10,
  bigBlind: 20,
  startingStack: 2000,
  maxPlayers: 6,
};

function newSeat(uid, displayName, seatIndex, settings) {
  return {
    uid,
    displayName: (displayName || 'stranger').slice(0, 24),
    stack: settings.startingStack,
    committedThisStreet: 0,
    committedThisHand: 0,
    status: 'sitting_out',   // becomes 'active' when a hand starts
    hasActedThisStreet: false,
    seat: seatIndex,
  };
}

function pickOpenSeat(seats, maxSeats) {
  for (let i = 0; i < maxSeats; i++) {
    if (!seats[i]) return i;
  }
  return -1;
}

// Advance dealer button to next living seat (skips busted / sitting_out).
function nextDealerSeat(seats, currentDealer, maxSeats) {
  const eligible = ['active', 'all_in', 'sitting_out'];
  // For dealer button we skip busted only; sitting_out still passes the
  // button so they get their blinds owed on the next return.
  const next = nextSeatWithStatus(seats, currentDealer, eligible, maxSeats);
  return next === -1 ? currentDealer : next;
}

// Given a dealer seat, return the small-blind and big-blind seats
// walking clockwise. Heads-up: dealer IS the SB.
function blindSeats(seats, dealerSeat, maxSeats) {
  const inHand = inHandSeats(seats);
  if (inHand.length < 2) return null;
  const inHandStatuses = ['active', 'all_in'];
  if (inHand.length === 2) {
    // Heads-up: dealer posts SB, opponent posts BB.
    const dealer = seats[dealerSeat] && inHandStatuses.includes(seats[dealerSeat].status)
      ? dealerSeat
      : firstSeatWithStatusFrom(seats, dealerSeat, inHandStatuses, maxSeats);
    const other = nextSeatWithStatus(seats, dealer, inHandStatuses, maxSeats);
    return { sb: dealer, bb: other };
  }
  const sb = nextSeatWithStatus(seats, dealerSeat, inHandStatuses, maxSeats);
  const bb = nextSeatWithStatus(seats, sb, inHandStatuses, maxSeats);
  return { sb, bb };
}

// First-to-act seat for a given street.
function firstToActPreflop(seats, blinds, maxSeats) {
  const inHand = inHandSeats(seats).length;
  if (inHand === 2) return blinds.sb;  // heads-up: SB acts first preflop
  return nextSeatWithStatus(seats, blinds.bb, ['active'], maxSeats);
}

function firstToActPostflop(seats, dealerSeat, maxSeats) {
  const inHand = inHandSeats(seats);
  if (inHand.length === 2) {
    // Heads-up postflop: non-dealer (BB) acts first. Since dealer is SB
    // heads-up, we want the seat that is NOT dealer.
    const other = inHand.find(s => s.seat !== dealerSeat);
    return other ? other.seat : -1;
  }
  return firstSeatWithStatusFrom(seats, (dealerSeat + 1) % maxSeats, ['active'], maxSeats);
}

// Betting round is complete when every in-hand player is either all_in
// or has (acted this street AND matched currentBet).
function roundIsComplete(seats, currentBet) {
  const inHand = inHandSeats(seats);
  if (inHand.length < 2) return true;   // only one player left in the hand
  const stillActionable = inHand.filter(s => s.status === 'active');
  if (stillActionable.length === 0) return true;   // everyone all-in
  for (const s of stillActionable) {
    if (!s.hasActedThisStreet) return false;
    if (s.committedThisStreet !== currentBet) return false;
  }
  return true;
}

// Only one 'active' player left (rest folded or busted) → they win by fold.
function foldAround(seats) {
  const alive = inHandSeats(seats);
  return alive.length === 1;
}

module.exports = {
  DEFAULT_SETTINGS,
  newSeat,
  pickOpenSeat,
  nextDealerSeat,
  blindSeats,
  firstToActPreflop,
  firstToActPostflop,
  roundIsComplete,
  foldAround,
};
