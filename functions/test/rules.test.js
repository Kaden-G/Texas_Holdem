'use strict';

// Firestore Rules unit test — verifies:
//   1. Cross-player reads of /games/{id}/private/{otherUid} are DENIED.
//   2. A player's read of their OWN private doc is ALLOWED.
//   3. ALL client writes to /games/{id}/** are DENIED.
//   4. Reads/writes to /games/{id}/server/deck are DENIED for everyone.
//
// Requires the Firestore emulator to be running on localhost:8080.
// Skips automatically if @firebase/rules-unit-testing is not installed
// or the emulator is unreachable.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let initializeTestEnvironment, assertFails, assertSucceeds;
try {
  ({
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
  } = require('@firebase/rules-unit-testing'));
} catch (e) {
  test('rules tests skipped (rules-unit-testing not installed)', () => {
    console.warn('Install @firebase/rules-unit-testing to enable rules tests');
  });
  return;
}

const RULES = fs.readFileSync(
  path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8'
);

let env;
test.before(async () => {
  try {
    env = await initializeTestEnvironment({
      projectId: 'demo-poker-rules',
      firestore: {
        host: '127.0.0.1', port: 8080,
        rules: RULES,
      },
    });
  } catch (e) {
    console.warn('Emulator unreachable; skipping rules tests:', e.message);
  }
});
test.after(async () => { if (env) await env.cleanup(); });

test('a signed-in player CAN read their own /private/{uid} doc', async (t) => {
  if (!env) return t.skip('no emulator');
  const alice = env.authenticatedContext('alice');
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('games/G1/private/alice').set({ holeCards: ['As', 'Kh'], handNumber: 1 });
  });
  const db = alice.firestore();
  await assertSucceeds(db.doc('games/G1/private/alice').get());
});

test('a signed-in player CANNOT read another player\'s /private/{uid} doc', async (t) => {
  if (!env) return t.skip('no emulator');
  const bob = env.authenticatedContext('bob');
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('games/G1/private/alice').set({ holeCards: ['As', 'Kh'], handNumber: 1 });
  });
  const db = bob.firestore();
  await assertFails(db.doc('games/G1/private/alice').get());
});

test('no one can read /games/{id}/server/deck', async (t) => {
  if (!env) return t.skip('no emulator');
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc('games/G1/server/deck').set({ cards: ['As'], handNumber: 1 });
  });
  const alice = env.authenticatedContext('alice');
  await assertFails(alice.firestore().doc('games/G1/server/deck').get());
});

test('no client can write to /games/{id}', async (t) => {
  if (!env) return t.skip('no emulator');
  const alice = env.authenticatedContext('alice');
  await assertFails(alice.firestore().doc('games/G2').set({ status: 'playing' }));
});

test('no client can write to their own /private/{uid} doc', async (t) => {
  if (!env) return t.skip('no emulator');
  const alice = env.authenticatedContext('alice');
  await assertFails(
    alice.firestore().doc('games/G2/private/alice').set({ holeCards: ['As', 'Kh'] })
  );
});

test('unauthenticated context cannot read the game doc', async (t) => {
  if (!env) return t.skip('no emulator');
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('games/G3').set({ status: 'waiting' });
  });
  const anon = env.unauthenticatedContext();
  await assertFails(anon.firestore().doc('games/G3').get());
});
