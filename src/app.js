import { createDeck, shuffleDeck, cardId, isRed, SUITS, RANKS, RANK_VALUES } from './cards.js';
import { evaluateHand, HAND_NAMES, HAND_RANKS, describeHand } from './hand-eval.js';
import { createGame, startHand, applyAction, getValidActions, isHandOver, isGameOver, getGameWinner, PHASES, BIG_BLIND, STARTING_CHIPS, BLIND_LEVELS, LEVEL_SECONDS } from './engine.js';
import { getAIPersonalities, aiDecision, personalityFromStyle, tablePosition } from './ai.js';
import { AVATARS, avatarMarkup, pickRandomAvatars } from './avatars.js';
import { DECKS, deckById } from './decks.js';
import { recordWin, getLeaderboards } from './leaderboard.js';
import * as Online from './online.js';
import { STATIC_ODDS, computeMyOdds, fmtPct } from './odds.js';

let G = null;
let pendingReveal = false;
let revealTimer = null;
let aiTimer = null;
let scored = false; // guard so a game's result is recorded to the boards once
let gameStart = 0;  // wall-clock start of the current game (for blind escalation)
let blindLevel = 0;

// ── Online mode state ──
let mode = 'single';                 // 'single' | 'online'
let onlineGameId = null;
let onlineCode = null;
let onlineDoc = null;                // latest snapshot of the Firestore game doc
let onlineMyHand = null;             // { holeCards: [str,str], handNumber }
let onlineAiHands = {};              // { [seatIdx]: { holeCards, handNumber } }
let onlineMyUid = null;              // populated after auth
let onlineIsHost = false;
let unsubGame = null;
let unsubMyHand = null;
let unsubAiHands = null;
let onlineAiTimer = null;
let onlineAiInFlight = false;         // guard against re-entrancy on snapshot bursts

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
window.showTitle = () => {
  teardownOnline();
  mode = 'single';
  switchScreen('title-screen');
};
window.showSetup = () => {
  mode = 'single';
  renderSetup();
  switchScreen('setup-screen');
};
window.showOnlineSetup = () => {
  mode = 'online';
  renderSetup();
  switchScreen('setup-screen');
};

function teardownOnline() {
  if (unsubGame) { try { unsubGame(); } catch (_) {} unsubGame = null; }
  if (unsubMyHand) { try { unsubMyHand(); } catch (_) {} unsubMyHand = null; }
  if (unsubAiHands) { try { unsubAiHands(); } catch (_) {} unsubAiHands = null; }
  clearTimeout(onlineAiTimer);
  onlineAiTimer = null;
  onlineAiInFlight = false;
  onlineGameId = null;
  onlineCode = null;
  onlineDoc = null;
  onlineMyHand = null;
  onlineAiHands = {};
  onlineIsHost = false;
  onlineLog = [];
  onlinePrevDoc = null;
}

// ── Saloon Talk log for online mode ──
// Server publishes `lastAction`, phase transitions, showdown winners, etc.
// on every game doc update; we diff consecutive snapshots and append log
// entries in the same shape single-player uses so renderLog() renders both
// modes identically.
let onlineLog = [];
let onlinePrevDoc = null;

const _ACTION_LABEL = {
  fold: 'folds',
  check: 'checks',
  call: 'calls',
  bet: 'bets',
  raise: 'raises to',
  all_in: 'goes all-in',
};

function _nameForUid(doc, uid) {
  if (!doc || !doc.seats || !uid) return 'stranger';
  for (const k of Object.keys(doc.seats)) {
    if (doc.seats[k].uid === uid) return doc.seats[k].displayName || 'stranger';
  }
  return 'stranger';
}

