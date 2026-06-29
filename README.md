# 🃏 Dead Hand Saloon — Texas Hold'em

A single-page, browser-based Texas Hold'em poker game with a Wild West saloon
theme. Play a sit-and-go against characterful AI opponents, or host an online
table for friends. No build step, no framework — just static HTML, CSS, and
vanilla ES modules.

## Features

- **Single-player** — play heads-up to 6-handed against AI opponents, each with
  their own bold cow-poke name, portrait, and playing style (tight, aggressive,
  calculated, loose).
- **Character select** — pick your portrait and enter your name on the setup
  screen. AI opponents are dealt the remaining portraits, with names matched to
  each portrait's gender (male / female / non-binary).
- **Online tables** — host or join a 4-letter room code and play live against
  other people (requires Firebase; see below).
- **Top Guns leaderboards** — **Daily Winners** and **Lifetime Leaders** boards
  tracking human players' net profit. Saved locally in the browser by default.
- **Poker table UI** — real-looking playing cards, a top-down poker-chip pot and
  per-player bet stacks, a live "Saloon Talk" action log, and an always-on
  betting menu with quick-bet chips (MIN / +$50 / +$100 / +$150 / +$250 / MAX).
- **Hand-rankings reference** — a best-to-worst cheat sheet alongside the table.
- **Review at your pace** — the AI acts on a relaxed timer and each finished hand
  waits for you to press **Next Hand** before dealing the next one.

## Running locally

It's a static site that uses ES modules, so it must be served over `http://`
(opening `index.html` directly via `file://` won't work).

```bash
# from the repo root (where index.html lives)
python3 -m http.server 8000
#   …or, with Node:  npx serve -l 8000
```

Then open **http://localhost:8000**.

> Tip: after pulling changes, hard-refresh (Cmd/Ctrl+Shift+R) to bypass the
> browser cache. CSS/JS are versioned with a `?v=N` query that bumps on changes.

## How to play

1. **Sit Down** → choose opponents (1–5), enter your name, pick your look.
2. **Deal 'Em** to start. Everyone begins with **$1,000**.
3. Use **Fold / Check / Call / Raise / All-In** on your turn. Use the quick-bet
   chips or the slider to size a raise.
4. Win all the chips at the table to win the game. Your net profit (winnings
   above the $1,000 buy-in) is added to the Top Guns boards.

## Project structure

```
index.html            Markup for every screen (title, setup, lobby, game, boards)
styles.css            All styling (saloon theme, responsive layout)
src/
  app.js              UI wiring, render loop, game flow, input handling
  engine.js           Game rules: betting rounds, blinds, side pots, showdown
  hand-eval.js        5-from-7 hand evaluation and comparison
  cards.js            Deck creation, shuffle, card helpers
  ai.js               AI personalities, name pools, decision logic
  avatars.js          Portrait manifest, names, gender, random assignment
  leaderboard.js      Local (localStorage) Daily/Lifetime boards
  firebase.js         Online rooms + a global Firebase board (optional)
assets/
  avatars/            Character portraits (avatar-01 … avatar-15)
  chips/              Poker chip image
  textures/           Walnut plank background
  ui/                 Title background + saloon sign
```

## Adding character portraits

Drop images into `assets/avatars/` named `avatar-01` … `avatar-15`
(`.png` / `.jpg` / `.jpeg` / `.webp`). See
[`assets/avatars/README.md`](assets/avatars/README.md). To change the count,
names, or gender mapping, edit `src/avatars.js`.

## Leaderboards

By default the **Top Guns** boards are stored in the browser via `localStorage`
(`src/leaderboard.js`) — they work immediately with no backend, but only reflect
games played in that browser. They track human players only, by net profit, and
the daily board resets each calendar day.

A **global, shared** version (everyone sees the same board) is implemented in
`src/firebase.js` (`submitScore` / `fetchLeaderboards`). To switch to it once
Firebase is configured, import those instead of the `leaderboard.js` functions
in `src/app.js`, and add read/write rules for the `/leaderboard` path in your
Firebase Realtime Database (with `.indexOn: "winnings"` for the `daily/$day` and
`lifetime` nodes).

## Online play (optional)

Online tables use Firebase Realtime Database (config in `src/firebase.js`). Host
a game to get a 4-letter room code, share it, and others can join. Single-player
needs no network beyond loading the page.

## Tech

Vanilla JavaScript (ES modules), HTML, and CSS — no build tooling or
dependencies. Optional Firebase (loaded from CDN) for online play and the global
leaderboard.
