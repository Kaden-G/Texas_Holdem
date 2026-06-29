// ── Character avatars ──
// Photos live in  assets/avatars/  named avatar-01 … avatar-NN.
// Drop in any of: .png .jpg .jpeg .webp  (a numbered .svg placeholder is the
// fallback when no photo is present). See assets/avatars/README.md.

export const AVATAR_DIR = 'assets/avatars';
export const AVATAR_COUNT = 15;

// File extensions tried, in order. Real photos win; .svg placeholder is last.
export const AVATAR_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'svg'];

// In-game name + gender for each portrait (avatar-01 … avatar-15).
// `gender` ('m'/'f'/'nb') is used to match AI players to same-gender handles.
const AVATAR_META = [
  { name: 'Silas Graves',        gender: 'm'  }, // 01 — grizzled elder, handlebar mustache
  { name: 'Cole Braddock',       gender: 'm'  }, // 02 — bearded outlaw in a dark coat
  { name: 'Diego Reyes',         gender: 'm'  }, // 03 — young vaquero in suspenders
  { name: 'Marshal Reed',        gender: 'm'  }, // 04 — stoic lawman
  { name: 'Boone Hartley',       gender: 'm'  }, // 05 — weathered old trail hand
  { name: 'Eli Two-Hawk',        gender: 'm'  }, // 06 — braided plainsman
  { name: 'Belle Sawyer',        gender: 'f'  }, // 07 — blonde, hard-bitten gunhand
  { name: 'Harriet Stone',       gender: 'f'  }, // 08 — strong-jawed homesteader
  { name: 'Rosa Delgado',        gender: 'f'  }, // 09 — dark hair, red kerchief
  { name: 'Winona Grey-Cloud',   gender: 'f'  }, // 10 — braided, teal scarf
  { name: 'Miss Adelaide Crowe', gender: 'f'  }, // 11 — stern widow in black
  { name: 'Sage Ardmore',        gender: 'nb' }, // 12 — short-haired, leather coat
  { name: 'Jesse Wilder',        gender: 'nb' }, // 13 — long hair and beard
  { name: 'Charlie Quicksilver', gender: 'nb' }, // 14 — undercut, dark coat
  { name: 'Rowan Bly',           gender: 'nb' }, // 15 — long hair, vest and scarf
];

export const AVATARS = Array.from({ length: AVATAR_COUNT }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  const meta = AVATAR_META[i] || { name: `Stranger ${i + 1}`, gender: 'm' };
  return {
    id: `avatar-${n}`,
    label: meta.name,
    gender: meta.gender,
    base: `${AVATAR_DIR}/avatar-${n}`,
  };
});

export function avatarById(id) {
  return AVATARS.find(a => a.id === id) || null;
}

// Pick `count` distinct random avatars, skipping any ids in `excludeIds`.
export function pickRandomAvatars(count, excludeIds = []) {
  const pool = AVATARS.filter(a => !excludeIds.includes(a.id));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// HTML for an avatar. `size` is an extra CSS class (e.g. 'avatar-md').
// Tries each extension in turn, then degrades to a glyph placeholder.
export function avatarMarkup(idOrAvatar, size = '') {
  const a = typeof idOrAvatar === 'string' ? avatarById(idOrAvatar) : idOrAvatar;
  const cls = `avatar ${size}`.trim();
  if (!a) return `<div class="${cls} avatar-empty">🎴</div>`;
  return `<img class="${cls}" alt="${a.label}" src="${a.base}.${AVATAR_EXTS[0]}" `
       + `data-base="${a.base}" data-ext="0" onerror="window.__avatarFallback(this)">`;
}

// Walk the extension list on load error; replace with a placeholder if all fail.
function installFallback() {
  if (typeof window === 'undefined' || window.__avatarFallback) return;
  window.__avatarFallback = (img) => {
    const next = parseInt(img.dataset.ext || '0', 10) + 1;
    if (next < AVATAR_EXTS.length) {
      img.dataset.ext = String(next);
      img.src = `${img.dataset.base}.${AVATAR_EXTS[next]}`;
    } else {
      const ph = document.createElement('div');
      ph.className = `${img.className} avatar-empty`;
      ph.textContent = '🎴';
      img.replaceWith(ph);
    }
  };
}
installFallback();
