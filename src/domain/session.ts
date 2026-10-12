/**
 * 会话状态机（FR-17 / FR-18）。
 *
 *   idle ──识别出点单意图──► clarifying ──选定餐品──► confirming ──确认通过──► placed
 *    ▲          ▲                  │                      │                      │
 *    │          │              (取消/超时)            (取消/超时)              (完成/超时)
 *    └──────────┴──────────────────┴──────────────────────┴──────────────────────┘
 *
 * 两条硬性规则：
 *   1. **只有 confirming 态允许下单**。其它任何状态下收到「确认」都不会触达 create-order。
 *      这是 SEC-1 的机器级保证 —— 不是靠"我们记得判断"，而是靠状态根本走不过去。
 *   2. **超时一律回落到 idle 并丢弃购物车**。宁可让用户重说一遍，也不留下一份
 *      "用户可能已经忘了、但还能一键付款"的预览。
 *
 * 为什么澄清态要独立出来：
 *   实测菜单里「麦辣」能同时命中好几款。若强行取第一名，用户会说"我不要这个"。
 *   留一个 clarifying 态让用户用「1 / 第一个」选，比猜错强。
 */

import { randomUUID } from 'node:crypto';
import type { Cart, OrderPreview, OrderResult } from './types.ts';

export type SessionState = 'idle' | 'clarifying' | 'confirming' | 'placed';

/** 待澄清候选项 */
export interface ClarifyCandidate<T = unknown> {
  readonly label: string;
  readonly value: T;
}

export type CandidateKind = 'store' | 'item';

export interface SessionDraft {
  /** 用户原文，用于「重复同一句话＝确认」这种宽容处理 */
  readonly rawText: string;
  /** 已解析出的餐品意图（含数量、特制） */
  readonly specs: readonly unknown[];
  /** 已锁定的门店（可能为 undefined，表示待定） */
  readonly storeCode?: string;
  /** 澄清中的候选项 */
  readonly candidates?: readonly ClarifyCandidate[];
  /** Candidate snapshot identity. It is single-use and scoped to this user session. */
  readonly candidateSnapshotId?: string;
  /** Candidate snapshot expiry. Selection after this time is rejected. */
  readonly candidateExpiresAtMs?: number;
  /** Which resolution layer owns this candidate list. */
  readonly candidateKind?: CandidateKind;
  /** 当前正在澄清第几个餐品 */
  readonly clarifyingIndex?: number;
}

export interface Session {
  readonly userId: string;
  readonly state: SessionState;
  readonly updatedAtMs: number;
  readonly expiresAtMs: number;
  readonly draft?: SessionDraft;
  readonly cart?: Cart;
  readonly preview?: OrderPreview;
  /** 当前预览对应的一次性确认令牌。仅为便利存引用，真正的判定在 ConfirmationService 里 */
  readonly confirmToken?: string;
  /** FR-15：金额超阈值后用户是否已再次明确确认 */
  readonly strongConfirmed?: boolean;
  readonly lastError?: string;
  /** 上一笔成功的订单。注意：支付链接只发给本人，绝不进日志（SEC-5） */
  readonly lastOrderId?: string;
  /** 跨会话记忆：上次用的门店，让"再来一份"能复用 */
  readonly lastStoreCode?: string;
  readonly turnCount: number;
}

export type TransitionError =
  | 'illegal-transition'
  | 'missing-preview'
  | 'missing-draft'
  | 'not-found';

export type CandidateSelectionError =
  | 'not-clarifying'
  | 'missing-snapshot'
  | 'candidate-expired'
  | 'invalid-selection';

export type CandidateSelectionResult =
  | {
      readonly ok: true;
      readonly candidate: ClarifyCandidate;
      readonly draft: SessionDraft;
    }
  | {
      readonly ok: false;
      readonly error: CandidateSelectionError;
      readonly message: string;
    };

export type TransitionResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly error: TransitionError; readonly message: string };

export interface SessionStoreOptions {
  /** 普通态 TTL，默认 10 分钟 */
  readonly ttlMs?: number;
  /** 待确认态 TTL，默认 5 分钟（FR-12 预览卡片超时失效） */
  readonly previewTtlMs?: number;
  readonly now?: () => number;
  /** 内存中保留的最大会话数，防止长期运行无限增长 */
  readonly maxSessions?: number;
}

const MINUTE = 60 * 1000;

export const DEFAULT_TTL_MS = 10 * MINUTE;
export const DEFAULT_PREVIEW_TTL_MS = 5 * MINUTE;

/**
 * 允许的迁移表。显式列出来而不是写 if-else ——
 * 因为这类控制芜杂、"看起来顺理成章"的迁移往往正是事故来源。
 *
 * 关键约束：**`placed` 只能由 `confirming` 进入**。
 * 这条配合 {@link canPlaceOrder}，让 SEC-1 不再是"记得判断"，而是"走不过去"。
 */
