/** S9-A1: durable claim, restart replay, and unknown terminal state. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteOrderAttemptStore } from '../src/safety/orderAttemptStore.ts';

const root = mkdtempSync(join(tmpdir(), 'mcd-s9-a1-'));
const dbPath = join(root, 'order-state.sqlite');
const input = { userId: 'check-user', fingerprint: 'fp-check', atMs: 1_000, cents: 1_299 };

try {
  const first = new SqliteOrderAttemptStore(dbPath);
  const second = new SqliteOrderAttemptStore(dbPath);
  const firstClaim = first.claim(input);
  const secondClaim = second.claim({ ...input, atMs: 1_001 });
  if (!firstClaim.acquired || secondClaim.acquired) {
    throw new Error('two-process claim was not exclusive');
  }

  first.settleSuccess(input.userId, input.fingerprint, 'ORDER-CHECK', input.cents, 1_100);
  first.close?.();
  second.close?.();

  const restarted = new SqliteOrderAttemptStore(dbPath);
  const replayed = restarted.get(input.userId, input.fingerprint);
  if (replayed?.state !== 'succeeded' || replayed.orderId !== 'ORDER-CHECK') {
    throw new Error('restart did not replay the settled order');
  }

  const unknownInput = { ...input, fingerprint: 'fp-unknown', atMs: 2_000 };
  restarted.claim(unknownInput);
  restarted.markUnknown(unknownInput.userId, unknownInput.fingerprint, 2_500);
  const unknown = restarted.get(unknownInput.userId, unknownInput.fingerprint);
  if (unknown?.state !== 'unknown') throw new Error('timeout did not become unknown');
  const staleInput = { ...input, fingerprint: 'fp-stale-pending', atMs: 2_000 };
  restarted.claim(staleInput);
  restarted.close?.();
  const restartedAgain = new SqliteOrderAttemptStore(dbPath, 1);
  const stale = restartedAgain.get(staleInput.userId, staleInput.fingerprint);
  if (stale?.state !== 'unknown') throw new Error('stale pending was not sealed as unknown');
  restartedAgain.close?.();
  console.log('S9-A1 PASS: exclusive claim, restart replay, and unknown terminal state');
} finally {
  rmSync(root, { recursive: true, force: true });
}
