import { createDeck, shuffleDeck, cardId, isRed, SUITS, RANKS } from './cards.js';
import { evaluateHand, HAND_NAMES, HAND_RANKS } from './hand-eval.js';
import { createGame, startHand, applyAction, getValidActions, isHandOver, isGameOver, getGameWinner, PHASES, BIG_BLIND, STARTING_CHIPS } from './engine.js';
import { getAIPersonalities, aiDecision } from './ai.js';
import { AVATARS, avatarMarkup, pickRandomAvatars } from './avatars.js';
import { initFirebase, createRoom, joinRoom, listenRoom, stopListening, setReady, pushGameState, startOnlineGame, pushAction, clearAction, getClientId, isHost } from './firebase.js';
import { recordWin, getLeaderboards } from './leaderboard.js';

let G = null;
let isOnline = false;
let roomCode = null;
let roomData = null;
let myClientId = null;
let seq = 0;
let pendingReveal = false;
let revealTimer = null;
let aiTimer = null;
let scored = false; // guard so a game's result is recorded to the boards once

// ── DOM helpers ──
const $ = id => document.getElementById(id);
const show = id => { $(id).classList.add('active'); };
const hide = id => { $(id).classList.remove('active'); };

function switchScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ── Poker chips ──
// Break an amount into denominated chips and render as overlapping stacks
// (top-down pile). `size` is 'sm' (seat bets) or 'lg' (central pot).
const CHIP_DENOMS = [[500, 'c500'], [100, 'c100'], [25, 'c25'], [5, 'c5'], [1, 'c1']];

function chipPileHtml(amount, size = 'sm') {
  let rem = Math.max(0, Math.round(amount));
  const chips = [];
  for (const [v, cls] of CHIP_DENOMS) {
    let n = Math.floor(rem / v);
    rem -= n * v;
    while (n-- > 0) chips.push(cls);
  }
  if (!chips.length) return '';
  const perStack = 5;
  const cols = [];
  for (let i = 0; i < chips.length; i += perStack) cols.push(chips.slice(i, i + perStack));
  return `<div class="chip-pile chip-${size}">` +
    cols.map(col => `<span class="chip-stack">` +
      col.map(c => `<span class="chip ${c}"></span>`).join('') +
    `</span>`).join('') +
  `</div>`;
}

// ── TITLE ──
window.showTitle = () => switchScreen('title-screen');
window.showSetup = () => {
  renderSetup();
  switchScreen('setup-screen');
};

// ── SETUP (single player) ──
let setupAICount = 4;
let setupAvatarId = AVATARS[0].id;

function renderSetup() {
  const grid = $('setup-grid');
  grid.innerHTML = '';
  const slider = document.createElement('div');
  slider.className = 'setup-row';
  slider.innerHTML = `
    <label class="setup-label">OPPONENTS</label>
    <div class="setup-slider-wrap">
      <input type="range" min="1" max="5" value="${setupAICount}" id="ai-count-slider" class="setup-slider">
      <span class="setup-slider-val" id="ai-count-val">${setupAICount}</span>
    </div>
  `;
  grid.appendChild(slider);
  $('ai-count-slider').oninput = e => {
    setupAICount = +e.target.value;
    $('ai-count-val').textContent = setupAICount;
  };

  const nameRow = document.createElement('div');
  nameRow.className = 'setup-row';
  nameRow.innerHTML = `
    <label class="setup-label">YOUR NAME</label>
    <input type="text" id="player-name" class="setup-input" value="Stranger" maxlength="16" placeholder="Enter your name...">
  `;
  grid.appendChild(nameRow);

  const avatarRow = document.createElement('div');
  avatarRow.className = 'setup-row setup-row-avatars';
  avatarRow.innerHTML = `
    <label class="setup-label">YOUR LOOK</label>
    ${avatarGalleryHtml(setupAvatarId)}
  `;
  grid.appendChild(avatarRow);
  wireAvatarGallery(avatarRow, id => { setupAvatarId = id; });
}