function deriveOnlineLog(prev, next) {
  if (!next) return;

  // New hand: banner + blinds.
  const prevHand = prev?.handNumber || 0;
  if (next.handNumber && next.handNumber !== prevHand) {
    onlineLog.push({ type: 'phase', phase: `HAND #${next.handNumber}` });
    const sb = next.settings?.smallBlind || 10;
    const bb = next.settings?.bigBlind || 20;
    const seats = next.seats || {};
    // Walk seats clockwise from dealer to emit SB before BB.
    const dealer = next.dealerSeat ?? 0;
    const maxSeats = next.settings?.maxPlayers || 6;
    for (let step = 1; step <= maxSeats; step++) {
      const idx = (dealer + step) % maxSeats;
      const s = seats[idx];
      if (!s) continue;
      const c = s.committedThisStreet || 0;
      if (c === sb) onlineLog.push({ type: 'blind', player: s.displayName, kind: 'small', amount: sb });
      else if (c === bb) onlineLog.push({ type: 'blind', player: s.displayName, kind: 'big', amount: bb });
    }
    onlinePrevDoc = next;
    return;
  }

  // Phase change → banner.
  if (prev && prev.phase !== next.phase && ['flop', 'turn', 'river'].includes(next.phase)) {
    onlineLog.push({ type: 'phase', phase: next.phase });
  }

  // Player action (skip 'system' / 'deal').
  const la = next.lastAction;
  const pa = prev?.lastAction;
  if (la && la.uid && la.uid !== 'system' && la.type) {
    const changed = !pa || pa.uid !== la.uid || pa.type !== la.type || (pa.amount || 0) !== (la.amount || 0);
    if (changed) {
      const name = _nameForUid(next, la.uid);
      const action = _ACTION_LABEL[la.type] || la.type;
      const amount = ['bet', 'raise', 'all_in'].includes(la.type) ? (la.amount || 0) : 0;
      onlineLog.push({ type: 'action', player: name, action, amount });
    }
  }

  // Winners: appeared on this snapshot.
  const prevWin = prev?.showdown?.winners;
  const nextWin = next.showdown?.winners;
  if (nextWin && nextWin.length && !(prevWin && prevWin.length)) {
    for (const w of nextWin) {
      onlineLog.push({
        type: 'win',
        player: _nameForUid(next, w.uid),
        amount: w.amount,
        hand: onlineHandName(next, w.uid, w.handRank || 'the pot'),
      });
    }
  }

  onlinePrevDoc = next;
}

// ── SETUP (single player) ──
let setupAICount = 4;
let setupAvatarId = AVATARS[0].id;
let setupDeckId = DECKS[0].id;

// Apply the chosen deck design as the back of all face-down cards.
function setDeckBack(id) {
  const deck = deckById(id);
  document.documentElement.style.setProperty('--card-back', `url('${deck.img}')`);
}

// Shared deck picker (setup + online lobby).
function deckGalleryHtml(selectedId) {
  return `<div class="deck-gallery">
    ${DECKS.map(d => `
      <button type="button" class="deck-choice ${d.id === selectedId ? 'selected' : ''}" data-deck="${d.id}" title="${d.label}">
        <span class="deck-swatch" style="background-image:url('${d.img}')"></span>
        <span class="deck-name">${d.label}</span>
      </button>`).join('')}
  </div>`;
}

function wireDeckGallery(container, onPick) {
  const gallery = container.querySelector('.deck-gallery');
  if (!gallery) return;
  gallery.addEventListener('click', e => {
    const btn = e.target.closest('.deck-choice');
    if (!btn) return;
    onPick(btn.dataset.deck);
    setDeckBack(btn.dataset.deck);
    gallery.querySelectorAll('.deck-choice').forEach(b =>
      b.classList.toggle('selected', b === btn));
  });
}

function renderSetup() {
  const grid = $('setup-grid');
  grid.innerHTML = '';

  // Panel header switches to "HOST A TABLE" for online.
  const header = document.querySelector('#setup-screen .panel-header');
  if (header) header.textContent = mode === 'online' ? 'HOST A TABLE' : 'SET YOUR STAKES';

  // Bottom-of-panel buttons: swap between single-player DEAL and online HOST/JOIN.
  const btnGroup = document.querySelector('#setup-screen .setup-buttons');
  if (btnGroup) {
    btnGroup.innerHTML = mode === 'online'
      ? `<button class="btn btn-back" onclick="window.showTitle()">← BACK</button>
         <button class="btn btn-secondary" onclick="window.showJoinCode()">🚪 JOIN GAME</button>
         <button class="btn btn-primary" onclick="window.hostOnlineGame()">🏠 HOST GAME</button>`
      : `<button class="btn btn-back" onclick="window.showTitle()">← BACK</button>
         <button class="btn btn-primary" onclick="window.startGame()">DEAL 'EM →</button>`;
  }

  if (mode === 'single') {
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
  }

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

  const deckRow = document.createElement('div');
  deckRow.className = 'setup-row setup-row-decks';
  deckRow.innerHTML = `
    <label class="setup-label">YOUR DECK</label>
    ${deckGalleryHtml(setupDeckId)}
  `;
  grid.appendChild(deckRow);
  wireDeckGallery(deckRow, id => { setupDeckId = id; });
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
  scored = false;
  gameStart = Date.now();
  blindLevel = 0;
  setDeckBack(setupDeckId);
  switchScreen('game-screen');
  beginHand();
};

