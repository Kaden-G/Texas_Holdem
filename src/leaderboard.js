// ── Leaderboards (local storage) ──
// Saves Daily Winners + Lifetime Leaders in the browser so the boards work
// without any backend. Tracks human players only, by net profit.
// (A global Firebase version lives in firebase.js for when that's set up.)

const KEY = 'deadhand_leaderboard_v1';
const MAX_DAYS = 14; // prune old daily buckets

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || { daily: {}, lifetime: {} };
  } catch {
    return { daily: {}, lifetime: {} };
  }
}

function save(data) {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* ignore */ }
}

function todayKey() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function keyOf(name) {
  return (name || 'stranger').toLowerCase().trim().slice(0, 40) || 'stranger';
}

// Add a human player's win (net profit) to today's board and the all-time board.
export function recordWin(name, winnings) {
  if (!(winnings > 0)) return;
  const data = load();
  const day = todayKey();
  data.daily = data.daily || {};
  data.lifetime = data.lifetime || {};
  data.daily[day] = data.daily[day] || {};

  const bump = bucket => {
    const k = keyOf(name);
    bucket[k] = bucket[k] || { name, winnings: 0, wins: 0 };
    bucket[k].name = name;
    bucket[k].winnings += winnings;
    bucket[k].wins += 1;
  };
  bump(data.daily[day]);
  bump(data.lifetime);

  const days = Object.keys(data.daily).sort();
  while (days.length > MAX_DAYS) delete data.daily[days.shift()];

  save(data);
}

// Top 10 for today and all-time, each high→low by winnings.
export function getLeaderboards() {
  const data = load();
  const day = todayKey();
  const toArr = obj => Object.values(obj || {})
    .sort((a, b) => (b.winnings || 0) - (a.winnings || 0))
    .slice(0, 10);
  return { daily: toArr(data.daily?.[day]), lifetime: toArr(data.lifetime) };
}