// Shared avatar picker (setup + online lobby).
function avatarGalleryHtml(selectedId) {
  return `<div class="avatar-gallery">
    ${AVATARS.map(a => `
      <button type="button" class="avatar-choice ${a.id === selectedId ? 'selected' : ''}" data-avatar="${a.id}" title="${a.label}">
        ${avatarMarkup(a, 'avatar-md')}
      </button>`).join('')}
  </div>`;
}

function wireAvatarGallery(container, onPick) {
  const gallery = container.querySelector('.avatar-gallery');
  if (!gallery) return;
  gallery.addEventListener('click', e => {
    const btn = e.target.closest('.avatar-choice');
    if (!btn) return;
    onPick(btn.dataset.avatar);
    gallery.querySelectorAll('.avatar-choice').forEach(b =>
      b.classList.toggle('selected', b === btn));
  });
}

window.startGame = () => {
  const name = ($('player-name')?.value || 'Stranger').trim() || 'Stranger';
  // Deal portraits first, then draw a same-gender handle for each AI seat.
  const aiAvatars = pickRandomAvatars(setupAICount, [setupAvatarId]);
  const aiPersonalities = getAIPersonalities(aiAvatars.map(a => a.gender));
  const players = [
    { name, isAI: false, avatar: setupAvatarId },
    ...aiAvatars.map((av, i) => ({
      name: aiPersonalities[i].name, isAI: true, personality: aiPersonalities[i], avatar: av.id,
    })),
  ];
  G = createGame(players);
  isOnline = false;
  scored = false;
  switchScreen('game-screen');
  beginHand();
};

// ── ONLINE ──
window.goOnline = () => {
  initFirebase();
  myClientId = getClientId();
  switchScreen('lobby-screen');
  renderLobbyMenu();
};

function renderLobbyMenu() {
  const body = $('lobby-body');
  body.innerHTML = `
    <div class="lobby-menu">
      <div class="lobby-row">
        <label class="setup-label">YOUR NAME</label>
        <input type="text" id="online-name" class="setup-input" value="Stranger" maxlength="16">
      </div>
      <div class="lobby-row setup-row-avatars">
        <label class="setup-label">YOUR LOOK</label>
        ${avatarGalleryHtml(setupAvatarId)}
      </div>
      <div class="lobby-buttons">
        <button class="btn btn-primary" onclick="window.hostGame()">🏠 HOST GAME</button>
        <button class="btn btn-secondary" onclick="window.showJoin()">🚪 JOIN GAME</button>
        <button class="btn btn-back" onclick="window.showTitle()">← BACK</button>
      </div>
      <div id="join-section" style="display:none;">
        <div class="lobby-row">
          <label class="setup-label">ROOM CODE</label>
          <input type="text" id="room-code-input" class="setup-input code-input" maxlength="4" placeholder="ABCD">
        </div>
        <button class="btn btn-primary" onclick="window.doJoin()">JOIN →</button>
      </div>
    </div>
  `;
  wireAvatarGallery(body, id => { setupAvatarId = id; });
}

window.showJoin = () => {
  $('join-section').style.display = 'block';
};

window.hostGame = async () => {
  const name = ($('online-name')?.value || 'Stranger').trim() || 'Stranger';
  try {
    roomCode = await createRoom(name, setupAvatarId);
    listenRoom(onRoomUpdate);
    renderLobbyRoom();
  } catch (e) {
    alert('Error creating room: ' + e.message);
  }
};

window.doJoin = async () => {
  const name = ($('online-name')?.value || 'Stranger').trim() || 'Stranger';
  const code = ($('room-code-input')?.value || '').trim().toUpperCase();
  if (code.length !== 4) { alert('Enter a 4-letter room code'); return; }
  try {
    roomCode = code;
    await joinRoom(code, name, setupAvatarId);
    listenRoom(onRoomUpdate);
    renderLobbyRoom();
  } catch (e) {
    alert(e.message);
  }
};

