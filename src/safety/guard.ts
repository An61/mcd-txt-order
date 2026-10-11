/**
 * 下单守卫：幂等 / 冷却 / 限额（SEC-3 / SEC-4 / SEC-6 / SEC-7）。
 *
 * 这一层是「最后一道刹车」。即便上层会话状态机或确认令牌出了漏洞，
 * 守卫也应当拦住重复扣款。四条防线：
 *
 *   1. **幂等**：同一用户 + 同一购物车指纹，一辈子只允许成功一次。
 *   2. **冷却**：两次真实下单之间必须间隔一段时间，防手滑连发。
 *   3. **限额**：每小时次数、每天次数、单笔金额、每天累计金额，四道闸门。
 *   4. **失败不重试**：指纹一旦进入 failed 终态，后续任何针对该指纹的请求一律拒绝，
 *      用户必须重新发一次点单指令。宁可让用户多点一次，也不能下出第二笔（SEC-6）。
 *
 * 关于为什么不用「概率性的时间窗」而要用指纹锁定：
 *   微信会在超时后重发同一条消息最多 3 次（FR-24），也就是说用户只发了一次「确认」，
 *    服务端可能收到 4 次。这时候靠「几秒内去重」是不够稳的，必须靠指纹做确定性判定。
 */

import type { Cart } from '../domain/types.ts';
import { cartFingerprint } from '../mcp/normalize.ts';
import {
  InMemoryOrderAttemptStore,
  type OrderAttemptStore,
} from './orderAttemptStore.ts';

// ─────────────────────────────────────────────────────────────
// 策略
// ─────────────────────────────────────────────────────────────

export interface GuardPolicy {
  /** 两次成功下单之间的最小间隔 */
  readonly cooldownMs: number;
  readonly maxPerHour: number;
  readonly maxPerDay: number;
  /** 单笔上限（分） */
  readonly maxCentsPerOrder: number;
  /** 每天累计上限（分） */
  readonly maxCentsPerDay: number;
  /** 超过这个金额（分）需要「强化二次确认」；不拦截，只是要求再答一次 */
  readonly strongConfirmAboveCents: number;
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  cooldownMs: 60_000,
  maxPerHour: 3,
  maxPerDay: 8,
  maxCentsPerOrder: 20_000,
  maxCentsPerDay: 50_000,
  strongConfirmAboveCents: 10_000,
};

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function guardPolicyFromEnv(): GuardPolicy {
  return {
    cooldownMs: intFromEnv('ORDER_COOLDOWN_MS', DEFAULT_GUARD_POLICY.cooldownMs),
    maxPerHour: intFromEnv('ORDER_MAX_PER_HOUR', DEFAULT_GUARD_POLICY.maxPerHour),
    maxPerDay: intFromEnv('ORDER_MAX_PER_DAY', DEFAULT_GUARD_POLICY.maxPerDay),
    maxCentsPerOrder: intFromEnv('ORDER_MAX_CENTS_PER_ORDER', DEFAULT_GUARD_POLICY.maxCentsPerOrder),
    maxCentsPerDay: intFromEnv('ORDER_MAX_CENTS_PER_DAY', DEFAULT_GUARD_POLICY.maxCentsPerDay),
    strongConfirmAboveCents: intFromEnv(
      'ORDER_STRONG_CONFIRM_ABOVE_CENTS',
      DEFAULT_GUARD_POLICY.strongConfirmAboveCents,
    ),
  };
}

// ─────────────────────────────────────────────────────────────
// 结果类型
// ─────────────────────────────────────────────────────────────

export type BlockReason =
  | 'duplicate-pending'
  | 'duplicate-settled'
  | 'cooldown'
  | 'hourly-limit'
  | 'daily-limit'
  | 'order-amount-limit'
  | 'daily-amount-limit'
  | 'auth-failed';

