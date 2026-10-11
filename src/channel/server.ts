/**
 * HTTP 服务（T22 / M8 生产化）。零依赖，纯 node:http。
 *
 * 一个进程同时提供四类入口，刻意如此 —— 评审者只需 `npm run serve` 就能全部体验：
 *   GET  /           网页模拟器（Tier 0，不需公众号）
 *   POST /api/chat   模拟器用的 JSON 对话接口
 *   GET  /wechat     公众号服务器配置校验（安全模式下 echostr 是密文）
 *   POST /wechat     公众号消息接收（5 秒超时 → 异步推送）
 *   GET  /healthz    健康检查
 *
 * 关于 5 秒这条硬约束（FR-21）：
 * 找店 → 菜单 → 详情 → 算价 这条链路实测要 2~6 秒，必然有部分请求超时。
 * 处理办法是**双阶段响应**：先回 `success` 抑制微信重试，后台跑完再用客服消息推回去。
 * 没有客服消息权限时（个人订阅号），降级为「用户下次发言时把结果补上」。
 *
 * M8 新增的三件事，全部围绕「真的放到公网上」：
 *   ① 消息加解密（安全模式 / 兼容模式）—— 见 src/channel/crypto.ts
 *   ② 监听地址可配：默认仍只听回环，正式部署用 HOST=0.0.0.0
 *   ③ **对外监听时自动关闭网页模拟器与 /api/chat**。
 *      这两个入口无需微信验签即可驱动整套下单链路，暴露在公网上等于
 *      把「你的麦当劳账号」开放给任何人。默认安全，需要调试再显式打开。
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
import {
  WechatMessageCrypto,
  extractEncrypt,
  isEncryptedEnvelope,
  type EncryptedReply,
} from './crypto.ts';
import { MessageDeduplicator, dedupeKeyOf, type WechatEnvelope } from './dedupe.ts';

/**
 * 留给被动回复的余量。
 * 微信是 5 秒断连，这里设 4.3 秒 —— 剩下的时间要留给网络往返和序列化。
 */
const REPLY_DEADLINE_MS = 4300;

/** 待回补结果的存活时间（没客服接口时，等用户下次发言再补） */
const PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_MAX = 60;

/** 公众号后台的三种消息加解密方式 */
export type WechatEncryptMode = 'plain' | 'mixed' | 'encrypt';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '']);

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export interface ServerOptions {
  readonly core: ConversationCore;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly appId?: string;
  readonly appSecret?: string;
  readonly encodingAesKey?: string;
  readonly encryptMode?: WechatEncryptMode;
  /** 是否暴露网页模拟器与 /api/chat。默认：仅回环监听时暴露 */
  readonly exposeMock?: boolean;
  readonly dedupe?: MessageDeduplicator;
  readonly modeLabel?: string;
  readonly now?: () => number;
  /** 留给被动回复的时间。默认 4.3 秒（微信 5 秒断连）；仅测试需要改它 */
  readonly replyDeadlineMs?: number;
  /** Direct Node body limit; keep this equal to the reverse-proxy limit. */
  readonly maxBodyBytes?: number;
  /** Header/body timeout for direct connections. */
  readonly requestTimeoutMs?: number;
  readonly rateLimitWindowMs?: number;
  readonly rateLimitMax?: number;
}

interface PendingResult {
  readonly text: string;
  readonly atMs: number;
}

export class ChannelServer {
  private readonly core: ConversationCore;
  private readonly port: number;
  private readonly host: string;
  private readonly token: string;
  private readonly dedupe: MessageDeduplicator;
  private readonly modeLabel: string;
  private readonly now: () => number;
  private readonly provider?: AccessTokenProvider;
  private readonly crypto?: WechatMessageCrypto;
  private readonly encryptMode: WechatEncryptMode;
  private readonly exposeMock: boolean;
  private readonly pending = new Map<string, PendingResult>();
  private readonly startedAtMs: number;
  private readonly replyDeadlineMs: number;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly rateLimiter: RequestRateLimiter;

