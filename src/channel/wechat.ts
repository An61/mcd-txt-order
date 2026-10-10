/**
 * 微信公众号协议层（T21 / T23）。
 *
 * 只做四件事，且刻意**不含任何业务逻辑**：
 *   ① GET 验签（服务器配置校验）
 *   ② POST 收消息：XML → 扁平对象
 *   ③ 被动回复：文本 → XML
 *   ④ 客服消息异步推送（解决 5 秒超时）
 *
 * 业务一律交给 {@link ConversationCore}。这样拆的好处是：
 * 这一层可以脱离微信单测（见 scripts/check-m4.ts），而模拟器完全不需要它。
 *
 * 全部零依赖：XML 用正则解析、签名用 node:crypto、HTTP 用内置 fetch。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

// ── ① 验签 ─────────────────────────────────────────────────

/**
 * 微信服务器配置校验：token / timestamp / nonce 三个参数字典序排序后拼接，做 SHA1。
 *
 * 用 `timingSafeEqual` 而不是 `===` 比较 —— 签名是抵御伪造请求的唯一屏障，
 * 字符串短路比较会泄漏「前几位是否正确」的信息，属于教科书级的时序侧信道。
 */
export function verifySignature(params: {
  readonly token: string;
  readonly signature: string;
  readonly timestamp: string;
  readonly nonce: string;
}): boolean {
  const { token, signature, timestamp, nonce } = params;
  if (!signature) return false;

  const digest = createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── ② XML 解析 ──────────────────────────────────────────────

/**
 * 把微信推送的 XML 拍平成对象。
 *
 * 微信的消息体是**单层**结构（`<xml>` 下直接是字段），所以不需要真解析器 ——
 * 用正则足够，而且比引入一个 XML 库更可控：第三方解析器遇到畸形输入时会抛异常，
 * 而这里宁可返回空对象让上层走「无法识别」分支。
 */
export function parseWechatXml(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof xml !== 'string' || xml.length === 0) return out;

  // 必须先剥掉外层 <xml>：否则下面那条惰性正则会把「第一个 <xml> 到最后一个 </xml>」
  // 整段当成一条记录，所有字段一个都解析不出来（这个坑实际踩到过）。
  const root = /<xml[^>]*>([\s\S]*)<\/xml>/i.exec(xml);
  const body = root ? (root[1] ?? xml) : xml;

  const tagRe = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const key = match[1];
    const raw = match[2] ?? '';
    out[key] = decodeValue(raw);
  }
  return out;
}

const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';

/**
 * 按 XML 规范逐段解析 CDATA：每段从 `<![CDATA[` 开始，到**第一个** `]]>` 结束。
 *
 * 不能图省事做全局字符串替换 —— `]]>` 在 CDATA 内的合法转义写法是
 * `]]]]><![CDATA[>`，全局替换会把它解析错。见 scripts/check-m4.ts 的对应断言。
 */
function decodeValue(raw: string): string {
  if (!raw.includes(CDATA_OPEN)) return unescapeEntities(raw);

  let out = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf(CDATA_OPEN, cursor);
    if (start < 0) break;
    const bodyStart = start + CDATA_OPEN.length;
    const end = raw.indexOf(CDATA_CLOSE, bodyStart);
    if (end < 0) {
      out += raw.slice(bodyStart);
      cursor = raw.length;
      break;
    }
    out += raw.slice(bodyStart, end);
    cursor = end + CDATA_CLOSE.length;
  }
  return unescapeEntities(out);
}

function unescapeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const XML_ESCAPE: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch] ?? ch);
}

// ── ③ 被动回复 ──────────────────────────────────────────────

/** 文本被动回复。注意 ToUserName / FromUserName 要**互换** */
export function buildTextReply(params: {
  readonly toUserName: string;
  readonly fromUserName: string;
  readonly content: string;
}): string {
  const stamp = Math.floor(Date.now() / 1000);
  return [
    '<xml>',
    `<ToUserName><![CDATA[${params.toUserName}]]></ToUserName>`,
    `<FromUserName><![CDATA[${params.fromUserName}]]></FromUserName>`,
    `<CreateTime>${stamp}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${escapeCdata(params.content)}]]></Content>`,
    '</xml>',
  ].join('');
}

/**
 * 「收到，但不回复」。
 *
 * 官方文档写明：来不及处理时直接回 `success`（或直接 200 空）可**抑制微信的重试**。
 * 这比让微信重试三次、我们再靠去重丢掉两次要干净得多。
 */