function renderLobbyRoom() {
  const body = $('lobby-body');
  const rd = roomData || {};
  const players = rd.players || {};
  const playerList = Object.entries(players);
  const amHost = rd.host === myClientId;

  body.innerHTML = `
    <div class="lobby-room">
      <div class="room-code-display">Room: <span class="room-code">${roomCode}</span></div>
      <div class="player-list">
        <div class="lobby-label">PLAYERS AT THE TABLE</div>
        ${playerList.map(([cid, p]) => `
          <div class="lobby-player ${p.ready ? 'ready' : ''}">
            ${avatarMarkup(p.avatar, 'avatar-sm')}
            <span class="lobby-player-name">${p.name}${cid === rd.host ? ' ★' : ''}</span>
            <span class="lobby-player-status">${p.ready ? '✓ READY' : 'WAITING'}</span>
          </div>
        `).join('')}
      </div>
      <div class="lobby-actions">
        ${!players[myClientId]?.ready ?
          `<button class="btn btn-primary" onclick="window.markReady()">✋ I'M READY</button>` :
          `<div class="ready-badge">YOU'RE READY</div>`
        }
        ${amHost && playerList.length >= 2 && playerList.every(([,p]) => p.ready) ?
          `<button class="btn btn-primary" onclick="window.launchOnline()">🎰 DEAL 'EM!</button>` : ''
        }
      </div>
      <div class="lobby-hint">${amHost ? 'Share the room code with your posse.' : 'Waiting for the host to start...'}</div>
    </div>
  `;
}

window.markReady = () => setReady(true);

window.launchOnline = async () => {
  const rd = roomData;
  const entries = Object.entries(rd.players || {});
  const players = entries.map(([cid, p], i) => ({
    name: p.name,
    isAI: false,
    avatar: p.avatar || null,
    clientId: cid,
    seatIndex: i,
  }));
  G = createGame(players);
  G.clientMap = {};
  entries.forEach(([cid], i) => { G.clientMap[cid] = i; });
  G = startHand(G);
  isOnline = true;
  scored = false;
  seq++;
  await startOnlineGame();
  await pushGameState(G, seq);
};

function onRoomUpdate(data) {
  roomData = data;
  if (!data) return;

  if (data.started && data.state) {
    const parsed = typeof data.state === 'string' ? JSON.parse(data.state) : data.state;
    if (data.seq > seq || !G) {
      seq = data.seq || 0;
      G = parsed;
      isOnline = true;
      switchScreen('game-screen');
      renderGame();
      if (isGameOver(G)) showGameOver();
      else checkAITurn();
    }
  } else if (!data.started) {
    renderLobbyRoom();
  }

  if (data.pendingAction && data.pendingAction.from !== myClientId && G) {
    const action = data.pendingAction;
    if (isHost(data)) {
      G = applyAction(G, action);
      seq++;
      clearAction();
      pushGameState(G, seq);
      renderGame();
      checkAITurn();
    }
  }
}

// ── GAME FLOW ──
function beginHand() {
  G = startHand(G);
  pendingReveal = false;
  renderGame();
  logMsg(`─── Hand #${G.roundNum} ───`);
  setTimeout(() => checkAITurn(), 400);
}

function checkAITurn() {
  if (!G || isHandOver(G)) return;
  const player = G.players[G.activeIndex];
  if (!player) return;

  if (isOnline) {
    const mySeat = G.clientMap?.[myClientId];
    if (G.activeIndex !== mySeat) return;
    renderGame();
    return;
  }

  if (player.isAI) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      const decision = aiDecision(player, {
        communityCards: G.communityCards,
        pot: G.pot,
        currentBet: G.currentBet,
        minRaise: G.minRaise,
      });

      if (decision.action === 'raise') {
        const raiseTotal = G.currentBet + decision.amount;
        G = applyAction(G, { action: 'raise', amount: raiseTotal });
      } else {
        G = applyAction(G, decision);
      }

      renderGame();

      if (isHandOver(G)) {
        showHandResult();
      } else {
        checkAITurn();
      }
    }, 4500 + Math.random() * 1000);
  }
}

function showHandResult() {
  // Stay on the finished hand so the player can review it; advancing happens
  // only when they click "NEXT HAND" (window.continueGame).
  pendingReveal = true;
  clearTimeout(revealTimer);
  renderGame();
}

function showGameOver() {
  const winner = getGameWinner(G);
  $('winner-name').textContent = winner.name;
  $('winner-chips').textContent = `$${winner.chips}`;
  recordWinIfMine(winner);
  show('gameover-overlay');
}