const ALLOWED: Readonly<Record<SessionState, readonly SessionState[]>> = {
  idle: ['clarifying', 'confirming'],
  clarifying: ['clarifying', 'confirming', 'idle'],
  confirming: ['confirming', 'placed', 'idle', 'clarifying'],
  placed: ['idle', 'clarifying', 'confirming'],
};

export interface SessionPatch {
  readonly draft?: SessionDraft | null;
  readonly cart?: Cart | null;
  readonly preview?: OrderPreview | null;
  readonly confirmToken?: string | null;
  readonly strongConfirmed?: boolean | null;
  readonly lastError?: string | null;
  readonly lastOrderId?: string | null;
  readonly lastStoreCode?: string | null;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly previewTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    this.ttlMs = intOr(options.ttlMs, DEFAULT_TTL_MS);
    this.previewTtlMs = intOr(options.previewTtlMs, DEFAULT_PREVIEW_TTL_MS);
    this.maxSessions = intOr(options.maxSessions, 5_000);
    this.now = options.now ?? (() => Date.now());
  }

  /** 取会话。不存在则新建一个 idle 会话 */
  get(userId: string): Session {
    const existing = this.sessions.get(userId);
    const nowMs = this.now();

    if (existing) {
      if (existing.expiresAtMs <= nowMs) {
        return this.reset(userId, existing, '会话已过期，已重新开始');
      }
      return existing;
    }

    if (this.sessions.size >= this.maxSessions) this.evictOldest();

    const created: Session = {
      userId,
      state: 'idle',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      turnCount: 0,
    };
    this.sessions.set(userId, created);
    return created;
  }

  /** 只看一眼，不创建 */
  peek(userId: string): Session | undefined {
    const found = this.sessions.get(userId);
    if (!found) return undefined;
    return found.expiresAtMs <= this.now() ? undefined : found;
  }

  /** 续期（每次用户发言都调用） */
  touch(userId: string): Session {
    const session = this.get(userId);
    const nowMs = this.now();
    const ttl = session.state === 'confirming' ? this.previewTtlMs : this.ttlMs;
    const next: Session = { ...session, updatedAtMs: nowMs, expiresAtMs: nowMs + ttl };
    this.sessions.set(userId, next);
    return next;
  }

  /** 进入澄清态 */
  toClarifying(userId: string, draft: SessionDraft): TransitionResult {
    const session = this.touch(userId);
    if (!ALLOWED[session.state].includes('clarifying')) return illegal(session.state, 'clarifying');
    const candidateDraft = draft.candidates && draft.candidates.length > 0
      ? {
          ...draft,
          candidateSnapshotId: randomUUID(),
          candidateExpiresAtMs: this.now() + this.ttlMs,
        }
      : draft;
    return this.commit(userId, session, 'clarifying', { draft: candidateDraft, cart: null, preview: null });
  }

  /**
   * Atomically validate and consume one candidate. The snapshot is removed before
   * any asynchronous gateway work starts, so duplicate or concurrent replies cannot
   * resolve the same candidate twice.
   */
  consumeCandidate(userId: string, snapshotId: string, index: number): CandidateSelectionResult {
    const existing = this.sessions.get(userId);
    if (
      existing?.state === 'clarifying' &&
      existing.draft?.candidateSnapshotId === snapshotId &&
      (existing.expiresAtMs <= this.now() ||
        existing.draft.candidateExpiresAtMs === undefined ||
        this.now() >= existing.draft.candidateExpiresAtMs)
    ) {
      this.reset(userId, existing, '候选列表已过期，请重新发起点单');
      return { ok: false, error: 'candidate-expired', message: '候选列表已过期，请重新发起点单。' };
    }
    const session = this.get(userId);
    const draft = session.draft;
    if (session.state !== 'clarifying') {
      return { ok: false, error: 'not-clarifying', message: '当前没有待选择的候选。' };
    }
    if (!draft?.candidateSnapshotId || draft.candidateSnapshotId !== snapshotId) {
      return { ok: false, error: 'missing-snapshot', message: '候选列表已失效，请重新发起点单。' };
    }
    if (draft.candidateExpiresAtMs === undefined || this.now() >= draft.candidateExpiresAtMs) {
      this.toIdle(userId);
      return { ok: false, error: 'candidate-expired', message: '候选列表已过期，请重新发起点单。' };
    }
    if (!Number.isSafeInteger(index) || index < 1 || index > (draft.candidates?.length ?? 0)) {
      return { ok: false, error: 'invalid-selection', message: '候选序号无效，请回复列表中的数字。' };
    }
    const candidate = draft.candidates?.[index - 1];
    if (!candidate) return { ok: false, error: 'invalid-selection', message: '候选序号无效，请重新发起点单。' };
    this.commit(userId, session, 'idle', {
      draft: null,
      cart: null,
      preview: null,
      confirmToken: null,
      strongConfirmed: null,
    });
    return { ok: true, candidate, draft };
  }

  /** 进入待确认态。必须带 preview —— 没有算价结果的预览不允许进入 */
  toConfirming(userId: string, preview: OrderPreview, confirmToken?: string): TransitionResult {
    const session = this.touch(userId);
    if (!ALLOWED[session.state].includes('confirming')) return illegal(session.state, 'confirming');
    if (!preview) return { ok: false, error: 'missing-preview', message: '缺少订单预览，无法进入待确认' };
    return this.commit(userId, session, 'confirming', {
      preview,
      cart: preview.cart,
      draft: null,
      lastError: null,
      confirmToken: confirmToken ?? null,
      strongConfirmed: false,
    });
  }

  /** 下单成功 */
  toPlaced(userId: string, orderId?: string, storeCode?: string): TransitionResult {
    const session = this.touch(userId);
    if (!ALLOWED[session.state].includes('placed')) return illegal(session.state, 'placed');
    return this.commit(userId, session, 'placed', {
      lastOrderId: orderId ?? null,
      ...(storeCode ? { lastStoreCode: storeCode } : {}),
      // 已下单：令牌、购物车、预览一并丢弃，不给"再来一次确认"留后门
      draft: null,
      cart: null,
      preview: null,
      confirmToken: null,
      strongConfirmed: null,
    });
  }

  /** 回到空闲态。购物车随之丢弃，避免留下可付费的残留状态 */
  toIdle(userId: string): TransitionResult {
    const session = this.touch(userId);
    return this.commit(userId, session, 'idle', {
      draft: null,
      cart: null,
      preview: null,
      confirmToken: null,
      strongConfirmed: null,
      lastError: null,
    });
  }

  /** 记录一次失败，但保留当前态（让用户可以再试一次或改主意） */
  markError(userId: string, message: string): Session {
    const session = this.touch(userId);
    const next: Session = { ...session, lastError: message };
    this.sessions.set(userId, next);
    return next;
  }

  patch(userId: string, patch: SessionPatch): Session {
    const session = this.touch(userId);
    const next = applyPatch(session, patch);
    this.sessions.set(userId, next);
    return next;
  }

  reset(userId: string, session?: Session, reason?: string): Session {
    const base = session ?? this.sessions.get(userId);
    const nowMs = this.now();
    const next: Session = {
      userId,
      state: 'idle',
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
      turnCount: (base?.turnCount ?? 0) + 1,
      ...(base?.lastStoreCode ? { lastStoreCode: base.lastStoreCode } : {}),
      ...(base?.lastOrderId ? { lastOrderId: base.lastOrderId } : {}),
      ...(reason ? { lastError: reason } : {}),
    };
    this.sessions.set(userId, next);
    return next;
  }

  /** 清理过期会话；返回清理数量 */
  sweep(): number {
    const nowMs = this.now();
    let removed = 0;
    for (const [userId, session] of this.sessions) {
      if (session.expiresAtMs > nowMs) continue;
      this.sessions.delete(userId);
      removed += 1;
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }

  // ── 内部 ────────────────────────────────────────────────

  private commit(
    userId: string,
    session: Session,
    nextState: SessionState,
    patch: SessionPatch,
  ): TransitionResult {
    const nowMs = this.now();
    const ttl = nextState === 'confirming' ? this.previewTtlMs : this.ttlMs;
    const next: Session = {
      ...applyPatch(session, patch),
      state: nextState,
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + ttl,
      turnCount: session.turnCount + 1,
    };
    this.sessions.set(userId, next);
    return { ok: true, session: next };
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [userId, session] of this.sessions) {
      if (session.updatedAtMs < oldestAt) {
        oldestAt = session.updatedAtMs;
        oldestKey = userId;
      }
    }
    if (oldestKey) this.sessions.delete(oldestKey);
  }
}

function intOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function illegal(from: SessionState, to: SessionState): TransitionResult {
  return {
    ok: false,
    error: 'illegal-transition',
    message: `不允许的状态迁移：${from} → ${to}`,
  };
}

function applyPatch(session: Session, patch: SessionPatch): Session {
  const next: Record<string, unknown> = { ...session };
  for (const key of Object.keys(patch) as (keyof SessionPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as unknown as Session;
}

/** 只读判断：这个状态按下按钮会真的付钱吗。给调用方做兜底检查用 */
export function canPlaceOrder(session: Session): boolean {
  return session.state === 'confirming' && session.preview !== undefined;
}

export function describeState(state: SessionState): string {
  switch (state) {
    case 'idle':
      return '空闲';
    case 'clarifying':
      return '待澄清';
    case 'confirming':
      return '待确认';
    case 'placed':
      return '已下单';
    default:
      return '未知';
  }
}

/** 订单结果只保留可公开字段，支付链接不落盘、不进日志（SEC-5） */
export function publicizeOrder(result: OrderResult): { orderId: string; hasPayUrl: boolean } {
  return { orderId: result.orderId, hasPayUrl: result.payUrl.length > 0 };
}
