// Minimal UI for the secure online Hold'em client. Renders the public
// game state + your private hole cards. All game mutations flow through
// Cloud Functions.

import {
  waitForAuth, uid, createGame, joinGame, startHand, playerAction,
  leaveGame, watchGame, watchMyPrivate,
} from './holdem-net.js';

const $ = (id) => document.getElementById(id);
const state = {
  gameId: null,
  game: null,
  priv: null,
  unsubGame: null,
  unsubPriv: null,
};

function q(name) { return new URLSearchParams(location.search).get(name); }
function updateUrl() {
  const url = new URL(location.href);
  if (state.gameId) url.searchParams.set('game', state.gameId);
  else url.searchParams.delete('game');
  history.replaceState({}, '', url);
}

function suitSymbol(c) {
  return { s: '♠', h: '♥', d: '♦', c: '♣' }[c[1]] || '?';
}
function isRed(c) { return c[1] === 'h' || c[1] === 'd'; }
function cardEl(c) {
  const d = document.createElement('span');
  d.className = 'card' + (isRed(c) ? ' red' : '');
  d.textContent = c[0] + suitSymbol(c);
  return d;
}
function faceDown() {
  const d = document.createElement('span');
  d.className = 'card back';
  d.textContent = '🂠';
  return d;
}

function fmt(n) { return `$${n}`; }

function render() {
  const g = state.game;
  if (!g) return;
  $('gid').textContent = state.gameId;
  $('phase').textContent = g.phase;
  $('pot').textContent = fmt(g.pot);
  $('current-bet').textContent = fmt(g.currentBet);

  const cc = $('community');
  cc.innerHTML = '';
  (g.communityCards || []).forEach(c => cc.appendChild(cardEl(c)));

  const seatsEl = $('seats');
  seatsEl.innerHTML = '';
  const me = uid();
  Object.keys(g.seats).sort((a, b) => (+a) - (+b)).forEach(k => {
    const s = g.seats[k];
    const row = document.createElement('div');
    row.className = 'seat' + (parseInt(k, 10) === g.actionSeat ? ' action' : '');
    row.classList.add('status-' + s.status);
    const isMe = s.uid === me;
    const isDealer = parseInt(k, 10) === g.dealerSeat;
    row.innerHTML = `
      <div class="seat-head">
        <span class="seat-num">seat ${k}${isDealer ? ' • D' : ''}</span>
        <span class="seat-name">${s.displayName}${isMe ? ' (you)' : ''}</span>
        <span class="seat-status">${s.status}</span>
      </div>
      <div class="seat-body">
        <span>stack ${fmt(s.stack)}</span>
        ${s.committedThisStreet ? `<span>· bet ${fmt(s.committedThisStreet)}</span>` : ''}
      </div>
      <div class="seat-hole"></div>
    `;
    const holeEl = row.querySelector('.seat-hole');
    if (isMe && state.priv && state.priv.handNumber === g.handNumber && state.priv.holeCards) {
      state.priv.holeCards.forEach(c => holeEl.appendChild(cardEl(c)));
    } else if (g.showdown && g.showdown.revealed && g.showdown.revealed[s.uid]) {
      g.showdown.revealed[s.uid].forEach(c => holeEl.appendChild(cardEl(c)));
    } else if (s.status !== 'folded' && s.status !== 'busted' && s.status !== 'sitting_out') {
      holeEl.appendChild(faceDown());
      holeEl.appendChild(faceDown());
    }
    seatsEl.appendChild(row);
  });

  // Showdown summary
  const sd = $('showdown');
  if (g.showdown && g.showdown.winners && g.showdown.winners.length) {
    sd.style.display = '';
    sd.innerHTML = '<div><strong>Result</strong></div>' + g.showdown.winners.map(w => {
      const name = (g.seats[Object.keys(g.seats).find(k => g.seats[k].uid === w.uid)] || {}).displayName || w.uid;
      return `<div>${name} wins ${fmt(w.amount)} — ${w.handRank}</div>`;
    }).join('');
  } else {
    sd.style.display = 'none';
  }

  renderActions();
  renderHostControls();
}

