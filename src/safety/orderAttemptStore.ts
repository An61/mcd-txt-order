/**
 * Durable order-attempt state used by the final order guard.
 *
 * SQLite is used only for the small safety state needed to make a claim
 * atomic across restarts and processes. It never stores tokens, cart text,
 * payment URLs, or raw provider responses.
 */

import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const nodeRequire = createRequire(import.meta.url);

type SqliteModule = { readonly DatabaseSync: new (path: string) => DatabaseSync };

/**
 * `node:sqlite` 的可用性随 Node 版本剧烈变化：本机 22.22.2 可直接加载，
 * 而 22.6.0 抛 `ERR_UNKNOWN_BUILTIN_MODULE`（CI 曾因此失败）。
 *
 * 所以这里按需加载而非顶层 import，好处有两个：
 * 一、把模块原生的 stack trace 换成人话——与 publicError 同源的原则，
 *    用户不该面对 `ERR_UNKNOWN_BUILTIN_MODULE` 去猜该怎么办；
 * 二、让「不支持 sqlite 的环境」只在真正用到幂等存储时才失败，
 *    其余离线自检（M1/M2/M3/M4/M8/报名/礼节）仍可完整运行。
 */
function loadSqlite(): SqliteModule {
  try {
    return nodeRequire('node:sqlite') as SqliteModule;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `当前 Node ${process.versions.node} 无法加载内置模块 node:sqlite，订单幂等存储无法初始化。\n` +
        `该模块在 Node 22 早期版本不可用（实测 22.6.0 失败、22.22.2 正常），` +
        `本项目要求 Node >= 22.22.2，见 package.json 的 engines。\n` +
        `原始错误：${detail}`,
    );
  }
}

export type OrderAttemptState = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface StoredOrderAttempt {
  readonly userId: string;
  readonly fingerprint: string;
  readonly state: OrderAttemptState;
  readonly atMs: number;
  readonly updatedAtMs: number;
  readonly orderId?: string;
  readonly cents?: number;
}

export interface NewOrderAttempt {
  readonly userId: string;
  readonly fingerprint: string;
  readonly atMs: number;
  readonly cents?: number;
}

export interface OrderAttemptStore {
  get(userId: string, fingerprint: string): StoredOrderAttempt | undefined;
  list(userId: string): readonly StoredOrderAttempt[];
  claim(input: NewOrderAttempt): { readonly acquired: boolean; readonly attempt: StoredOrderAttempt };
  settleSuccess(
    userId: string,
    fingerprint: string,
    orderId: string | undefined,
    cents: number | undefined,
    atMs: number,
  ): StoredOrderAttempt;
  settleFailure(userId: string, fingerprint: string, atMs: number): StoredOrderAttempt;
  markUnknown(userId: string, fingerprint: string, atMs: number): StoredOrderAttempt;
  getAuthFailedAt(userId: string): number | undefined;
  setAuthFailed(userId: string, atMs: number): void;
  clearAuthFailed(userId: string): void;
  close?(): void;
}

function key(userId: string, fingerprint: string): string {
  return JSON.stringify([userId, fingerprint]);
}

function copyAttempt(attempt: StoredOrderAttempt): StoredOrderAttempt {
  return { ...attempt };
}

/** Deterministic store for tests and explicitly offline/sample flows. */
export class InMemoryOrderAttemptStore implements OrderAttemptStore {
  private readonly attempts = new Map<string, StoredOrderAttempt>();
  private readonly authFailedAt = new Map<string, number>();

  get(userId: string, fingerprint: string): StoredOrderAttempt | undefined {
    const attempt = this.attempts.get(key(userId, fingerprint));
    return attempt === undefined ? undefined : copyAttempt(attempt);
  }

  list(userId: string): readonly StoredOrderAttempt[] {
    return [...this.attempts.values()]
      .filter((attempt) => attempt.userId === userId)
      .sort((a, b) => a.atMs - b.atMs)
      .map(copyAttempt);
  }

  claim(input: NewOrderAttempt): { readonly acquired: boolean; readonly attempt: StoredOrderAttempt } {
    const existing = this.get(input.userId, input.fingerprint);
    if (existing) return { acquired: false, attempt: existing };
    const now = input.atMs;
    const attempt: StoredOrderAttempt = {
      ...input,
      state: 'pending',
      updatedAtMs: now,
    };
    this.attempts.set(key(input.userId, input.fingerprint), attempt);
    return { acquired: true, attempt: copyAttempt(attempt) };
  }

