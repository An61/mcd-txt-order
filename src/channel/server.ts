/**
 * HTTP 服务（T22）。零依赖，纯 node:http。
 *
 * 一个进程同时提供四类入口，刻意如此 —— 评审者只需 `npm run serve` 就能全部体验：
 *   GET  /           网页模拟器（Tier 0，不需公众号）
 *   POST /api/chat   模拟器用的 JSON 对话接口
 *   GET  /wechat     公众号服务器配置校验
 *   POST /wechat     公众号消息接收（5 秒超时 → 异步推送）
 *   GET  /healthz    健康检查
 *
 * 关于 5 秒这条硬约束（FR-21）：
 * 找店 → 菜单 → 详情 → 算价 这条链路实测要 2~6 秒，必然有部分请求超时。
 * 处理办法是**双阶段响应**：先回 `success` 抑制微信重试，后台跑完再用客服消息推回去。
 * 没有客服消息权限时（个人订阅号），降级为「用户下次发言时把结果补上」。
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

import { ConversationCore } from './core.ts';
import { renderMockPage } from './mock.ts';
import {
  buildSuccessReply,
  buildTextReply,
  parseWechatXml,
  sendCustomText,
  verifySignature,
  AccessTokenProvider,
  type SendResult,
} from './wechat.ts';
import { MessageDeduplicator, dedupeKeyOf, type WechatEnvelope } from './dedupe.ts';

/**
 * 留给被动回复的余量。
 * 微信是 5 秒断连，这里设 4.3 秒 —— 剩下的时间要留给网络往返和序列化。
 */
const REPLY_DEADLINE_MS = 4300;

/** 待回补结果的存活时间（没客服接口时，等用户下次发言再补） */
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface ServerOptions {
  readonly core: ConversationCore;
  readonly port?: number;
  readonly token?: string;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly dedupe?: MessageDeduplicator;
  readonly modeLabel?: string;
  readonly now?: () => number;
  /** 留给被动回复的时间。默认 4.3 秒（微信 5 秒断连）；仅测试需要改它 */
  readonly replyDeadlineMs?: number;
}

interface PendingResult {
  readonly text: string;
  readonly atMs: number;
}

export class ChannelServer {
  private readonly core: ConversationCore;
  private readonly port: number;
  private readonly token: string;
  private readonly dedupe: MessageDeduplicator;
  private readonly modeLabel: string;
  private readonly now: () => number;
  private readonly provider?: AccessTokenProvider;
  private readonly pending = new Map<string, PendingResult>();
  private readonly startedAtMs: number;
  private readonly replyDeadlineMs: number;

  constructor(options: ServerOptions) {
    this.core = options.core;
    this.port = options.port ?? 8787;
    this.token = options.token ?? '';
    this.dedupe = options.dedupe ?? new MessageDeduplicator();
    this.modeLabel = options.modeLabel ?? '真实模式';
    this.now = options.now ?? Date.now;
    this.replyDeadlineMs = options.replyDeadlineMs ?? REPLY_DEADLINE_MS;
    this.startedAtMs = this.now();
    if (options.appId && options.appSecret) {
      this.provider = new AccessTokenProvider(options.appId, options.appSecret, this.now);
    }
  }

  /** 有 AppSecret 才算具备异步推送能力 */
  get canPushAsync(): boolean {
    return this.provider !== undefined;
  }

  listen(): Promise<Server> {
    const server = createServer((req, res) => {
      void this.route(req, res).catch((error: unknown) => {
        this.fail(res, 500, String(error));
      });
    });

    return new Promise((resolve) => {
      server.listen(this.port, () => resolve(server));
    });
  }

