'use strict';

// Seat helpers. Seats live on the game document as a `seats` map keyed
// by seat index (as a string). We normalize to numeric seat indices at
// the boundary.

function seatIndices(seats) {
  return Object.keys(seats || {}).map(k => parseInt(k, 10)).sort((a, b) => a - b);
}

function occupiedSeats(seats) {
  return seatIndices(seats).map(i => ({ seat: i, ...seats[i] }));
}

function livingSeats(seats) {
  return occupiedSeats(seats).filter(s => s.status !== 'busted' && s.status !== 'sitting_out');
}

function inHandSeats(seats) {
  return occupiedSeats(seats).filter(s =>
    s.status === 'active' || s.status === 'all_in'
  );
}

// Next occupied seat with status ∈ acceptedStatuses, walking clockwise
// starting *after* fromSeat. Returns -1 if none.
function nextSeatWithStatus(seats, fromSeat, acceptedStatuses, maxSeats) {
  const wanted = new Set(acceptedStatuses);
  for (let step = 1; step <= maxSeats; step++) {
    const idx = (fromSeat + step) % maxSeats;
    const s = seats[idx];
    if (s && wanted.has(s.status)) return idx;
  }
  return -1;
}

// First occupied seat, clockwise from `fromSeat` (inclusive), matching
// acceptedStatuses. Useful for "first active starting at SB post-flop".
function firstSeatWithStatusFrom(seats, fromSeat, acceptedStatuses, maxSeats) {
  const wanted = new Set(acceptedStatuses);
  for (let step = 0; step < maxSeats; step++) {
    const idx = (fromSeat + step) % maxSeats;
    const s = seats[idx];
    if (s && wanted.has(s.status)) return idx;
  }
  return -1;
}

function findSeatByUid(seats, uid) {
  for (const i of seatIndices(seats)) {
    if (seats[i].uid === uid) return i;
  }
  return -1;
}

function countBy(seats, predicate) {
  let n = 0;
  for (const i of seatIndices(seats)) if (predicate(seats[i])) n++;
  return n;
}

module.exports = {
  seatIndices,
  occupiedSeats,
  livingSeats,
  inHandSeats,
  nextSeatWithStatus,
  firstSeatWithStatusFrom,
  findSeatByUid,
  countBy,
};