// ── ONLINE: setup → host / join → lobby → game ──

window.hostOnlineGame = async () => {
  const name = ($('player-name')?.value || 'Stranger').trim() || 'Stranger';
  try {
    await Online.waitForAuth();
    onlineMyUid = Online.myUid();
    const { gameId, code } = await Online.createGame({
      displayName: name, avatarId: setupAvatarId, deckId: setupDeckId,
    });
    onlineGameId = gameId;
    onlineCode = code;
    onlineIsHost = true;
    setDeckBack(setupDeckId);
    subscribeOnline();
    renderLobby();
    switchScreen('lobby-screen');
  } catch (e) {
    alert('Error hosting game: ' + (e.message || e));
  }
};

window.showJoinCode = () => {
  onlineIsHost = false;
  renderJoin();
  switchScreen('lobby-screen');
};

window.joinOnlineByCode = async () => {
  const code = ($('join-code-input')?.value || '').trim().toUpperCase();
  const name = ($('player-name')?.value || 'Stranger').trim() || 'Stranger';
  if (code.length !== 4) { alert('Enter a 4-letter room code'); return; }
  try {
    await Online.waitForAuth();
    onlineMyUid = Online.myUid();
    const { gameId } = await Online.joinByCode(code);
    await Online.joinGame(gameId, { displayName: name, avatarId: setupAvatarId });
    onlineGameId = gameId;
    onlineCode = code;
    onlineIsHost = false;
    setDeckBack(setupDeckId);
    subscribeOnline();
    renderLobby();
  } catch (e) {
    alert('Join failed: ' + (e.message || e));
  }
};

window.addAiSeat = async () => {
  if (!onlineGameId || !onlineIsHost) return;
  // Fill the next open seat with a themed AI. Avoid duplicate avatars and
  // duplicate display names — getAIPersonalities re-shuffles its pool per
  // call so consecutive single-picks can collide.
  const seatsMap = onlineDoc?.seats || {};
  const takenAvatars = new Set(Object.values(seatsMap).map(s => s.avatarId).filter(Boolean));
  const takenNames = new Set(Object.values(seatsMap).map(s => (s.displayName || '').toLowerCase()));
  const remaining = AVATARS.filter(a => !takenAvatars.has(a.id));
  if (!remaining.length) return;
  const pick = remaining[Math.floor(Math.random() * remaining.length)];
  // Try up to 8 personality draws to dodge a name collision, then fall
  // back to whatever came last (extremely unlikely to matter).
  let personality;
  for (let i = 0; i < 8; i++) {
    personality = getAIPersonalities([pick.gender])[0];
    if (!takenNames.has(personality.name.toLowerCase())) break;
  }
  try {
    await Online.addAiSeat(onlineGameId, {
      displayName: personality.name,
      avatarId: pick.id,
      personalityId: personality.style || null,
    });
  } catch (e) {
    alert('Add AI failed: ' + (e.message || e));
  }
};

window.dealOnlineHand = async () => {
  if (!onlineGameId || !onlineIsHost) return;
  try {
    await Online.startHand(onlineGameId);
    gameStart = Date.now();
    blindLevel = 0;
    switchScreen('game-screen');
  } catch (e) {
    alert('Deal failed: ' + (e.message || e));
  }
};

window.leaveOnlineGame = async () => {
  if (onlineGameId) {
    try { await Online.leaveGame(onlineGameId); } catch (_) {}
  }
  teardownOnline();
  mode = 'single';
  switchScreen('title-screen');
};