  // ── 路由 ──────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/demo')) {
      return this.html(res, renderMockPage(this.modeLabel));
    }

    if (req.method === 'GET' && path === '/healthz') {
      return this.json(res, 200, {
        ok: true,
        mode: this.core.gateway.mode,
        uptimeSec: Math.floor((this.now() - this.startedAtMs) / 1000),
        wechatConfigured: this.token.length > 0,
        asyncPush: this.canPushAsync,
        dedupeKeys: this.dedupe.size,
      });
    }

    if (req.method === 'POST' && path === '/api/chat') {
      return this.apiChat(req, res);
    }

    if (req.method === 'GET' && path === '/wechat') {
      return this.wechatVerify(url, res);
    }

    if (req.method === 'POST' && path === '/wechat') {
      return this.wechatMessage(req, url, res);
    }

    return this.fail(res, 404, 'Not Found');
  }

  private async apiChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let parsed: { userId?: unknown; text?: unknown } = {};
    try {
      parsed = JSON.parse(body) as { userId?: unknown; text?: unknown };
    } catch {
      return this.json(res, 400, { text: '请求体不是合法 JSON', kind: 'error' });
    }

    const userId = typeof parsed.userId === 'string' && parsed.userId ? parsed.userId : 'web-anon';
    const text = typeof parsed.text === 'string' ? parsed.text : '';
    if (!text.trim()) {
      return this.json(res, 400, { text: '说点什么吧', kind: 'error' });
    }

    const reply = await this.core.handle(userId, text);
    return this.json(res, 200, {
      text: reply.text,
      kind: reply.kind,
      ...(reply.orderId ? { orderId: reply.orderId } : {}),
      ...(reply.payUrl ? { payUrl: reply.payUrl } : {}),
    });
  }

  // ── 公众号 ────────────────────────────────────────────────

  private wechatVerify(url: URL, res: ServerResponse): void {
    const signature = url.searchParams.get('signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const echostr = url.searchParams.get('echostr') ?? '';

    if (!this.token) {
      this.fail(res, 503, '未配置 WECHAT_TOKEN，无法完成服务器配置校验');
      return;
    }
    const ok = verifySignature({ token: this.token, signature, timestamp, nonce });
    // 校验失败也必须回 200 + 明确文案：微信后台只认「配置失败」这一种结果，
    // 返回 500 会让使用者误以为是服务挂了
    this.text(res, 200, ok ? echostr : 'signature mismatch');
  }

  private async wechatMessage(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (!this.token) {
      this.fail(res, 503, '未配置 WECHAT_TOKEN，拒绝处理消息');
      return;
    }

    const signature = url.searchParams.get('signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    if (!verifySignature({ token: this.token, signature, timestamp, nonce })) {
      // 伪造请求：直接丢弃，绝不进入业务链路
      this.fail(res, 403, 'invalid signature');
      return;
    }

    const raw = await readBody(req);
    const envelope = parseWechatXml(raw) as WechatEnvelope & Record<string, string>;
    const openId = envelope.FromUserName ?? '';
    const toUser = envelope.ToUserName ?? '';
    if (!openId) {
      this.text(res, 200, buildSuccessReply());
      return;
    }

    // FR-24：微信 5 秒无响应会重试 3 次，同一条消息最多投递 4 次
    const key = dedupeKeyOf({
      msgId: envelope.MsgId,
      fromUserName: envelope.FromUserName,
      createTime: envelope.CreateTime,
    });
    if (key && this.dedupe.check(key) === 'duplicate') {
      this.text(res, 200, buildSuccessReply());
      return;
    }

    const incoming = extractText(envelope);
    if (!incoming) {
      // 图片/语音/事件等暂不支持，给一句明确提示而不是沉默
      this.text(res, 200, buildTextReply({ toUserName: openId, fromUserName: toUser, content: '目前只支持文字消息哦～' }));
      return;
    }

    const reply = await this.replyWithinDeadline(openId, incoming);
    if (reply !== undefined) {
      this.text(res, 200, buildTextReply({ toUserName: openId, fromUserName: toUser, content: reply }));
      return;
    }

    // 来不及：回 success 抑制重试，结果稍后异步送达
    this.text(res, 200, buildSuccessReply());
  }

  /**
   * 在 {@link ChannelServer.replyDeadlineMs} 内等结果。
   * 返回 `undefined` 表示超时 —— 此时调用方应回 `success`，由本方法启动的后台任务继续送达。
   */
  private async replyWithinDeadline(openId: string, text: string): Promise<string | undefined> {
    // T23 降级：上一次没送出去的结果，借这次回复的机会补上
    const backlog = this.takePending(openId);
    const task = this.core
      .handle(openId, text)
      .then((reply) => (backlog ? `【上一条的结果】\n${backlog}\n\n${reply.text}` : reply.text));

    const timer = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), this.replyDeadlineMs).unref?.();
    });

    const winner = await Promise.race([task.then((t) => ({ kind: 'done' as const, text: t })), timer.then(() => ({ kind: 'timeout' as const }))]);
    if (winner.kind === 'done') return winner.text;

    // 后台继续跑，完成后异步送达
    void task
      .then((lateText) => this.deliverLater(openId, lateText))
      .catch((error: unknown) => {
        void this.deliverLater(openId, `处理失败：${String(error)}`);
      });
    return undefined;
  }

  /** 异步送达：优先客服消息接口；没有权限就存起来，等用户下次发言补上 */
  private async deliverLater(openId: string, text: string): Promise<SendResult> {
    if (this.provider) {
      const result = await sendCustomText(this.provider, { openId, text });
      if (result.ok) return result;
      // 推不出去（比如 48001 未授权、45015 超窗）就降级为下次发言回补
      this.pending.set(openId, { text, atMs: this.now() });
      return result;
    }

    this.pending.set(openId, { text, atMs: this.now() });
    return { ok: false, message: '未配置客服消息权限，结果将在用户下次发言时回补' };
  }

  /** 取出该用户尚未送达的结果（若有），供下次回复时拼接 */
  takePending(openId: string): string | undefined {
    const hit = this.pending.get(openId);
    if (!hit) return undefined;
    this.pending.delete(openId);
    if (this.now() - hit.atMs > PENDING_TTL_MS) return undefined;
    return hit.text;
  }

  // ── 输出工具 ──────────────────────────────────────────────

  private html(res: ServerResponse, body: string): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  }

  private text(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  private fail(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
}

/** 从解析后的信封里取出用户真正说的话 */
export function extractText(envelope: Record<string, string>): string | undefined {
  const msgType = (envelope.MsgType ?? '').toLowerCase();
  if (msgType === 'text') {
    const content = (envelope.Content ?? '').trim();
    return content.length > 0 ? content : undefined;
  }
  // 语音识别结果同样是文字，可以当文本处理
  if (msgType === 'voice') {
    const recognition = (envelope.Recognition ?? '').trim();
    return recognition.length > 0 ? recognition : undefined;
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