export type Verdict =
  | { readonly kind: 'allowed' }
  /** 允许，但金额超过阈值，必须再要一次「确认」才继续（FR-15） */
  | {
      readonly kind: 'needs-strong-confirm';
      readonly thresholdCents: number;
      readonly message: string;
    }
  | {
      readonly kind: 'blocked';
      readonly reason: BlockReason;
      readonly message: string;
      readonly retryAfterMs?: number;
      /** 已存在的成功订单号（幂等命中时给回，避免用户以为没下成功） */
      readonly existingOrderId?: string;
    };

export interface EvaluateInput {
  readonly userId: string;
  readonly cart: Cart;
  /** calculate-price 给出的实付金额（分）。没有就传 undefined */
  readonly payableCents?: number;
  /** 用户是否已经对超阈值金额做过强化确认 */
  readonly strongConfirmed?: boolean;
}

interface AttemptRecord {
  readonly fingerprint: string;
  readonly atMs: number;
  state: 'pending' | 'succeeded' | 'failed' | 'unknown';
  orderId?: string;
  /** 成功时的实付金额（分），用于每日累计限额 */
  cents?: number;
}

interface UserRecord {
  attempts: AttemptRecord[];
  lastSuccessAtMs?: number;
  authFailedAtMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

// ─────────────────────────────────────────────────────────────
// 实现
// ─────────────────────────────────────────────────────────────

export class OrderGuard {
  private readonly policy: GuardPolicy;
  private readonly users = new Map<string, UserRecord>();
  private readonly now: () => number;
  private readonly store: OrderAttemptStore;

  constructor(options?: { policy?: GuardPolicy; now?: () => number; store?: OrderAttemptStore }) {
    this.policy = options?.policy ?? guardPolicyFromEnv();
    this.now = options?.now ?? (() => Date.now());
    this.store = options?.store ?? new InMemoryOrderAttemptStore();
  }

  /**
   * 判定能否下单。**不产生副作用** —— 真正占位要调 {@link OrderGuard.begin}。
   * 这样「用户发了确认但还在犹豫」不会白白消耗冷却时间。
   */
  evaluate(input: EvaluateInput): Verdict {
    const nowMs = this.now();
    const user = this.syncUser(input.userId);
    const fingerprint = cartFingerprint(input.cart);

    // SEC-7：凭据失效后，一切写操作立刻停摆
    if (user?.authFailedAtMs !== undefined) {
      return block(
        'auth-failed',
        '登录信息已失效，已停止下单。请重新申请 Token 后再试。',
      );
    }

    // 1) 幂等：这个指纹此前出现过吗
    const prior = user?.attempts.find((a) => a.fingerprint === fingerprint);
    if (prior) {
      if (prior.state === 'pending') {
        return block('duplicate-pending', '这笔订单正在处理中，请不要重复确认。');
      }
      if (prior.state === 'succeeded') {
        return {
          kind: 'blocked',
          reason: 'duplicate-settled',
          message: prior.orderId
            ? `这笔订单已经下过了（${prior.orderId}），不会重复下单。`
            : '这笔订单已经下过了，不会重复下单。',
          existingOrderId: prior.orderId,
        };
      }
      if (prior.state === 'unknown') {
        return block(
          'duplicate-settled',
          '这笔订单的结果暂时无法确认，已停止自动重试。请先到订单记录核对，再重新发起点单。',
        );
      }
      return block(
        'duplicate-settled',
        '上一次这笔订单没有成功，为了不重复扣款，我们不会自动重试。请重新发送点单指令。',
      );
    }

    // 2) 冷却
    if (user?.lastSuccessAtMs !== undefined) {
      const waited = nowMs - user.lastSuccessAtMs;
      if (waited < this.policy.cooldownMs) {
        const retryAfterMs = this.policy.cooldownMs - waited;
        return block(
          'cooldown',
          `刚下过一笔订单，请 ${Math.ceil(retryAfterMs / 1000)} 秒后再试（防手滑保护）。`,
          retryAfterMs,
        );
      }
    }

    // 3) 次数限额
    const successes = (user?.attempts ?? []).filter(
      (a) => a.state === 'succeeded' && a.atMs >= nowMs - HOUR_MS,
    ).length;
    if (successes >= this.policy.maxPerHour) {
      return block(
        'hourly-limit',
        `每小时最多 ${this.policy.maxPerHour} 笔，已经到上限了，请稍后再来。`,
        this.nextSlotMs(user, HOUR_MS),
      );
    }
    const todayCount = (user?.attempts ?? []).filter(
      (a) => a.state === 'succeeded' && a.atMs >= nowMs - DAY_MS,
    ).length;
    if (todayCount >= this.policy.maxPerDay) {
      return block(
        'daily-limit',
        `每天最多 ${this.policy.maxPerDay} 笔，今天已经到上限了。`,
        this.nextSlotMs(user, DAY_MS),
      );
    }

    // 4) 金额限额
    const payable = input.payableCents;
    if (payable !== undefined) {
      if (payable > this.policy.maxCentsPerOrder) {
        return block(
          'order-amount-limit',
          `单笔金额不能超过 ${yuan(this.policy.maxCentsPerOrder)}，这笔是 ${yuan(payable)}。请减少数量后重试。`,
        );
      }
      const todayCents = (user?.attempts ?? [])
        .filter((a) => a.state === 'succeeded' && a.atMs >= nowMs - DAY_MS)
        .reduce((sum, a) => sum + (a.cents ?? 0), 0);
      if (todayCents + payable > this.policy.maxCentsPerDay) {
        return block(
          'daily-amount-limit',
          `每天累计不能超过 ${yuan(this.policy.maxCentsPerDay)}，今天已经下了 ${yuan(todayCents)}。`,
        );
      }
      if (
        payable > this.policy.strongConfirmAboveCents &&
        input.strongConfirmed !== true
      ) {
        return {
          kind: 'needs-strong-confirm',
          thresholdCents: this.policy.strongConfirmAboveCents,
          message:
            `这笔要付 ${yuan(payable)}，超过 ${yuan(this.policy.strongConfirmAboveCents)}。` +
            `确认无误请再回复一次「确认」。`,
        };
      }
    }

    return { kind: 'allowed' };
  }