function subscribeOnline() {
  if (unsubGame) { try { unsubGame(); } catch (_) {} }
  if (unsubMyHand) { try { unsubMyHand(); } catch (_) {} }
  if (unsubAiHands) { try { unsubAiHands(); } catch (_) {} }
  unsubGame = Online.subscribeGame(onlineGameId, (doc) => {
    onlineDoc = doc;
    applyOnlineSnapshot();
  });
  unsubMyHand = Online.subscribeMyHand(onlineGameId, onlineMyUid, (data) => {
    onlineMyHand = data;
    applyOnlineSnapshot();
  });
  if (onlineIsHost) {
    unsubAiHands = Online.subscribeAiHands(onlineGameId, (bySeat) => {
      onlineAiHands = bySeat;
      applyOnlineSnapshot();
    });
  }
}

// Server card format ("As", "Th", …) → client card object.
const _SERVER_SUITS = { s: '♠', h: '♥', d: '♦', c: '♣' };
function serverCardToClient(c) {
  if (!c || typeof c !== 'string' || c.length !== 2) return null;
  const rank = c[0] === 'T' ? '10' : c[0];
  const suit = _SERVER_SUITS[c[1]] || '♠';
  return { rank, suit, value: RANK_VALUES[rank] };
}

// Rich winning-hand description for online showdowns. The server only
// sends a short handRank string (no kicker), but at showdown we already
// have the winner's revealed hole cards + the community, so we re-derive
// the full "Two Pair, Queens & Fives, Ace kicker" text client-side —
// identical to single-player, no server change needed. Falls back to the
// server string (fold-around wins have no revealed cards).
function onlineHandName(doc, uid, fallback) {
  const revealed = doc?.showdown?.revealed?.[uid];
  const community = doc?.communityCards;
  if (!revealed || revealed.length < 2 || !community || community.length < 3) return fallback;
  const hole = revealed.map(serverCardToClient).filter(Boolean);
  const board = community.map(serverCardToClient).filter(Boolean);
  if (hole.length < 2 || board.length < 3) return fallback;
  try {
    return describeHand(evaluateHand(hole, board));
  } catch (_) {
    return fallback;
  }
}

// Convert the Firestore game doc (+ my hole cards + AI hole cards if host)
// into a G-shaped object the single-player render loop can consume.
function stateFromDoc(doc) {
  if (!doc) return null;
  const seatsMap = doc.seats || {};
  const seatIdxs = Object.keys(seatsMap).map(k => parseInt(k, 10)).sort((a, b) => a - b);
  const players = seatIdxs.map((idx) => {
    const s = seatsMap[idx];
    const isMe = !s.isAI && s.uid === onlineMyUid;
    // Hole cards: show mine (always), reveal at showdown per doc.showdown.revealed,
    // otherwise represent as two facedown placeholders (length===2).
    let hand = [];
    const inHand = ['active', 'all_in', 'folded'].includes(s.status);
    if (inHand && doc.handNumber > 0 && doc.phase !== 'between_hands') {
      const revealedByUid = doc.showdown?.revealed || {};
      if (isMe && onlineMyHand?.holeCards) {
        hand = onlineMyHand.holeCards.map(serverCardToClient);
      } else if (revealedByUid[s.uid]) {
        hand = revealedByUid[s.uid].map(serverCardToClient);
      } else {
        hand = [{ rank: '?', suit: '?', value: 0 }, { rank: '?', suit: '?', value: 0 }];
      }
    }
    return {
      id: idx,
      seatIdx: idx,
      uid: s.uid,
      name: s.displayName,
      isAI: !!s.isAI,
      avatar: s.avatarId || null,
      chips: s.stack,
      currentBet: s.committedThisStreet || 0,
      totalBet: s.committedThisHand || 0,
      personalityId: s.personalityId || null,
      folded: s.status === 'folded',
      allIn: s.status === 'all_in',
      hand,
    };
  });

  const activeIndex = players.findIndex(p => p.seatIdx === doc.actionSeat);
  const dealerIndex = players.findIndex(p => p.seatIdx === doc.dealerSeat);
  const winnersArr = (doc.showdown?.winners || []).map(w => ({
    player: players.find(p => p.uid === w.uid) || null,
    amount: w.amount,
    hand: onlineHandName(doc, w.uid, w.handRank),
  })).filter(w => w.player);

  return {
    players,
    phase: doc.phase === 'between_hands' ? 'showdown' : doc.phase,
    communityCards: (doc.communityCards || []).map(serverCardToClient).filter(Boolean),
    pot: doc.pot || 0,
    currentBet: doc.currentBet || 0,
    minRaise: doc.minRaise || (doc.settings?.bigBlind || 20),
    smallBlind: doc.settings?.smallBlind || 10,
    bigBlind: doc.settings?.bigBlind || 20,
    activeIndex: activeIndex === -1 ? 0 : activeIndex,
    dealerIndex: dealerIndex === -1 ? 0 : dealerIndex,
    roundNum: doc.handNumber || 0,
    winners: winnersArr,
    log: onlineLog,
    _online: true,
    _phaseRaw: doc.phase,
    _handOver: doc.phase === 'between_hands' || doc.phase === 'showdown',
  };
}