  constructor(options: ServerOptions) {
    this.core = options.core;
    this.port = options.port ?? 8787;
    this.host = options.host ?? '127.0.0.1';
    this.token = options.token ?? '';
    this.encryptMode = options.encryptMode ?? 'plain';
    this.dedupe = options.dedupe ?? new MessageDeduplicator();
    this.modeLabel = options.modeLabel ?? '真实模式';
    this.now = options.now ?? Date.now;
    this.replyDeadlineMs = options.replyDeadlineMs ?? REPLY_DEADLINE_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? positiveIntEnv('HTTP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES);
    this.requestTimeoutMs = options.requestTimeoutMs ?? positiveIntEnv('HTTP_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
    this.rateLimiter = new RequestRateLimiter(
      options.rateLimitWindowMs ?? positiveIntEnv('HTTP_RATE_LIMIT_WINDOW_MS', DEFAULT_RATE_LIMIT_WINDOW_MS),
      options.rateLimitMax ?? positiveIntEnv('HTTP_RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX),
      this.now,
    );
    this.startedAtMs = this.now();

    // 安全默认值：监听地址不是回环就意味着要对外服务，此时调试入口必须关掉，
    // 除非运维明确写了 EXPOSE_MOCK=true。
    this.exposeMock = options.exposeMock ?? LOOPBACK_HOSTS.has(this.host);

    if (options.appId && options.appSecret) {
      this.provider = new AccessTokenProvider(options.appId, options.appSecret, this.now);
    }

    if (options.encodingAesKey && options.appId) {
      this.crypto = new WechatMessageCrypto({
        token: this.token,
        appId: options.appId,
        encodingAesKey: options.encodingAesKey,
      });
    }

    // 快速失败：安全模式却配不出加解密器，等到微信第一次推消息才发现就晚了
    if (this.encryptMode === 'encrypt' && !this.crypto) {
      throw new Error(
        'WECHAT_ENCRYPT_MODE=encrypt 但缺少 WECHAT_ENCODING_AES_KEY 或 WECHAT_APP_ID，无法解密消息。' +
          '请补全配置，或改用 WECHAT_ENCRYPT_MODE=plain。',
      );
    }
  }

  /** 有 AppSecret 才算具备异步推送能力 */
  get canPushAsync(): boolean {
    return this.provider !== undefined;
  }

  get config(): {
    readonly host: string;
    readonly port: number;
    readonly encryptMode: WechatEncryptMode;
    readonly exposeMock: boolean;
    readonly cryptoReady: boolean;
    readonly wechatReady: boolean;
  } {
    return {
      host: this.host,
      port: this.port,
      encryptMode: this.encryptMode,
      exposeMock: this.exposeMock,
      cryptoReady: this.crypto !== undefined,
      wechatReady: this.token.length > 0,
    };
  }

  listen(): Promise<Server> {
    const server = createServer((req, res) => {
      void this.route(req, res).catch((error: unknown) => {
        this.fail(res, 500, '服务器暂时无法处理请求');
      });
    });
    server.requestTimeout = this.requestTimeoutMs;
    server.headersTimeout = this.requestTimeoutMs + 1_000;

    return new Promise((resolve) => {
      server.listen(this.port, this.host, () => resolve(server));
    });
  }

  // ── 路由 ──────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (this.isRateLimited(req, path)) {
      this.fail(res, 429, '请求过于频繁，请稍后再试');
      return;
    }

    if (req.method === 'GET' && (path === '/' || path === '/demo')) {
      if (!this.exposeMock) return this.fail(res, 404, 'Not Found');
      return this.html(res, renderMockPage(this.modeLabel));
    }

    if (req.method === 'GET' && path === '/healthz') {
      const cfg = this.config;
      return this.json(res, 200, {
        ok: true,
        mode: this.core.gateway.mode,
        uptimeSec: Math.floor((this.now() - this.startedAtMs) / 1000),
        wechatConfigured: cfg.wechatReady,
        encryptMode: cfg.encryptMode,
        cryptoReady: cfg.cryptoReady,
        exposeMock: cfg.exposeMock,
        asyncPush: this.canPushAsync,
        dedupeKeys: this.dedupe.size,
      });
    }

    if (req.method === 'POST' && path === '/api/chat') {
      if (!this.exposeMock) return this.fail(res, 404, 'Not Found');
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
    let body: string;
    try {
      body = await readBody(req, this.maxBodyBytes, this.requestTimeoutMs);
    } catch (error) {
      return this.handleBodyError(res, error);
    }
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
    const result = resolveWechatVerify({
      token: this.token,
      mode: this.encryptMode,
      crypto: this.crypto,
      signature: url.searchParams.get('signature') ?? '',
      msgSignature: url.searchParams.get('msg_signature') ?? '',
      timestamp: url.searchParams.get('timestamp') ?? '',
      nonce: url.searchParams.get('nonce') ?? '',
      echostr: url.searchParams.get('echostr') ?? '',
    });
    // 校验失败也必须回 200 + 明确文案：微信后台只认「配置失败」这一种结果，
    // 返回 500 会让使用者误以为是服务挂了
    this.text(res, 200, result.body);
  }

  private async wechatMessage(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    if (!this.token) {
      this.fail(res, 503, '未配置 WECHAT_TOKEN，拒绝处理消息');
      return;
    }

    const signature = url.searchParams.get('signature') ?? '';
    const msgSignature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';

    let raw: string;
    try {
      raw = await readBody(req, this.maxBodyBytes, this.requestTimeoutMs);
    } catch (error) {
      this.handleBodyError(res, error);
      return;
    }

    // ── 解密 ───────────────────────────────────────────────
    let xml = raw;
    let encryptedRequest = false;

    if (isEncryptedEnvelope(raw)) {
      const encrypt = extractEncrypt(raw);
      if (!this.crypto) {
        this.fail(res, 503, '收到加密消息但未配置 WECHAT_ENCODING_AES_KEY');
        return;
      }
      // 密文自带签名：先验证再解密，避免为伪造请求白白做一次 AES
      const signed = msgSignature
        ? this.crypto.verifyMessageSignature({ msgSignature, timestamp, nonce, encrypt })
        : // 兼容模式下部分实现只传 signature，此时用明文规则校验
          verifySignature({ token: this.token, signature, timestamp, nonce });
      if (!signed) {
        this.fail(res, 403, 'invalid signature');
        return;
      }

      try {
        xml = this.crypto.decrypt(encrypt);
      } catch (error) {
        this.fail(res, 400, '消息解密失败');
        return;
      }
      encryptedRequest = true;
    } else {
      if (this.encryptMode === 'encrypt') {
        // 安全模式下出现明文 = 不符合预期，按伪造请求处理
        this.fail(res, 403, 'invalid signature');
        return;
      }
      if (!verifySignature({ token: this.token, signature, timestamp, nonce })) {
        this.fail(res, 403, 'invalid signature');
        return;
      }
    }

    const envelope = parseWechatXml(xml) as WechatEnvelope & Record<string, string>;
    const openId = envelope.FromUserName ?? '';
    const toUser = envelope.ToUserName ?? '';
    if (!openId) {
      this.text(res, 200, buildSuccessReply());
      return;
    }

    // 事件消息：关注给欢迎语，其余一律 success —— 对取关/菜单点击刷屏没有意义
    const eventReply = this.eventReply(envelope);
    if (eventReply !== undefined) {
      this.reply(res, eventReply, encryptedRequest);
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
      this.reply(
        res,
        buildTextReply({
          toUserName: openId,
          fromUserName: toUser,
          content: '目前只支持文字消息哦～',
        }),
        encryptedRequest,
      );
      return;
    }

    const reply = await this.replyWithinDeadline(openId, incoming);
    if (reply !== undefined) {
      this.reply(
        res,
        buildTextReply({ toUserName: openId, fromUserName: toUser, content: reply }),
        encryptedRequest,
      );
      return;
    }

    // 来不及：回 success 抑制重试，结果稍后异步送达
    this.text(res, 200, buildSuccessReply());
  }

  /** 事件消息。返回 undefined 表示不是需要回复的事件 */
  private eventReply(envelope: Record<string, string>): string | undefined {
    if ((envelope.MsgType ?? '').toLowerCase() !== 'event') return undefined;
    const event = (envelope.Event ?? '').toLowerCase();

    if (event === 'subscribe' || event === 'scan') {
      return buildTextReply({
        toUserName: envelope.FromUserName ?? '',
        fromUserName: envelope.ToUserName ?? '',
        content: WELCOME_TEXT,
      });
    }
    // 取关、菜单点击、模板送达等：不回复，避免骚扰用户
    return buildSuccessReply();
  }

  /** 统一出口：按请求是否加密决定回复明文还是密文 */
  private reply(res: ServerResponse, plainXml: string, encryptedRequest: boolean): void {
    if (!encryptedRequest) {
      return this.text(res, 200, plainXml);
    }
    if (!this.crypto) {
      return this.fail(res, 503, '需要加密回复但未配置 WECHAT_ENCODING_AES_KEY');
    }
    const encrypted: EncryptedReply = this.crypto.encryptReply(plainXml, this.now);
    return this.text(res, 200, encrypted.xml);
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
        void this.deliverLater(openId, '处理失败，请稍后重新发起。');
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

  private isRateLimited(req: IncomingMessage, path: string): boolean {
    if (path !== '/wechat' && path !== '/api/chat') return false;
    const address = req.socket.remoteAddress ?? 'unknown';
    return !this.rateLimiter.allow(`${req.method ?? 'UNKNOWN'}:${path}:${address}`);
  }

  private handleBodyError(res: ServerResponse, error: unknown): void {
    if (error instanceof BodyLimitError) {
      this.fail(res, 413, '请求体过大');
      return;
    }
    if (error instanceof BodyTimeoutError) {
      this.fail(res, 408, '请求超时');
      return;
    }
    this.fail(res, 400, '无法读取请求体');
  }
}

/** 关注公众号后的第一句话。要能让陌生人 10 秒内知道怎么用 */
export const WELCOME_TEXT = [
  '欢迎使用一句话下单 👋',
  '',
  '发一句话就行，比如：',
  '  巨无霸 香梅北',
  '  两个巨无霸一杯可乐 香梅北',
  '',
  '我会自动找到门店、算好真实价格，',
  '把预览发给你；回复「确认」才会真的下单，',
  '下单后把支付链接发给你。',
  '',
  '发「帮助」看完整用法。',
].join('\n');

/**
 * 服务器配置校验（纯函数，便于单测）。
 *
 * 安全模式下微信依然用 token/timestamp/nonce 算 signature，
 * 但 **echostr 是密文** —— 这是很多人第一次配安全模式时卡住的地方：
 * 直接把密文原样回给微信，后台会一直提示「token 验证失败」。
 */
export function resolveWechatVerify(params: {
  readonly token: string;
  readonly mode: WechatEncryptMode;
  readonly crypto?: WechatMessageCrypto;
  readonly signature: string;
  readonly msgSignature: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly echostr: string;
}): { readonly ok: boolean; readonly body: string } {
  const { token, mode, crypto, signature, msgSignature, timestamp, nonce, echostr } = params;

  if (!token) return { ok: false, body: '未配置 WECHAT_TOKEN，无法完成服务器配置校验' };

  // 密文形态优先按 msg_signature 校验，否则退回明文规则
  const signOk = msgSignature && crypto
    ? crypto.verifyMessageSignature({ msgSignature, timestamp, nonce, encrypt: echostr })
    : verifySignature({ token, signature, timestamp, nonce });

  if (!signOk) return { ok: false, body: 'signature mismatch' };

  if (mode === 'encrypt') {
    if (!crypto) return { ok: false, body: '安全模式缺少 WECHAT_ENCODING_AES_KEY' };
    try {
      return { ok: true, body: crypto.decrypt(echostr) };
    } catch {
      return { ok: false, body: 'echostr 解密失败' };
    }
  }

  // 兼容模式：能给明文就给明文，给不了（说明是密文）就解密
  if (crypto && !/<[^>]+>/.test(echostr)) {
    try {
      return { ok: true, body: crypto.decrypt(echostr) };
    } catch {
      return { ok: false, body: 'echostr 既不是明文也无法解密' };
    }
  }

  return { ok: true, body: echostr };
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

class BodyLimitError extends Error {}
class BodyTimeoutError extends Error {}

class RequestRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAtMs: number }>();
  private readonly windowMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(
    windowMs: number,
    max: number,
    now: () => number,
  ) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
  }

  allow(key: string): boolean {
    const nowMs = this.now();
    const current = this.hits.get(key);
    if (!current || current.resetAtMs <= nowMs) {
      this.hits.set(key, { count: 1, resetAtMs: nowMs + this.windowMs });
      this.trim(nowMs);
      return true;
    }
    if (current.count >= this.max) return false;
    current.count += 1;
    return true;
  }

  private trim(nowMs: number): void {
    if (this.hits.size < 10_000) return;
    for (const [key, value] of this.hits) {
      if (value.resetAtMs <= nowMs) this.hits.delete(key);
    }
  }
}

function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.resume();
      rejectBody(new BodyTimeoutError());
    }, timeoutMs);
    timer.unref?.();

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectBody(error);
      else resolveBody(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buffer.byteLength;
      if (total > maxBytes) {
        req.resume();
        finish(new BodyLimitError());
        return;
      }
      chunks.push(buffer);
    };
    req.on('data', onData);
    req.once('end', () => finish());
    req.once('aborted', () => finish(new BodyTimeoutError()));
    req.once('error', () => finish(new Error('request body read failed')));

    const contentLength = Number(req.headers['content-length'] ?? '');
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume();
      finish(new BodyLimitError());
    }
  });
}
