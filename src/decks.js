// ── Card-back deck designs ──
// Images live in assets/decks/ as deck-01.jpg … deck-NN.jpg. Players pick one
// on the setup screen (and online lobby); it's used as the back of face-down
// cards. Edit the labels below to rename a design.

export const DECK_DIR = 'assets/decks';

const DECK_NAMES = [
  'Lone Star Compass',    // 01 — navy compass / star rose
  'Longhorn',             // 02 — longhorn skulls
  'Crossed Irons',        // 03 — crossed revolvers
  'Desert Sun',           // 04 — desert / cacti scene
  'Diamondback',          // 05 — black diamond lattice
  'The High Roller',      // 06 — emerald & gold filigree
  'The Outrider',         // 07 — horseback rider medallions
  'The House Deck',       // 08 — gold monogram sunburst
  "Walter's Pick",        // 09 — ravens (the "Seahawk")
  'The Randall Special',  // 10 — grim reaper
  "Kaden's Classic",      // 11 — Día de los Muertos mariachi skeleton
  'Tall Timbers',         // 12 — lone rider among the redwoods
  'Frontier Map',         // 13 — old parchment territory map
];

export const DECKS = DECK_NAMES.map((name, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `deck-${n}`, label: name, img: `${DECK_DIR}/deck-${n}.jpg` };
});

export function deckById(id) {
  return DECKS.find(d => d.id === id) || DECKS[0];
}