// Called on every snapshot: rebuild G, decide what to render, and drive
// AI turns if we're the host.
function applyOnlineSnapshot() {
  if (mode !== 'online' || !onlineDoc) return;
  // Server can reassign hostUid (e.g. when the current host busts and
  // "Next Hand" control transfers to another human). Recompute on every
  // snapshot instead of trusting the value set at connect time.
  const wasHost = onlineIsHost;
  onlineIsHost = !!(onlineMyUid && onlineDoc.hostUid === onlineMyUid);
  // Attach/detach the aiHands subscription to match. Firestore rules
  // reject reads unless we're the current host, so we only sub when we
  // actually become host.
  if (onlineIsHost && !unsubAiHands) {
    unsubAiHands = Online.subscribeAiHands(onlineGameId, (bySeat) => {
      onlineAiHands = bySeat;
      applyOnlineSnapshot();
    });
  } else if (!onlineIsHost && unsubAiHands) {
    try { unsubAiHands(); } catch (_) {}
    unsubAiHands = null;
    onlineAiHands = {};
  }
  // Accumulate saloon-talk log by diffing consecutive game-doc snapshots.
  // Runs before stateFromDoc so G.log reflects the latest events.
  if (onlinePrevDoc !== onlineDoc) {
    deriveOnlineLog(onlinePrevDoc, onlineDoc);
  }
  // In lobby (waiting or between hands with no cards yet): show the lobby.
  const currentScreen = document.querySelector('.screen.active')?.id || '';
  const preGame = onlineDoc.status === 'waiting'
    || (onlineDoc.status === 'playing' && onlineDoc.phase === 'between_hands' && onlineDoc.handNumber === 0);
  if (preGame && currentScreen !== 'game-screen') {
    renderLobby();
    return;
  }

  G = stateFromDoc(onlineDoc);
  if (!G) return;

  if (currentScreen !== 'game-screen') switchScreen('game-screen');
  renderGame();

  // Game finished on the server — surface the game-over overlay for
  // EVERY player (not just the host), so losers see the result and the
  // winner's browser records to Top Guns exactly once via the `scored`
  // guard in recordWinIfMine.
  if (onlineDoc.status === 'finished' && !scored) {
    showGameOver();
  }

  // Between-hands (finished hand): pause on the last hand's reveal.
  if (G._handOver) {
    pendingReveal = true;
    return;
  }
  pendingReveal = false;

  // Host drives AI turns.
  if (onlineIsHost) driveOnlineAiTurn();
}

