'use strict';

const { bestOf } = require('./eval');
const { buildPots } = require('./sidepots');
const { seatIndices, inHandSeats } = require('./seats');

// Award pots given full information. `hands` is a map uid → holeCards[].
// `game.seats` may have some players with status 'folded' — they still
// contributed to the pot but can't win any of it.
//
// Returns { updatedSeats, winners: [{uid, amount, handRank}], revealed }
// where updatedSeats has stack additions applied and the pot has been
// paid out. Odd-chip pots go to the earliest seat left of the dealer
// (per convention).
function resolveShowdown(game, hands) {
  const seats = { ...game.seats };
  // Convert seats map to array of contestants for pot construction.
  const contestants = [];
  for (const k of seatIndices(seats)) {
    const s = seats[k];
    if (!s || s.committedThisHand === 0) continue;
    contestants.push({
      uid: s.uid,
      seat: k,
      committedThisHand: s.committedThisHand,
      folded: s.status === 'folded',
    });
  }
  const pots = buildPots(contestants);

  const winners = [];
  const community = game.communityCards || [];

  for (const pot of pots) {
    // Eligible players who reached showdown (didn't fold) AND have hole cards.
    const contenders = pot.eligibleUids
      .filter(uid => hands[uid])
      .map(uid => ({ uid, holeCards: hands[uid], community }));
    if (contenders.length === 0) continue;   // pot returns to no one (shouldn't happen in real play)

    let potWinners;
    if (contenders.length === 1) {
      // Everyone else folded relative to this side pot.
      potWinners = [{ entry: contenders[0], hand: null }];
    } else {
      potWinners = bestOf(contenders);
    }

    const perWinner = Math.floor(pot.amount / potWinners.length);
    let remainder = pot.amount - perWinner * potWinners.length;
    // Distribute odd chips clockwise from the seat left of the dealer.
    const dealerSeat = game.dealerSeat;
    const maxSeats = game.settings.maxPlayers;
    const orderedWinnerUids = [];
    for (let step = 1; step <= maxSeats && orderedWinnerUids.length < potWinners.length; step++) {
      const idx = (dealerSeat + step) % maxSeats;
      const seat = seats[idx];
      if (!seat) continue;
      const winner = potWinners.find(w => w.entry.uid === seat.uid);
      if (winner && !orderedWinnerUids.includes(winner.entry.uid)) {
        orderedWinnerUids.push(winner.entry.uid);
      }
    }

    for (const uid of orderedWinnerUids) {
      const winner = potWinners.find(w => w.entry.uid === uid);
      let amount = perWinner;
      if (remainder > 0) { amount += 1; remainder -= 1; }
      const seat = Object.values(seats).find(s => s && s.uid === uid);
      if (seat) seat.stack += amount;
      winners.push({
        uid,
        amount,
        handRank: winner.hand ? winner.hand.descr : 'Uncontested',
      });
    }
  }

  // At showdown, reveal every non-folded player's cards. Folded players
  // stay hidden.
  const revealed = {};
  for (const uid of Object.keys(hands)) {
    const seat = Object.values(seats).find(s => s && s.uid === uid);
    if (seat && seat.status !== 'folded') revealed[uid] = hands[uid];
  }

  return { updatedSeats: seats, winners, revealed };
}

// Award pot when only one active player remains — no cards revealed.
function resolveFoldAround(game) {
  const seats = { ...game.seats };
  const contestants = [];
  for (const k of seatIndices(seats)) {
    const s = seats[k];
    if (!s || s.committedThisHand === 0) continue;
    contestants.push({
      uid: s.uid, seat: k,
      committedThisHand: s.committedThisHand,
      folded: s.status === 'folded',
    });
  }
  const pots = buildPots(contestants);
  const winners = [];
  const alive = inHandSeats(seats);
  if (alive.length !== 1) return { updatedSeats: seats, winners, revealed: {} };
  // alive[0] is a spread copy — mutate the underlying seat ref, not the copy.
  const winnerRef = seats[alive[0].seat];
  for (const pot of pots) {
    if (!pot.eligibleUids.includes(winnerRef.uid)) continue;   // side pot returns to contributors if winner isn't eligible; shouldn't happen mid-fold
    winnerRef.stack += pot.amount;
    winners.push({ uid: winnerRef.uid, amount: pot.amount, handRank: 'Uncontested' });
  }
  return { updatedSeats: seats, winners, revealed: {} };
}

module.exports = { resolveShowdown, resolveFoldAround };