  /**
   * 占位：把指纹标记为 pending，返回是否抢到。
   * 微信重发导致的并发确认只会有一个抢到。
   */
  begin(input: EvaluateInput): { acquired: boolean; verdict: Verdict } {
    const verdict = this.evaluate(input);
    if (verdict.kind !== 'allowed') return { acquired: false, verdict };

    const nowMs = this.now();
    const fingerprint = cartFingerprint(input.cart);
    const claimed = this.store.claim({
      userId: input.userId,
      fingerprint,
      atMs: nowMs,
      cents: input.payableCents,
    });
    if (!claimed.acquired) {
      return { acquired: false, verdict: this.evaluate(input) };
    }
    this.syncUser(input.userId);
    return { acquired: true, verdict: { kind: 'allowed' } };
  }

  /** 下单成功。成功后指纹成为终态，永远不会再下第二笔 */
  succeed(userId: string, cart: Cart, orderId?: string, cents?: number): void {
    const user = this.syncUser(userId);
    const fingerprint = cartFingerprint(cart);
    const nowMs = this.now();
    if (!this.store.get(userId, fingerprint)) {
      this.store.claim({ userId, fingerprint, atMs: nowMs, cents });
    }
    const settled = this.store.settleSuccess(userId, fingerprint, orderId, cents, nowMs);
    this.syncUser(userId);
    if (settled.state === 'succeeded') user.lastSuccessAtMs = settled.updatedAtMs;
  }

  /**
   * 下单失败。**失败也进终态** —— SEC-6：绝不自动重试 create-order。
   * 用户想要重来，必须重新发一次点单指令，从而生成新的预览与新指纹。
   */
  fail(userId: string, cart: Cart): void {
    this.syncUser(userId);
    const fingerprint = cartFingerprint(cart);
    const nowMs = this.now();
    if (!this.store.get(userId, fingerprint)) {
      this.store.claim({ userId, fingerprint, atMs: nowMs });
    }
    this.store.settleFailure(userId, fingerprint, nowMs);
    this.syncUser(userId);
  }