async function driveOnlineAiTurn() {
  if (!G || G._handOver || onlineAiInFlight) return;
  const active = G.players[G.activeIndex];
  if (!active || !active.isAI) return;
  const aiHand = onlineAiHands[active.seatIdx];
  if (!aiHand?.holeCards) return;   // host has not received AI hole cards yet
  const holeClient = aiHand.holeCards.map(serverCardToClient);
  onlineAiInFlight = true;
  clearTimeout(onlineAiTimer);
  onlineAiTimer = setTimeout(async () => {
    try {
      // Rebuild the archetype assigned at addAiSeat time (stored on the
      // seat as personalityId) with name-seeded jitter, so bots actually
      // play their advertised tight/aggressive/calculated/loose styles.
      const personality = personalityFromStyle(active.personalityId, active.name);
      const decision = aiDecision(
        { ...active, hand: holeClient, personality },
        {
          communityCards: G.communityCards,
          pot: G.pot,
          currentBet: G.currentBet,
          minRaise: G.minRaise,
          bigBlind: G.bigBlind,
          position: tablePosition(G.players, G.dealerIndex, G.activeIndex),
        },
      );
      // Sanitize the decision against current server state before sending.
      // aiDecision's premium/strong-hand paths can fall through to 'call'
      // even when nothing has been bet this street — server would reject
      // ("Nothing to call — use check") and no new snapshot would arrive
      // to retry, hanging the game.
      let action = decision.action === 'all-in' ? 'all_in' : decision.action;
      let amount = 0;
      const toCall = Math.max(0, (G.currentBet | 0) - (active.currentBet | 0));
      if (action === 'call' && toCall === 0) action = 'check';
      if (action === 'check' && toCall > 0) action = 'call';
      if (decision.action === 'raise') {
        amount = G.currentBet + (decision.amount || G.minRaise);
        // Postflop with no prior bet, the AI's "raise" is server-side a "bet".
        if ((G.currentBet | 0) === 0) action = 'bet';
      }
      try {
        await Online.playerAction(onlineGameId, action, amount);
      } catch (e) {
        // Anything the sanitizer missed: degrade to the safest legal move
        // rather than hang. Check if we can, else fold — folding is always
        // legal and lets the hand progress.
        console.warn('AI action rejected, falling back', action, e.message || e);
        const fallback = toCall === 0 ? 'check' : 'fold';
        try {
          await Online.playerAction(onlineGameId, fallback, 0);
        } catch (e2) {
          console.error('AI fallback also failed', e2);
        }
      }
    } catch (e) {
      console.error('AI action failed', e);
    } finally {
      onlineAiInFlight = false;
    }
  }, 2500 + Math.random() * 1500);
}

function renderLobby() {
  const body = $('lobby-body');
  if (!body) return;
  if (!onlineDoc && !onlineIsHost) {
    // Join view — no game yet.
    renderJoin();
    return;
  }
  const seatsMap = onlineDoc?.seats || {};
  const seatEntries = Object.keys(seatsMap).map(k => parseInt(k, 10)).sort((a, b) => a - b)
    .map(idx => ({ idx, seat: seatsMap[idx] }));
  const humanCount = seatEntries.filter(({ seat }) => !seat.isAI).length;
  const aiCount = seatEntries.filter(({ seat }) => seat.isAI).length;
  const totalCount = seatEntries.length;
  const maxSeats = onlineDoc?.settings?.maxPlayers || 6;
  const canDeal = onlineIsHost && totalCount >= 2;

  body.innerHTML = `
    <div class="lobby-menu">
      <div class="lobby-row lobby-code-row">
        <div class="room-code-display">Code <span class="room-code">${onlineCode || '—'}</span></div>
        <div class="lobby-hint">Share this with friends so they can join.</div>
      </div>
      <div class="lobby-row">
        <label class="setup-label">AT THE TABLE (${totalCount}/${maxSeats})</label>
        <div class="lobby-seat-list">
          ${seatEntries.map(({ idx, seat }) => {
            const av = AVATARS.find(a => a.id === seat.avatarId);
            const av_html = av ? avatarMarkup(av, 'avatar-sm') : '';
            const badge = seat.isAI ? '<span class="lobby-badge lobby-badge-ai">AI</span>'
                       : (seat.uid === onlineDoc?.hostUid ? '<span class="lobby-badge lobby-badge-host">HOST</span>' : '');
            return `<div class="lobby-seat">
              ${av_html}
              <span class="lobby-seat-name">${escapeHtml(seat.displayName || 'Player')}</span>
              ${badge}
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="lobby-buttons">
        <button class="btn btn-back" onclick="window.leaveOnlineGame()">← LEAVE</button>
        ${onlineIsHost && totalCount < maxSeats
          ? `<button class="btn btn-secondary" onclick="window.addAiSeat()">🤖 ADD AI</button>`
          : ''}
        ${canDeal
          ? `<button class="btn btn-primary" onclick="window.dealOnlineHand()">🎰 DEAL 'EM →</button>`
          : ''}
      </div>
      ${!onlineIsHost ? '<div class="lobby-hint">Waiting for the host to deal…</div>' : ''}
    </div>
  `;
}

function renderJoin() {
  const body = $('lobby-body');
  if (!body) return;
  body.innerHTML = `
    <div class="lobby-menu">
      <div class="lobby-row">
        <label class="setup-label">ROOM CODE</label>
        <input type="text" id="join-code-input" class="setup-input code-input" maxlength="4" placeholder="ABCD" autocapitalize="characters" spellcheck="false">
        <div class="lobby-hint">Ask the host for the 4-letter code.</div>
      </div>
      <div class="lobby-buttons">
        <button class="btn btn-back" onclick="window.showTitle()">← BACK</button>
        <button class="btn btn-primary" onclick="window.joinOnlineByCode()">JOIN →</button>
      </div>
    </div>
  `;
  const input = $('join-code-input');
  if (input) {
    input.oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); };
    input.focus();
  }
}

// Raise the blinds based on how long the game has been running.
function applyBlindLevel() {
  const elapsed = (Date.now() - gameStart) / 1000;
  const lvl = Math.min(BLIND_LEVELS.length - 1, Math.floor(elapsed / LEVEL_SECONDS));
  const level = BLIND_LEVELS[lvl];
  const raised = lvl > blindLevel;
  blindLevel = lvl;
  G.level = lvl;
  G.smallBlind = level.sb;
  G.bigBlind = level.bb;
  return raised;
}

// ── GAME FLOW ──
function beginHand() {
  const raised = applyBlindLevel();
  G = startHand(G);
  pendingReveal = false;
  renderGame();
  logMsg(`─── Hand #${G.roundNum} ───`);
  if (raised) logMsg(`Blinds up: $${G.smallBlind} / $${G.bigBlind}`);
  setTimeout(() => checkAITurn(), 400);
}