// Record this game's result to the boards — but only my own human win, so
// each finished game is counted exactly once (humans only, net profit).
function recordWinIfMine(winner) {
  if (scored) return;
  scored = true;
  if (!winner) return;
  const mine = isOnline ? (G.clientMap?.[myClientId] === winner.id) : !winner.isAI;
  const net = winner.chips - STARTING_CHIPS;
  if (mine && net > 0) recordWin(winner.name, net);
}

window.playAgain = () => {
  hide('gameover-overlay');
  switchScreen('title-screen');
};

// ── LEADERBOARDS (Top Guns) ──
window.showLeaderboard = () => {
  switchScreen('leaderboard-screen');
  const { daily, lifetime } = getLeaderboards();
  renderBoard('daily-board', daily);
  renderBoard('lifetime-board', lifetime);
};

function renderBoard(id, entries) {
  const el = $(id);
  if (!entries.length) {
    el.innerHTML = '<li class="board-empty">No winners yet — be the first.</li>';
    return;
  }
  el.innerHTML = entries.map((e, i) => `
    <li class="board-row">
      <span class="board-rank">${i + 1}</span>
      <span class="board-name">${escapeHtml(e.name || 'Stranger')}</span>
      <span class="board-win">$${(e.winnings || 0).toLocaleString()}</span>
    </li>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.continueGame = () => {
  clearTimeout(revealTimer);
  if (isGameOver(G)) {
    showGameOver();
  } else {
    beginHand();
  }
};

// ── PLAYER ACTIONS ──
window.doFold = () => playerAct({ action: 'fold' });
window.doCheck = () => playerAct({ action: 'check' });
window.doCall = () => playerAct({ action: 'call' });
window.doAllIn = () => playerAct({ action: 'all-in' });

window.doRaise = () => {
  const slider = $('raise-slider');
  const amount = +slider.value;
  playerAct({ action: 'raise', amount });
};

function playerAct(action) {
  if (!G || isHandOver(G)) return;
  const player = G.players[G.activeIndex];
  if (player.isAI) return;

  if (isOnline) {
    pushAction(action);
    return;
  }

  G = applyAction(G, action);
  renderGame();

  if (isHandOver(G)) {
    showHandResult();
  } else {
    checkAITurn();
  }
}

// ── RENDER ──
function renderGame() {
  if (!G) return;
  renderCommunity();
  renderPlayers();
  renderPot();
  renderActions();
  renderLog();
}

// Real-card face: rank+suit indices in opposite corners, a large center
// pip for number cards (and aces), a big letter for face cards.
const FACE_RANKS = ['J', 'Q', 'K'];
function cardFaceHtml(card) {
  const corner = `<span class="cc-rank">${card.rank}</span><span class="cc-suit">${card.suit}</span>`;
  const center = FACE_RANKS.includes(card.rank)
    ? `<span class="card-center card-face-letter">${card.rank}</span>`
    : `<span class="card-center card-pip">${card.suit}</span>`;
  return `<span class="card-corner tl">${corner}</span>${center}<span class="card-corner br">${corner}</span>`;
}

function renderCommunity() {
  const area = $('community-cards');
  area.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const card = G.communityCards[i];
    const el = document.createElement('div');
    if (card) {
      el.className = `card ${isRed(card) ? 'red' : 'black'}`;
      el.innerHTML = cardFaceHtml(card);
    } else {
      el.className = 'card card-placeholder';
      el.innerHTML = '<span class="card-back">🂠</span>';
    }
    area.appendChild(el);
  }
}

function renderPlayers() {
  const area = $('players-area');
  area.innerHTML = '';

  const myIndex = isOnline ? (G.clientMap?.[myClientId] ?? 0) : 0;

  G.players.forEach((p, i) => {
    const isMe = isOnline ? (G.clientMap?.[myClientId] === i) : !p.isAI;
    const isActive = G.activeIndex === i && !isHandOver(G);
    const showCards = isMe || (isHandOver(G) && pendingReveal && !p.folded);

    const seat = document.createElement('div');
    seat.className = `player-seat ${p.folded ? 'folded' : ''} ${isActive ? 'active-player' : ''} ${p.chips <= 0 && p.hand.length === 0 ? 'busted' : ''}`;

    const dealerMark = G.dealerIndex === i ? '<span class="dealer-chip">D</span>' : '';

    let cardsHtml = '';
    if (p.hand.length === 2) {
      if (showCards) {
        cardsHtml = p.hand.map(c =>
          `<div class="card card-small ${isRed(c) ? 'red' : 'black'}">${cardFaceHtml(c)}</div>`
        ).join('');
      } else {
        cardsHtml = `<div class="card card-small card-facedown"></div><div class="card card-small card-facedown"></div>`;
      }
    }

    let handLabel = '';
    if (showCards && isMe && G.communityCards.length > 0 && p.hand.length === 2 && !p.folded) {
      const eval_ = evaluateHand(p.hand, G.communityCards);
      handLabel = `<div class="hand-label">${eval_.name}</div>`;
    }
    if (showCards && !isMe && pendingReveal && p.hand.length === 2 && !p.folded && G.communityCards.length > 0) {
      const eval_ = evaluateHand(p.hand, G.communityCards);
      handLabel = `<div class="hand-label">${eval_.name}</div>`;
    }

    const winnerInfo = G.winners?.find(w => w.player.id === p.id);
    const winBadge = winnerInfo ? `<div class="win-badge">WON $${winnerInfo.amount}</div>` : '';

    seat.innerHTML = `
      <div class="player-avatar-wrap">${avatarMarkup(p.avatar, 'avatar-seat')}</div>
      <div class="player-info">
        <div class="player-name">${p.name} ${dealerMark}</div>
        <div class="player-chips">$${p.chips}${p.allIn ? ' ALL IN' : ''}</div>
        ${p.currentBet > 0 ? `<div class="player-bet">${chipPileHtml(p.currentBet, 'sm')}<span class="bet-amt">$${p.currentBet}</span></div>` : ''}
      </div>
      <div class="player-cards">${cardsHtml}</div>
      ${handLabel}
      ${winBadge}
      ${p.folded ? '<div class="fold-label">FOLDED</div>' : ''}
    `;
    area.appendChild(seat);
  });
}

function renderPot() {
  $('pot-display').textContent = `POT: $${G.pot}`;
  const phase = G.phase === 'showdown' ? 'SHOWDOWN' : G.phase.toUpperCase();
  $('phase-display').textContent = `${phase} · HAND #${G.roundNum}`;

  const pile = $('pot-pile');
  if (pile) {
    pile.innerHTML = G.pot > 0
      ? `${chipPileHtml(G.pot, 'lg')}<div class="pot-amt">POT&nbsp;$${G.pot}</div>`
      : '';
  }
}

function renderActions() {
  const panel = $('action-buttons');
  panel.innerHTML = '';

  if (isHandOver(G)) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = isGameOver(G) ? 'SEE RESULTS' : 'NEXT HAND →';
    btn.onclick = window.continueGame;
    panel.appendChild(btn);
    return;
  }

  // The betting menu stays put: it's shown for the human every turn and just
  // disabled (greyed) while we wait on someone else — never removed.
  const mySeat = isOnline ? (G.clientMap?.[myClientId] ?? 0) : G.players.findIndex(p => !p.isAI);
  const me = G.players[mySeat];
  const activePlayer = G.players[G.activeIndex];
  const myTurn = !!me && G.activeIndex === mySeat && !me.folded && !me.allIn;

  const hint = document.createElement('div');
  hint.className = 'turn-hint' + (myTurn ? ' your-move' : '');
  hint.textContent = myTurn ? 'YOUR MOVE'
    : me?.folded ? 'You folded — waiting…'
    : `Waiting for ${activePlayer?.name || '…'}…`;
  panel.appendChild(hint);

  if (!me || me.folded || me.allIn || me.chips <= 0) return;

  const toCall = Math.max(0, G.currentBet - me.currentBet);
  const validList = myTurn ? getValidActions(G) : null;
  const can = a => myTurn ? validList.includes(a) : inferAction(a, me, toCall);
  const dis = !myTurn;

  const addBtn = (cls, label, onclick) => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + cls;
    btn.textContent = label;
    if (dis) btn.disabled = true; else btn.onclick = onclick;
    panel.appendChild(btn);
  };

  if (can('fold')) addBtn('btn-danger', 'FOLD', window.doFold);
  if (can('check')) addBtn('btn-secondary', 'CHECK', window.doCheck);
  if (can('call')) addBtn('btn-primary', `CALL $${toCall}`, window.doCall);

  if (can('raise')) {
    const minTotal = G.currentBet + G.minRaise;
    const maxTotal = me.currentBet + me.chips;
    const da = dis ? 'disabled' : '';

    // Quick-bet chips ($50/$100/… increments) so the player isn't nudging the slider.
    const increments = [50, 100, 150, 250].filter(a => minTotal + a <= maxTotal);

    const raiseWrap = document.createElement('div');
    raiseWrap.className = 'raise-controls';
    raiseWrap.innerHTML = `
      <div class="raise-quick" id="raise-quick">
        <button class="btn-chip" data-set="${minTotal}" ${da}>MIN</button>
        ${increments.map(a => `<button class="btn-chip" data-add="${a}" ${da}>+$${a}</button>`).join('')}
        <button class="btn-chip" data-set="${maxTotal}" ${da}>MAX</button>
      </div>
      <div class="raise-row">
        <input type="range" id="raise-slider" class="raise-slider" min="${minTotal}" max="${maxTotal}" value="${minTotal}" step="${BIG_BLIND}" ${da}>
        <span class="raise-val" id="raise-val">$${minTotal}</span>
        <button class="btn btn-primary" ${dis ? 'disabled' : 'onclick="window.doRaise()"'}>RAISE</button>
      </div>
    `;
    panel.appendChild(raiseWrap);

    if (!dis) {
      setTimeout(() => {
        const slider = $('raise-slider');
        const quick = $('raise-quick');
        if (!slider) return;
        const setVal = v => {
          slider.value = Math.max(minTotal, Math.min(maxTotal, v));
          $('raise-val').textContent = `$${slider.value}`;
        };
        slider.oninput = () => { $('raise-val').textContent = `$${slider.value}`; };
        quick.onclick = e => {
          const btn = e.target.closest('button');
          if (!btn) return;
          if (btn.dataset.set != null) setVal(+btn.dataset.set);
          else if (btn.dataset.add != null) setVal(+slider.value + +btn.dataset.add);
        };
      }, 0);
    }
  }

  if (can('all-in')) addBtn('btn-allin', `ALL IN $${me.chips}`, window.doAllIn);
}