  settleSuccess(
    userId: string,
    fingerprint: string,
    orderId: string | undefined,
    cents: number | undefined,
    atMs: number,
  ): StoredOrderAttempt {
    return this.settle(userId, fingerprint, 'succeeded', atMs, orderId, cents);
  }

  settleFailure(userId: string, fingerprint: string, atMs: number): StoredOrderAttempt {
    return this.settle(userId, fingerprint, 'failed', atMs);
  }

  markUnknown(userId: string, fingerprint: string, atMs: number): StoredOrderAttempt {
    return this.settle(userId, fingerprint, 'unknown', atMs);
  }

  getAuthFailedAt(userId: string): number | undefined {
    return this.authFailedAt.get(userId);
  }

  setAuthFailed(userId: string, atMs: number): void {
    this.authFailedAt.set(userId, atMs);
  }

  clearAuthFailed(userId: string): void {
    this.authFailedAt.delete(userId);
  }

  private settle(
    userId: string,
    fingerprint: string,
    state: OrderAttemptState,
    atMs: number,
    orderId?: string,
    cents?: number,
  ): StoredOrderAttempt {
    const existing = this.attempts.get(key(userId, fingerprint));
    if (existing && existing.state !== 'pending') return copyAttempt(existing);
    const attempt: StoredOrderAttempt = {
      userId,
      fingerprint,
      state,
      atMs: existing?.atMs ?? atMs,
      updatedAtMs: atMs,
      ...(orderId === undefined ? (existing?.orderId ? { orderId: existing.orderId } : {}) : { orderId }),
      ...(cents === undefined ? (existing?.cents === undefined ? {} : { cents: existing.cents }) : { cents }),
    };
    this.attempts.set(key(userId, fingerprint), attempt);
    return copyAttempt(attempt);
  }
}

type SqliteRow = {
  user_id: string;
  fingerprint: string;
  state: OrderAttemptState;
  at_ms: number;
  updated_at_ms: number;
  order_id: string | null;
  cents: number | null;
};

/**
 * SQLite-backed store. A shared file gives atomic claims to multiple Node
 * processes on the same host; deployment must mount the same persistent file
 * for every instance. No network database is assumed by this zero-dependency
 * project.
 */
