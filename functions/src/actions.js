'use strict';

// Pure functions that validate + apply a player action to an in-memory
// game snapshot. No Firestore access here — the callable in index.js
// runs these inside a transaction.

const {
  nextSeatWithStatus, firstSeatWithStatusFrom, inHandSeats, seatIndices, findSeatByUid,
} = require('./seats');
const {
  roundIsComplete, foldAround, firstToActPostflop,
} = require('./game');

const ACTIONS = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in']);

class ActionError extends Error {
  constructor(message, code = 'invalid-argument') { super(message); this.code = code; }
}

function validateAndApply(game, actorUid, action, amount) {
  if (!ACTIONS.has(action)) throw new ActionError(`Unknown action: ${action}`);
  if (game.status !== 'playing') throw new ActionError('Game is not in playing state', 'failed-precondition');
  if (!['preflop', 'flop', 'turn', 'river'].includes(game.phase)) {
    throw new ActionError(`No betting in phase ${game.phase}`, 'failed-precondition');
  }

  const seatIdx = findSeatByUid(game.seats, actorUid);
  if (seatIdx === -1) throw new ActionError('Not seated in this game', 'permission-denied');
  if (seatIdx !== game.actionSeat) throw new ActionError('Not your turn', 'failed-precondition');

  const seat = game.seats[seatIdx];
  if (seat.status !== 'active') throw new ActionError(`Cannot act with status ${seat.status}`, 'failed-precondition');

  const toCall = game.currentBet - seat.committedThisStreet;

  switch (action) {
    case 'fold':
      seat.status = 'folded';
      seat.hasActedThisStreet = true;
      break;

    case 'check':
      if (toCall !== 0) throw new ActionError('Cannot check — there is a bet to call');
      seat.hasActedThisStreet = true;
      break;

    case 'call': {
      if (toCall <= 0) throw new ActionError('Nothing to call — use check');
      const pay = Math.min(toCall, seat.stack);
      seat.stack -= pay;
      seat.committedThisStreet += pay;
      seat.committedThisHand += pay;
      seat.hasActedThisStreet = true;
      if (seat.stack === 0) seat.status = 'all_in';
      break;
    }

    case 'bet': {
      if (game.currentBet !== 0) throw new ActionError('Cannot bet — there is already a bet; use raise');
      const size = amount | 0;
      if (size < game.settings.bigBlind && size < seat.stack) {
        throw new ActionError(`Bet must be at least the big blind (${game.settings.bigBlind})`);
      }
      const pay = Math.min(size, seat.stack);
      seat.stack -= pay;
      seat.committedThisStreet += pay;
      seat.committedThisHand += pay;
      game.currentBet = seat.committedThisStreet;
      game.minRaise = Math.max(game.settings.bigBlind, seat.committedThisStreet);
      resetOthersActedFlag(game.seats, seatIdx);
      seat.hasActedThisStreet = true;
      if (seat.stack === 0) seat.status = 'all_in';
      break;
    }

    case 'raise': {
      if (game.currentBet === 0) throw new ActionError('Cannot raise — no bet to raise; use bet');
      // amount is the TOTAL commitment for this street after the raise.
      const totalTarget = amount | 0;
      const raiseIncrement = totalTarget - game.currentBet;
      const chipsIn = totalTarget - seat.committedThisStreet;
      if (chipsIn <= 0) throw new ActionError('Raise must exceed current commitment');
      if (chipsIn > seat.stack) throw new ActionError('Not enough chips to raise that much');
      const isAllIn = chipsIn === seat.stack;
      if (!isAllIn && raiseIncrement < game.minRaise) {
        throw new ActionError(`Raise increment must be at least ${game.minRaise}`);
      }
      seat.stack -= chipsIn;
      seat.committedThisStreet = totalTarget;
      seat.committedThisHand += chipsIn;
      const fullSize = raiseIncrement >= game.minRaise;
      game.currentBet = totalTarget;
      if (fullSize) {
        game.minRaise = raiseIncrement;
        resetOthersActedFlag(game.seats, seatIdx);
      }
      // Undersize all-in raise: currentBet still updates so shorter stacks
      // must call the extra, but we do NOT reopen the action to players
      // who already acted with a full-size aggressor between them.
      // (V1: we still reset acted flag on undersize too for simplicity.)
      else {
        resetOthersActedFlag(game.seats, seatIdx);
      }
      seat.hasActedThisStreet = true;
      if (seat.stack === 0) seat.status = 'all_in';
      break;
    }

    case 'all_in': {
      const chipsIn = seat.stack;
      if (chipsIn <= 0) throw new ActionError('No chips to go all-in with');
      const newCommitted = seat.committedThisStreet + chipsIn;
      seat.stack = 0;
      seat.committedThisStreet = newCommitted;
      seat.committedThisHand += chipsIn;
      if (newCommitted > game.currentBet) {
        const raiseIncrement = newCommitted - game.currentBet;
        game.currentBet = newCommitted;
        if (raiseIncrement >= game.minRaise) {
          game.minRaise = raiseIncrement;
        }
        resetOthersActedFlag(game.seats, seatIdx);
      }
      seat.hasActedThisStreet = true;
      seat.status = 'all_in';
      break;
    }
  }

  game.lastAction = { uid: actorUid, type: action, amount: amount || 0 };
  return game;
}

// After an aggressive action, other in-hand active players need to act
// again. Mark them hasActedThisStreet = false.
function resetOthersActedFlag(seats, actorSeatIdx) {
  for (const k of seatIndices(seats)) {
    if (k === actorSeatIdx) continue;
    const s = seats[k];
    if (s.status === 'active') s.hasActedThisStreet = false;
  }
}

// Called after each action to advance actionSeat to the next 'active'
// player, if the round is not yet complete.
function advanceActionSeat(game) {
  const maxSeats = game.settings.maxPlayers;
  const nextIdx = nextSeatWithStatus(game.seats, game.actionSeat, ['active'], maxSeats);
  if (nextIdx === -1) return -1;   // no active players left
  game.actionSeat = nextIdx;
  return nextIdx;
}

// Reset per-street state, ready for the next street. `firstToActSeat`
// tells us who leads off; if -1 (nobody active), the caller should skip
// betting and go straight to the next street.
function beginStreet(game, phase, firstToActSeat) {
  game.phase = phase;
  game.currentBet = 0;
  game.minRaise = game.settings.bigBlind;
  for (const k of seatIndices(game.seats)) {
    const s = game.seats[k];
    s.committedThisStreet = 0;
    if (s.status === 'active') s.hasActedThisStreet = false;
  }
  game.actionSeat = firstToActSeat;
}

module.exports = {
  ActionError,
  validateAndApply,
  advanceActionSeat,
  beginStreet,
  ACTIONS,
};