function renderActions() {
  const g = state.game; if (!g) return;
  const btnBar = $('actions');
  btnBar.innerHTML = '';
  const myUid = uid();
  const mySeatIdx = Object.keys(g.seats).find(k => g.seats[k].uid === myUid);
  const isMyTurn = mySeatIdx !== undefined && parseInt(mySeatIdx, 10) === g.actionSeat && g.status === 'playing';
  if (!isMyTurn) { btnBar.textContent = ''; return; }
  const me = g.seats[mySeatIdx];
  const toCall = g.currentBet - me.committedThisStreet;

  const add = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); }
      catch (e) { alert(e.message || e); }
      finally { b.disabled = false; }
    };
    btnBar.appendChild(b);
  };

  add('Fold', () => playerAction(state.gameId, 'fold'));
  if (toCall === 0) add('Check', () => playerAction(state.gameId, 'check'));
  if (toCall > 0) add(`Call ${fmt(Math.min(toCall, me.stack))}`, () => playerAction(state.gameId, 'call'));

  if (g.currentBet === 0 && me.stack > 0) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = g.settings.bigBlind;
    inp.max = me.stack;
    inp.value = g.settings.bigBlind;
    btnBar.appendChild(inp);
    add('Bet', () => playerAction(state.gameId, 'bet', parseInt(inp.value, 10)));
  } else if (g.currentBet > 0 && me.stack > toCall) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = g.currentBet + g.minRaise;
    inp.max = me.stack + me.committedThisStreet;
    inp.value = Math.min(g.currentBet + g.minRaise, me.stack + me.committedThisStreet);
    btnBar.appendChild(inp);
    add('Raise to', () => playerAction(state.gameId, 'raise', parseInt(inp.value, 10)));
  }
  if (me.stack > 0) {
    add(`All-in ${fmt(me.stack)}`, () => playerAction(state.gameId, 'all_in'));
  }
}

function renderHostControls() {
  const g = state.game; if (!g) return;
  const el = $('host-controls');
  el.innerHTML = '';
  const isHost = g.hostUid === uid();
  const seated = Object.values(g.seats || {}).filter(s => s.stack > 0).length;
  if (!isHost) return;
  if (g.status === 'waiting' && seated >= 2) {
    const b = document.createElement('button');
    b.textContent = 'Deal first hand';
    b.onclick = () => startHand(state.gameId).catch(e => alert(e.message));
    el.appendChild(b);
  }
  if (g.phase === 'showdown' && g.status !== 'finished') {
    const b = document.createElement('button');
    b.textContent = 'Deal next hand';
    b.onclick = () => startHand(state.gameId).catch(e => alert(e.message));
    el.appendChild(b);
  }
}

async function ensureConnected(gameId) {
  if (state.unsubGame) state.unsubGame();
  if (state.unsubPriv) state.unsubPriv();
  state.gameId = gameId;
  updateUrl();
  state.unsubGame = watchGame(gameId, (g) => { state.game = g; render(); });
  state.unsubPriv = watchMyPrivate(gameId, (p) => { state.priv = p; render(); });
}

async function boot() {
  await waitForAuth();
  $('me').textContent = 'uid: ' + uid();
  const existing = q('game');
  if (existing) await ensureConnected(existing);
  $('btn-create').onclick = async () => {
    const name = $('name').value || 'host';
    try {
      const res = await createGame(name, {});
      await joinGame(res.gameId, name).catch(() => {});   // host is already seat 0
      await ensureConnected(res.gameId);
    } catch (e) { alert(e.message); }
  };
  $('btn-join').onclick = async () => {
    const gid = $('join-id').value.trim();
    const name = $('name').value || 'stranger';
    if (!gid) return;
    try {
      await joinGame(gid, name);
      await ensureConnected(gid);
    } catch (e) { alert(e.message); }
  };
  $('btn-leave').onclick = async () => {
    if (!state.gameId) return;
    try { await leaveGame(state.gameId); } catch (e) { alert(e.message); }
    if (state.unsubGame) state.unsubGame();
    if (state.unsubPriv) state.unsubPriv();
    state.gameId = null; state.game = null; state.priv = null;
    updateUrl();
    document.body.classList.remove('in-game');
  };
}

document.addEventListener('DOMContentLoaded', boot);
