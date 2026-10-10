/**
 * 微信消息去重（T37 / FR-24，P0）。
 *
 * 为什么必须有这个东西 —— 这是微信官方写明的机制：
 * > 微信服务器在五秒内收不到响应会断掉连接，并且重新发起请求，总共重试三次。
 *
 * 也就是说一条「确认」最多会被投递 4 次。幂等守卫能保证不会重复下单，
 * 但拦不住另外两件同样麻烦的事：
 *   1. 生成 4 张一模一样的预览卡片，在手机上刷屏；
 *   2. 白烧 4 倍 MCP 配额（限流 600 次/分钟）。
 *
 * 官方推荐的排重口径：
 *   · 普通消息 → MsgId
 *   · 事件推送 → FromUserName + CreateTime
 * 本文件严格照此实现。
 */

/** 去重窗口。微信重试发生在 5s / 5s 量级，留 10 分钟余量足够覆盖网络抖动 */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** 上限保护：单实例最多记多少条 key，超出后淘汰最旧的（防止长期运行内存泄漏） */
const DEFAULT_MAX_ENTRIES = 5000;

export type DedupeVerdict =
  /** 首次见到，应当处理 */
  | 'process'
  /** 重复投递，应当丢弃 */
  | 'duplicate';

export interface DedupeOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * 极简 TTL 去重表。
 *
 * 不引入任何第三方依赖，也不做持久化 —— 这是刻意的：
 * 去重只是「少刷几次屏」的优化，**正确性由下游的幂等守卫保证**，
 * 所以这里丢一条（比如进程重启）最坏只是多刷一屏，不会重复下单。
 */
export class MessageDeduplicator {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Map 的插入顺序即淘汰顺序 */
  private readonly seen = new Map<string, number>();

  constructor(options: DedupeOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /**
   * 登记一条消息。
   * 返回 `process` 表示这是第一次见到；返回 `duplicate` 说明是微信的重试，调用方应当直接回 `success`。
   */
  check(key: string): DedupeVerdict {
    this.sweep();
    if (this.seen.has(key)) return 'duplicate';

    this.seen.set(key, this.now());
    this.trim();
    return 'process';
  }

  /** 仅查询，不登记 —— 用于只想看看有没有见过的场景 */
  has(key: string): boolean {
    this.sweep();
    return this.seen.has(key);
  }

  /** 主动遗忘（比如同一条消息处理失败、希望允许重试时） */
  forget(key: string): boolean {
    return this.seen.delete(key);
  }

  get size(): number {
    this.sweep();
    return this.seen.size;
  }

  /** 清掉过期项 */
  private sweep(): void {
    const nowMs = this.now();
    for (const [key, atMs] of this.seen) {
      if (nowMs - atMs >= this.ttlMs) this.seen.delete(key);
    }
  }

  /** 超容量时淘汰最旧的若干条 */
  private trim(): void {
    if (this.seen.size <= this.maxEntries) return;
    const overflow = this.seen.size - this.maxEntries;
    let removed = 0;
    for (const key of this.seen.keys()) {
      this.seen.delete(key);
      removed += 1;
      if (removed >= overflow) break;
    }
  }
}

/** 微信推送过来的原始字段（解析 XML 后的扁平对象） */
export interface WechatEnvelope {
  readonly msgId?: string;
  readonly fromUserName?: string;
  readonly createTime?: string;
  readonly msgType?: string;
  readonly event?: string;
}

/**
 * 按官方口径生成去重键。
 *
 * 注意：**事件消息没有 MsgId**，所以必须退化到 `FromUserName + CreateTime`。
 * 关注/取关这类事件会在同一秒内到达多个，这个组合是官方给的排重依据。
 */
export function dedupeKeyOf(envelope: WechatEnvelope): string | undefined {
  const msgId = envelope.msgId?.trim();
  if (msgId) return `msg:${msgId}`;

  const user = envelope.fromUserName?.trim();
  const time = envelope.createTime?.trim();
  if (user && time) return `evt:${user}:${time}`;

  return undefined;
}

/** 共享实例：HTTP 服务的多个请求之间必须共用同一张表，否则去重形同虚设 */
export const messageDeduplicator = new MessageDeduplicator();