function checkAITurn() {
  if (mode === 'online') return;   // online AI is driven by driveOnlineAiTurn on snapshots
  if (!G || isHandOver(G)) return;
  const player = G.players[G.activeIndex];
  if (!player) return;

  if (player.isAI) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      const decision = aiDecision(player, {
        communityCards: G.communityCards,
        pot: G.pot,
        currentBet: G.currentBet,
        minRaise: G.minRaise,
        bigBlind: G.bigBlind || BIG_BLIND,
        position: tablePosition(G.players, G.dealerIndex, G.activeIndex),
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
// Writes to BOTH the local per-browser board (works offline / without
// Cloud Functions) and the global Top Guns board via submitWin. Losing
// players don't record anything; winners write from their own browser.
function recordWinIfMine(winner) {
  if (scored) return;
  scored = true;
  if (!winner) return;
  const mine = mode === 'online' ? (winner.uid === onlineMyUid) : !winner.isAI;
  const startingStack = mode === 'online'
    ? (onlineDoc?.settings?.startingStack || STARTING_CHIPS)
    : STARTING_CHIPS;
  const net = winner.chips - startingStack;
  if (mine && net > 0) {
    recordWin(winner.name, net);
    // Global board — fire-and-forget; local record is our fallback.
    Online.submitWin(winner.name, net).catch(e => {
      console.warn('global submitWin failed', e);
    });
  }
}

window.playAgain = () => {
  hide('gameover-overlay');
  switchScreen('title-screen');
};

// ── LEADERBOARDS (Top Guns) ──
// Render local instantly for responsiveness, then fetch the global
// (Cloud Firestore) boards. Global overrides when it has entries;
// local remains the fallback if the global fetch fails (rules, offline,
// or Cloud Function not deployed).
window.showLeaderboard = async () => {
  switchScreen('leaderboard-screen');
  const local = getLeaderboards();
  renderBoard('daily-board', local.daily);
  renderBoard('lifetime-board', local.lifetime);
  try {
    const global = await Online.fetchLeaderboards();
    if (global.daily.length) renderBoard('daily-board', global.daily);
    if (global.lifetime.length) renderBoard('lifetime-board', global.lifetime);
  } catch (e) {
    console.warn('global leaderboards unreachable, showing local only', e);
  }
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
  if (mode === 'online') {
    if (!onlineIsHost) return;   // only host can start next hand
    if (isGameOver(G)) { showGameOver(); return; }
    Online.startHand(onlineGameId).catch(e => alert('Next hand failed: ' + (e.message || e)));
    return;
  }
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

  if (mode === 'online') {
    // Online: send to server; wait for snapshot to re-render.
    // Server distinguishes 'bet' (opening a street) from 'raise'
    // (increasing a prior bet); the single-player button labels everything
    // aggressive as "RAISE", so translate at the boundary. Slider's value
    // is already the total commitment for the street, which is what both
    // 'bet' and 'raise' amounts represent server-side.
    let srvAction = action.action === 'all-in' ? 'all_in' : action.action;
    let amount = action.action === 'raise' ? (action.amount | 0) : 0;
    if (srvAction === 'raise' && (G.currentBet | 0) === 0) srvAction = 'bet';
    Online.playerAction(onlineGameId, srvAction, amount)
      .catch(e => alert('Action failed: ' + (e.message || e)));
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
  renderOddsPanel();
}

// ── Hand rankings + odds panel ──

// User preference for showing their own live odds. Persisted so the
// toggle sticks across page loads.
let showMyOdds = localStorage.getItem('poker_show_odds') === '1';

function initOddsToggle() {
  const el = document.getElementById('my-odds-toggle');
  if (!el || el.dataset.wired) return;
  el.checked = showMyOdds;
  el.addEventListener('change', () => {
    showMyOdds = el.checked;
    localStorage.setItem('poker_show_odds', showMyOdds ? '1' : '0');
    renderOddsPanel();
  });
  el.dataset.wired = '1';
  const list = document.getElementById('hand-ranks-list');
  if (list) list.classList.toggle('show-my-odds', showMyOdds);
}

// Return the local player's own hole cards in client format, or null
// if we don't know them (e.g. spectator / hand not dealt yet).
function myHoleCards() {
  if (!G) return null;
  if (mode === 'online') {
    if (!onlineMyHand || !onlineMyHand.holeCards) return null;
    if (G.roundNum && onlineMyHand.handNumber && onlineMyHand.handNumber !== G.roundNum) return null;
    return onlineMyHand.holeCards.map(serverCardToClient).filter(Boolean);
  }
  // Single-player: find the human player (only one).
  const me = G.players.find(p => !p.isAI);
  if (!me || !me.hand || me.hand.length !== 2) return null;
  // Skip if hand cards are placeholders (folded or masked).
  if (me.hand.some(c => !c || c.rank === '?')) return null;
  return me.hand;
}

function renderOddsPanel() {
  initOddsToggle();
  const list = document.getElementById('hand-ranks-list');
  if (!list) return;

  // Static prior odds — always visible.
  const rows = list.querySelectorAll('tr[data-rank]');
  rows.forEach(row => {
    const r = parseInt(row.dataset.rank, 10);
    const oddsCell = row.querySelector('.hr-odds');
    if (oddsCell && oddsCell.textContent === '') {
      oddsCell.textContent = fmtPct(STATIC_ODDS[r]);
    }
  });

  list.classList.toggle('show-my-odds', showMyOdds);

  // Live "my odds" — only when toggle is on AND we have hole cards + a
  // dealt community.
  if (!showMyOdds) return;
  const hole = myHoleCards();
  const community = (G && G.communityCards) || [];
  const dist = hole && community.length >= 3 ? computeMyOdds(hole, community) : null;
  rows.forEach(row => {
    const r = parseInt(row.dataset.rank, 10);
    const cell = row.querySelector('.hr-my');
    if (!cell) return;
    if (!dist) { cell.textContent = '—'; return; }
    cell.textContent = fmtPct(dist[r]);
  });
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

  G.players.forEach((p, i) => {
    const isMe = mode === 'online' ? (p.uid === onlineMyUid) : !p.isAI;
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
      handLabel = `<div class="hand-label">${describeHand(eval_)}</div>`;
    }
    if (showCards && !isMe && pendingReveal && p.hand.length === 2 && !p.folded && G.communityCards.length > 0) {
      const eval_ = evaluateHand(p.hand, G.communityCards);
      handLabel = `<div class="hand-label">${describeHand(eval_)}</div>`;
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
  $('phase-display').textContent = `${phase} · HAND #${G.roundNum} · BLINDS $${G.smallBlind}/$${G.bigBlind}`;

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
  const mySeat = mode === 'online'
    ? G.players.findIndex(p => p.uid === onlineMyUid)
    : G.players.findIndex(p => !p.isAI);
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
        <input type="range" id="raise-slider" class="raise-slider" min="${minTotal}" max="${maxTotal}" value="${minTotal}" step="${G.bigBlind || BIG_BLIND}" ${da}>
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
setDeckBack(setupDeckId);