export class SqliteOrderAttemptStore implements OrderAttemptStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string, pendingTimeoutMs = 5 * 60 * 1000) {
    const resolved = filePath === ':memory:' ? filePath : resolve(filePath);
    if (resolved !== ':memory:') mkdirSync(dirname(resolved), { recursive: true });
    const { DatabaseSync: SqliteDatabase } = loadSqlite();
    this.db = new SqliteDatabase(resolved);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS order_attempts (
        user_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'unknown')),
        at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        order_id TEXT,
        cents INTEGER,
        PRIMARY KEY (user_id, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS order_guard_users (
        user_id TEXT PRIMARY KEY,
        auth_failed_at_ms INTEGER
      );
    `);
    const nowMs = Date.now();
    this.db
      .prepare(`
        UPDATE order_attempts
        SET state = 'unknown', updated_at_ms = ?
        WHERE state = 'pending' AND updated_at_ms < ?
      `)
      .run(nowMs, nowMs - pendingTimeoutMs);
  }

  get(userId: string, fingerprint: string): StoredOrderAttempt | undefined {
    const row = this.db
      .prepare('SELECT * FROM order_attempts WHERE user_id = ? AND fingerprint = ?')
      .get(userId, fingerprint) as SqliteRow | undefined;
    return row === undefined ? undefined : fromRow(row);
  }

  list(userId: string): readonly StoredOrderAttempt[] {
    const rows = this.db
      .prepare('SELECT * FROM order_attempts WHERE user_id = ? ORDER BY at_ms ASC')
      .all(userId) as unknown as SqliteRow[];
    return rows.map(fromRow);
  }

  claim(input: NewOrderAttempt): { readonly acquired: boolean; readonly attempt: StoredOrderAttempt } {
    const result = this.db
      .prepare(`
        INSERT INTO order_attempts (user_id, fingerprint, state, at_ms, updated_at_ms, cents)
        VALUES (?, ?, 'pending', ?, ?, ?)
        ON CONFLICT (user_id, fingerprint) DO NOTHING
      `)
      .run(input.userId, input.fingerprint, input.atMs, input.atMs, input.cents ?? null);
    const attempt = this.get(input.userId, input.fingerprint);
    if (!attempt) throw new Error('order attempt claim did not persist');
    return { acquired: result.changes === 1, attempt };
  }

  settleSuccess(
    userId: string,
    fingerprint: string,
    orderId: string | undefined,
    cents: number | undefined,
    atMs: number,
  ): StoredOrderAttempt {
    this.db
      .prepare(`
        UPDATE order_attempts
        SET state = 'succeeded', updated_at_ms = ?, order_id = COALESCE(?, order_id), cents = COALESCE(?, cents)
        WHERE user_id = ? AND fingerprint = ? AND state = 'pending'
      `)
      .run(atMs, orderId ?? null, cents ?? null, userId, fingerprint);
    return this.require(userId, fingerprint);
  }

  settleFailure(userId: string, fingerprint: string, atMs: number): StoredOrderAttempt {
    this.db
      .prepare(`
        UPDATE order_attempts SET state = 'failed', updated_at_ms = ?
        WHERE user_id = ? AND fingerprint = ? AND state = 'pending'
      `)
      .run(atMs, userId, fingerprint);
    return this.require(userId, fingerprint);
  }

  markUnknown(userId: string, fingerprint: string, atMs: number): StoredOrderAttempt {
    this.db
      .prepare(`
        UPDATE order_attempts SET state = 'unknown', updated_at_ms = ?
        WHERE user_id = ? AND fingerprint = ? AND state = 'pending'
      `)
      .run(atMs, userId, fingerprint);
    return this.require(userId, fingerprint);
  }

  getAuthFailedAt(userId: string): number | undefined {
    const row = this.db
      .prepare('SELECT auth_failed_at_ms FROM order_guard_users WHERE user_id = ?')
      .get(userId) as { auth_failed_at_ms: number | null } | undefined;
    return row?.auth_failed_at_ms ?? undefined;
  }

  setAuthFailed(userId: string, atMs: number): void {
    this.db
      .prepare(`
        INSERT INTO order_guard_users (user_id, auth_failed_at_ms) VALUES (?, ?)
        ON CONFLICT (user_id) DO UPDATE SET auth_failed_at_ms = excluded.auth_failed_at_ms
      `)
      .run(userId, atMs);
  }

  clearAuthFailed(userId: string): void {
    this.db.prepare('DELETE FROM order_guard_users WHERE user_id = ?').run(userId);
  }

  close(): void {
    this.db.close();
  }

  private require(userId: string, fingerprint: string): StoredOrderAttempt {
    const attempt = this.get(userId, fingerprint);
    if (!attempt) throw new Error('order attempt state disappeared');
    return attempt;
  }
}

function fromRow(row: SqliteRow): StoredOrderAttempt {
  return {
    userId: row.user_id,
    fingerprint: row.fingerprint,
    state: row.state,
    atMs: row.at_ms,
    updatedAtMs: row.updated_at_ms,
    ...(row.order_id === null ? {} : { orderId: row.order_id }),
    ...(row.cents === null ? {} : { cents: row.cents }),
  };
}

export function createOrderAttemptStore(options: { readonly filePath?: string } = {}): OrderAttemptStore {
  const configured = options.filePath ?? process.env.ORDER_STATE_DB?.trim();
  if (!configured) return new InMemoryOrderAttemptStore();
  return new SqliteOrderAttemptStore(configured);
}

export function createProductionOrderAttemptStore(): OrderAttemptStore {
  const configured = process.env.ORDER_STATE_DB?.trim() || resolve('.cache', 'order-state.sqlite');
  const rawTimeout = Number.parseInt(process.env.ORDER_PENDING_TIMEOUT_MS ?? '', 10);
  const timeoutMs = Number.isInteger(rawTimeout) && rawTimeout > 0 ? rawTimeout : 5 * 60 * 1000;
  return new SqliteOrderAttemptStore(configured, timeoutMs);
}
