/**
 * 一次性确认令牌（SEC-2 / SEC-5）。
 *
 * 为什么需要它：
 *   `create-order` 会产生**真实订单与真实支付链接**。如果「确认」只是一个布尔开关，
 *   那么任何一条漏判的消息都能替用户花掉真金白银。所以确认必须是一个
 *   **绑定到具体购物车、绑定到具体用户、只能用一次、且会过期**的凭据。
 *
 * 令牌形态：`随机串.签名`，签名内容覆盖 userId / 指纹 / 随机串 / 过期时间。
 *   这样即使有人拿到令牌字符串，也无法改绑到别人的购物车或别的购物车。
 *   服务端仍保留内存记录，用来做「一次性」判定（签名只能证明没被篡改，证明不了没被用过）。
 *
 * 刻意不做的两件事：
 *   1. **不做持久化**。进程重启后所有令牌立即失效 —— 失效方向是安全的：
 *      用户最多是重新收到一次预览，绝不会出现「重启后凭旧令牌下出订单」。
 *   2. **不做任何重试**。令牌一旦被消费（无论成功失败）就消失。失败只能重新走一遍
 *      「发指令 → 出预览 → 确认」，绝不自动重试 create-order（SEC-6）。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Cart } from '../domain/types.ts';
import { cartFingerprint } from '../mcp/normalize.ts';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

export interface ConfirmationPolicy {
  /** 令牌有效期，默认 5 分钟。过期后必须重新出预览 */
  readonly ttlMs: number;
  /** 每个用户最多同时存在几个待确认令牌，超出时最旧的作废 */
  readonly maxPendingPerUser: number;
}

export const DEFAULT_CONFIRMATION_POLICY: ConfirmationPolicy = {
  ttlMs: 5 * 60 * 1000,
  maxPendingPerUser: 3,
};