export function buildSuccessReply(): string {
  return 'success';
}

/**
 * CDATA 内部不能再出现 `]]>`，否则整个 XML 会被截断。
 * 微信不会替你转义，这是自己要兜的。
 */
function escapeCdata(text: string): string {
  return String(text).replace(/\]\]>/g, ']]]]><![CDATA[>');
}

// ── ④ 客服消息异步推送 ──────────────────────────────────────

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token';
const CUSTOM_SEND_URL = 'https://api.weixin.qq.com/cgi-bin/message/custom/send';

interface CachedAccessToken {
  token: string;
  expiresAtMs: number;
}

/**
 * access_token 缓存。
 * 官方限制每日获取次数，且有效期 7200 秒 —— 提前 5 分钟刷新，避免临界失效。
 */
export class AccessTokenProvider {
  private cached?: CachedAccessToken;

  private readonly appId: string;
  private readonly appSecret: string;
  private readonly now: () => number;

  constructor(appId: string, appSecret: string, now: () => number = Date.now) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.now = now;
  }

  async get(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - 5 * 60 * 1000) {
      return this.cached.token;
    }

    const url = `${TOKEN_URL}?grant_type=client_credential&appid=${encodeURIComponent(
      this.appId,
    )}&secret=${encodeURIComponent(this.appSecret)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`获取 access_token 失败：HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { access_token?: string; expires_in?: number; errcode?: number };
    const token = payload.access_token;
    if (!token) {
      throw new Error(`获取 access_token 失败：errcode=${String(payload.errcode ?? '未知')}`);
    }

    this.cached = {
      token,
      expiresAtMs: this.now() + (payload.expires_in ?? 7200) * 1000,
    };
    return token;
  }

  /** 微信侧主动失效时（errcode 40001）调用，强制下次重新获取 */
  invalidate(): void {
    this.cached = undefined;
  }
}

export interface CustomTextMessage {
  readonly openId: string;
  readonly text: string;
}

export interface SendResult {
  readonly ok: boolean;
  readonly errcode?: number;
  readonly message: string;
}

/**
 * 客服消息接口推送一条文本。
 *
 * 两个已知限制（写在这里是因为它们决定了降级策略）：
 *   · **48 小时窗口** —— 用户 48 小时内没有互动，推送会报 45015
 *   · **条数限制** —— 超量也会失败
 * 本项目只在「用户刚发消息后的几秒内」推送，天然落在窗口内。
 */
export async function sendCustomText(
  provider: AccessTokenProvider,
  message: CustomTextMessage,
): Promise<SendResult> {
  // 微信单条客服消息上限约 2048 字节，超了整个请求会失败
  const text = message.text.length > 1800 ? `${message.text.slice(0, 1800)}…` : message.text;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await provider.get();
    const response = await fetch(`${CUSTOM_SEND_URL}?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: message.openId,
        msgtype: 'text',
        text: { content: text },
      }),
    });

    let payload: { errcode?: number; errmsg?: string } = {};
    try {
      payload = (await response.json()) as { errcode?: number; errmsg?: string };
    } catch {
      return { ok: false, message: `客服消息响应无法解析：HTTP ${response.status}` };
    }

    const errcode = payload.errcode ?? 0;
    if (errcode === 0) return { ok: true, message: '已推送' };

    // 40001 = token 失效，清缓存重试一次；其它错误不重试（45015 超窗重试也没用）
    if (errcode === 40001 && attempt === 0) {
      provider.invalidate();
      continue;
    }
    return { ok: false, errcode, message: describeWechatError(errcode, payload.errmsg) };
  }

  return { ok: false, message: '客服消息推送失败（已重试一次）' };
}

/** 把常见的微信错误码翻译成人话，省得排查时对着数字猜 */
export function describeWechatError(errcode: number, errmsg?: string): string {
  const known: Readonly<Record<number, string>> = {
    40001: 'access_token 无效',
    40003: 'openid 无效',
    45015: '超出 48 小时互动窗口或条数限制，无法主动推送',
    45047: '客服消息条数超过上限',
    48001: '接口未授权（个人订阅号没有客服消息权限，需测试号或认证服务号）',
  };
  const label = known[errcode];
  const suffix = errmsg ? `（${errmsg}）` : '';
  return label ? `${label} ${errcode}${suffix}` : `微信返回错误 ${errcode}${suffix}`;
}