  /** Provider timeout/transport ambiguity is terminal until a human checks the order. */
  markUnknown(userId: string, cart: Cart): void {
    this.syncUser(userId);
    const fingerprint = cartFingerprint(cart);
    const nowMs = this.now();
    if (!this.store.get(userId, fingerprint)) {
      this.store.claim({ userId, fingerprint, atMs: nowMs });
    }
    this.store.markUnknown(userId, fingerprint, nowMs);
    this.syncUser(userId);
  }

  /** SEC-7：401/403 之后立刻冻结该用户的所有写操作 */
  markAuthFailed(userId: string): void {
    const nowMs = this.now();
    this.store.setAuthFailed(userId, nowMs);
    this.syncUser(userId);
  }

  /** 重新拿到 Token 后解冻 */
  clearAuthFailed(userId: string): void {
    this.store.clearAuthFailed(userId);
    this.syncUser(userId);
  }

  stats(userId: string): {
    readonly hourCount: number;
    readonly dayCount: number;
    readonly lastSuccessAtMs?: number;
    readonly authFailed: boolean;
  } {
    const nowMs = this.now();
    const user = this.syncUser(userId);
    const attempts = user.attempts;
    return {
      hourCount: attempts.filter((a) => a.state === 'succeeded' && a.atMs >= nowMs - HOUR_MS)
        .length,
      dayCount: attempts.filter((a) => a.state === 'succeeded' && a.atMs >= nowMs - DAY_MS).length,
      ...(user.lastSuccessAtMs === undefined
        ? {}
        : { lastSuccessAtMs: user.lastSuccessAtMs }),
      authFailed: user.authFailedAtMs !== undefined,
    };
  }

  private ensure(userId: string): UserRecord {
    const existing = this.users.get(userId);
    if (existing) return existing;
    const created: UserRecord = { attempts: [] };
    this.users.set(userId, created);
    return created;
  }

  private syncUser(userId: string): UserRecord {
    const user = this.ensure(userId);
    const stored = this.store.list(userId);
    user.attempts = stored.map((attempt) => ({
      fingerprint: attempt.fingerprint,
      atMs: attempt.state === 'succeeded' ? attempt.updatedAtMs : attempt.atMs,
      state: attempt.state,
      ...(attempt.orderId === undefined ? {} : { orderId: attempt.orderId }),
      ...(attempt.cents === undefined ? {} : { cents: attempt.cents }),
    }));
    const latestSuccess = stored
      .filter((attempt) => attempt.state === 'succeeded')
      .map((attempt) => attempt.updatedAtMs)
      .sort((a, b) => b - a)[0];
    if (latestSuccess === undefined) delete user.lastSuccessAtMs;
    else user.lastSuccessAtMs = latestSuccess;
    const authFailedAtMs = this.store.getAuthFailedAt(userId);
    if (authFailedAtMs === undefined) delete user.authFailedAtMs;
    else user.authFailedAtMs = authFailedAtMs;
    return user;
  }

  private nextSlotMs(user: UserRecord | undefined, windowMs: number): number | undefined {
    const attempts = user?.attempts ?? [];
    const stamps = attempts
      .filter((a) => a.state === 'succeeded')
      .map((a) => a.atMs)
      .sort((a, b) => a - b);
    if (stamps.length === 0) return undefined;
    const oldest = stamps[0] ?? this.now();
    const slot = oldest + windowMs - this.now();
    return slot > 0 ? slot : undefined;
  }
}

function block(reason: BlockReason, message: string, retryAfterMs?: number): Verdict {
  return retryAfterMs === undefined
    ? { kind: 'blocked', reason, message }
    : { kind: 'blocked', reason, message, retryAfterMs };
}