export function confirmationPolicyFromEnv(): ConfirmationPolicy {
  const ttl = Number.parseInt(process.env.CONFIRM_TTL_MS ?? '', 10);
  const max = Number.parseInt(process.env.CONFIRM_MAX_PENDING ?? '', 10);
  return {
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_CONFIRMATION_POLICY.ttlMs,
    maxPendingPerUser:
      Number.isFinite(max) && max > 0 ? max : DEFAULT_CONFIRMATION_POLICY.maxPendingPerUser,
  };
}

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface ConfirmationTicket {
  readonly token: string;
  readonly userId: string;
  /** 购物车指纹 —— 令牌只能用于签发它的那份购物车 */
  readonly fingerprint: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export type ConfirmFailure =
  | 'malformed'
  | 'unknown-token'
  | 'wrong-user'
  | 'fingerprint-mismatch'
  | 'expired'
  | 'fingerprint-changed'
  | 'consumed';

export type ConfirmResult =
  | { readonly ok: true; readonly ticket: ConfirmationTicket }
  | { readonly ok: false; readonly reason: ConfirmFailure; readonly message: string };

const FAILURE_MESSAGES: Readonly<Record<ConfirmFailure, string>> = {
  malformed: '确认信息格式不对，请重新发起一次点单。',
  'unknown-token': '没找到对应的待确认订单，可能已经失效，请重新发起一次点单。',
  'wrong-user': '这个确认不是发给你的，已忽略。',
  'fingerprint-mismatch': '订单内容已经变了，之前那笔已作废。请确认当前这笔。',
  'fingerprint-changed': '订单内容与确认时不一致，已作废，请重新发起。',
  expired: '这个确认已经超时了，请重新发送点单指令。',
  consumed: '这笔订单已经处理过了，不能重复确认。',
};

interface StoredTicket extends ConfirmationTicket {
  /** 已被消费（无论下单成功还是失败） */
  used: boolean;
  /** 主动作废（比如连 M 前用户改了购物车） */
  revoked: boolean;
}

// ─────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────

const TOKEN_VERSION = 'c1';

/**
 * 进程级密钥。优先取环境变量（多实例部署时必须配，否则跨实例令牌互不认），
 * 没配就随机生成一个 —— 单机演示够用，代价是重启后旧令牌失效（这正好是我们要的方向）。
 */
function secret(): string {
  const fromEnv = process.env.CONFIRM_SECRET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return randomBytes(32).toString('hex');
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // 长度不同时也必须走一次比较，避免通过耗时侧信道推断长度
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export class ConfirmationService {
  private readonly key: string;
  private readonly policy: ConfirmationPolicy;
  private readonly tickets = new Map<string, StoredTicket>();
  /** userId → token 列表（按签发顺序），用于上限清理与按用户作废 */
  private readonly byUser = new Map<string, string[]>();
  private readonly now: () => number;

  constructor(options?: { policy?: ConfirmationPolicy; now?: () => number }) {
    this.key = secret();
    this.policy = options?.policy ?? confirmationPolicyFromEnv();
    this.now = options?.now ?? (() => Date.now());
  }

  /**
   * 为一辆车签发令牌。
   * 同一用户对同一指纹重复签发时（比如预览卡片被重发），旧令牌会被作废 ——
   * 保证任何时刻只有**最新那张预览**可被确认，避免"用户看到新价格却确认了旧的那张"。
   */
  issue(input: { userId: string; cart: Cart; ttlMs?: number }): ConfirmationTicket {
    const nowMs = this.now();
    const fingerprint = cartFingerprint(input.cart);
    const ttlMs = input.ttlMs ?? this.policy.ttlMs;
    const expiresAtMs = nowMs + ttlMs;

    this.revokeFingerprint(input.userId, fingerprint);

    const nonce = randomBytes(16).toString('base64url');
    const body = [TOKEN_VERSION, input.userId, fingerprint, nonce, String(expiresAtMs)].join('|');
    const token = `${nonce}.${sign(body, this.key)}`;

    const ticket: ConfirmationTicket = {
      token,
      userId: input.userId,
      fingerprint,
      issuedAtMs: nowMs,
      expiresAtMs,
    };

    this.tickets.set(token, { ...ticket, used: false, revoked: false });
    const list = this.byUser.get(input.userId) ?? [];
    list.push(token);
    this.byUser.set(input.userId, list.slice(-this.policy.maxPendingPerUser));

    this.enforceUserLimit(input.userId);
    return ticket;
  }

  /** 只看不消费 —— 用于「用户说了确认，但金额超阈值要再问一句」的场景 */
  peek(token: string, userId: string, fingerprint?: string): ConfirmResult {
    return this.check(token, userId, fingerprint, false);
  }

  /**
   * 校验并消费令牌。
   * @param fingerprint 当前购物车指纹；传入时会与签发时比对，不一致一律拒绝。
   */
  consume(token: string, userId: string, fingerprint?: string): ConfirmResult {
    return this.check(token, userId, fingerprint, true);
  }

  /**
   * 作废同一用户的**全部**待确认令牌。用户说「算了」、或者购物车被重建时调用。
   * @returns 实际作废的令牌数
   */
  revokeUser(userId: string): number {
    const tokens = this.byUser.get(userId) ?? [];
    let revoked = 0;
    for (const token of tokens) {
      const stored = this.tickets.get(token);
      if (!stored || stored.revoked) continue;
      this.tickets.set(token, { ...stored, revoked: true });
      revoked += 1;
    }
    return revoked;
  }

  /**
   * 只作废**同一份购物车**的旧令牌（签发新令牌时内部调用）。
   *
   * 目的：同一份预览被重复签发（比如用户连着问了两次同一样东西），
   * 只有最新那张能确认，防止用户按着旧记录误付。
   * **不同购物车的令牌互不影响** —— 用户可以同时谈着好几笔不同内容的单。
   */
  revokeFingerprint(userId: string, fingerprint: string): number {
    const tokens = this.byUser.get(userId) ?? [];
    let revoked = 0;
    for (const token of tokens) {
      const stored = this.tickets.get(token);
      if (!stored || stored.revoked) continue;
      if (stored.fingerprint !== fingerprint) continue;
      this.tickets.set(token, { ...stored, revoked: true });
      revoked += 1;
    }
    return revoked;
  }

  pendingCount(userId: string): number {
    const tokens = this.byUser.get(userId) ?? [];
    return tokens.filter((token) => {
      const stored = this.tickets.get(token);
      return stored && !stored.used && !stored.revoked && stored.expiresAtMs > this.now();
    }).length;
  }

  /** 清理过期令牌，防止长时间运行的进程无限堆积 */
  sweep(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [token, stored] of this.tickets) {
      const dead = stored.expiresAtMs <= nowMs || stored.used || stored.revoked;
      if (stored.expiresAtMs <= nowMs) {
        this.tickets.delete(token);
        removed += 1;
        continue;
      }
      if (dead) {
        this.tickets.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  // ── 内部 ────────────────────────────────────────────────

  private check(
    token: string,
    userId: string,
    fingerprint: string | undefined,
    markUsed: boolean,
  ): ConfirmResult {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return fail('malformed');
    }
    const stored = this.tickets.get(token);
    if (!stored) return fail('unknown-token');
    if (stored.userId !== userId) return fail('wrong-user');

    if (stored.revoked) return fail('unknown-token');
    if (stored.used) return fail('consumed');
    if (stored.expiresAtMs <= this.now()) return fail('expired');

    // 用当前指纹反推签名是否仍然成立，双重保险
    const nonce = parts[0];
    const body = [TOKEN_VERSION, userId, stored.fingerprint, nonce, String(stored.expiresAtMs)].join(
      '|',
    );
    if (!safeEqual(parts[1] ?? '', sign(body, this.key))) return fail('malformed');

    if (fingerprint !== undefined && fingerprint !== stored.fingerprint) {
      return this.markOrFail(stored, 'fingerprint-mismatch', markUsed);
    }

    if (markUsed) {
      this.tickets.set(stored.token, { ...stored, used: true });
    }

    return { ok: true, ticket: stored };
  }

  private markOrFail(
    stored: StoredTicket,
    reason: ConfirmFailure,
    markUsed: boolean,
  ): ConfirmResult {
    if (markUsed) this.tickets.set(stored.token, { ...stored, used: true });
    return fail(reason);
  }

  private enforceUserLimit(userId: string): void {
    const list = this.byUser.get(userId) ?? [];
    const alive = list.filter((token) => this.tickets.has(token));
    const overflow = alive.length - this.policy.maxPendingPerUser;
    if (overflow <= 0) return;

    for (const token of alive.slice(0, overflow)) {
      const stored = this.tickets.get(token);
      if (!stored) continue;
      this.tickets.set(token, { ...stored, revoked: true });
    }
    this.byUser.set(userId, alive.slice(overflow));
  }
}

function fail(reason: ConfirmFailure): ConfirmResult {
  return { ok: false, reason, message: FAILURE_MESSAGES[reason] };
}