// Which actions to *show* (disabled) for the human while it's not their turn.
function inferAction(a, me, toCall) {
  switch (a) {
    case 'fold': return true;
    case 'check': return toCall === 0;
    case 'call': return toCall > 0;
    case 'raise': return me.chips > toCall;
    case 'all-in': return me.chips > 0;
    default: return false;
  }
}

function renderLog() {
  const log = $('game-log');
  if (!log) return;
  const recent = G.log.slice(-8);
  log.innerHTML = recent.map(entry => {
    if (entry.type === 'blind') {
      return `<div class="log-entry log-blind">${entry.player} posts ${entry.kind} blind $${entry.amount}</div>`;
    }
    if (entry.type === 'action') {
      const amt = entry.amount ? ` $${entry.amount}` : '';
      return `<div class="log-entry log-action">${entry.player}: ${entry.action}${amt}</div>`;
    }
    if (entry.type === 'phase') {
      return `<div class="log-entry log-phase">── ${entry.phase.toUpperCase()} ──</div>`;
    }
    if (entry.type === 'win') {
      return `<div class="log-entry log-win">🏆 ${entry.player} wins $${entry.amount} with ${entry.hand}</div>`;
    }
    return '';
  }).join('');
  log.scrollTop = log.scrollHeight;
}

function logMsg(text) {
  const log = $('game-log');
  if (!log) return;
  const div = document.createElement('div');
  div.className = 'log-entry log-system';
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ── INIT ──
renderSetup();
