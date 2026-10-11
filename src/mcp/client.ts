/**
 * 零依赖的 MCP Streamable HTTP 客户端。
 *
 * 只依赖 Node 内置 fetch，直接对接 https://mcp.mcd.cn。
 * 同时处理服务端返回的 application/json 与 text/event-stream 两种形态，
 * 并维护 Mcp-Session-Id。
 *
 * 注意：本文件使用 Node 原生类型剥离运行，因此不使用 enum / 参数属性 / 命名空间。
 */

export const DEFAULT_MCP_URL = 'https://mcp.mcd.cn';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  readonly code?: number | string;
  readonly httpStatus?: number;
  readonly ambiguous: boolean;

  constructor(message: string, options: { code?: number | string; httpStatus?: number; ambiguous?: boolean } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export interface McpContentBlock {
  type?: string;
  text?: string;
  mimeType?: string;
  data?: unknown;
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number | string; message?: string; data?: unknown };
}

export interface McpClientOptions {
  token?: string;
  url?: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** 是否自动完成 initialize 握手，默认 true */
  autoInitialize?: boolean;
  /** Only permit plain HTTP for an explicit loopback proxy. */
  allowInsecureLoopback?: boolean;
}

export class McpStreamableHttpClient {
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private sessionId: string | undefined;
  private nextId = 0;
  private initialized = false;

  constructor(options: McpClientOptions = {}) {
    const configuredUrl = pickFirstString(options.url, process.env.MCD_MCP_URL) ?? DEFAULT_MCP_URL;
    this.url = validateMcpUrl(
      configuredUrl,
      options.allowInsecureLoopback ?? process.env.MCD_MCP_ALLOW_INSECURE_LOOPBACK === 'true',
    );
    this.token = pickFirstString(options.token, process.env.MCD_MCP_TOKEN) ?? '';
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get endpoint(): string {
    return this.url;
  }

  get hasToken(): boolean {
    return this.token.trim().length > 0;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  /** 服务端可能返回 JSON，也可能返回 SSE，这里统一收敛成一个对象 */
  private parseBody(raw: string, contentType: string): JsonRpcEnvelope {
    const ct = (contentType || '').toLowerCase();

    if (ct.includes('text/event-stream')) {
      const frames = raw.split(/\r?\n\r?\n/);
      let lastError: unknown;
      for (const frame of frames) {
        if (!frame.trim()) continue;
        const dataLines = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const json = dataLines.join('\n').trim();
        if (!json || json === '[DONE]') continue;
        try {
          return JSON.parse(json) as JsonRpcEnvelope;
        } catch (error) {
          lastError = error;
        }
      }
      void lastError;
      throw new McpError('无法解析 MCP 响应。');
    }

    try {
      return JSON.parse(raw) as JsonRpcEnvelope;
    } catch {
      throw new McpError('MCP 返回了无法解析的响应。');
    }
  }

  /** 非 2xx 时把麦当劳网关的错误码尽量带上，方便定位是 Token 问题还是限流问题 */
  private async describeHttpFailure(response: Response): Promise<McpError> {
    if (response.status === 401) {
      return new McpError('MCP Token 无效、已过期或未提供（HTTP 401）。请到 https://open.mcd.cn/mcp 重新申请。', {
        httpStatus: 401,
      });
    }
    if (response.status === 403) {
      return new McpError('请求被网关拒绝（HTTP 403）。请确认 Authorization 头配置正确。', {
        httpStatus: 403,
      });
    }
    if (response.status === 429) {
      return new McpError('触发限流：每个 Token 每分钟最多 600 次请求（HTTP 429）。请降低调用频率。', {
        httpStatus: 429,
      });
    }
    return new McpError(`MCP 请求失败（HTTP ${response.status}）。`, {
      httpStatus: response.status,
    });
  }

  async request<T>(method: string, params?: unknown, options: { notify?: boolean } = {}): Promise<T> {
    const notify = options.notify ?? false;
    const id = notify ? undefined : ++this.nextId;
    const payload: Record<string, unknown> = { jsonrpc: '2.0', method };
    if (id !== undefined) payload.id = id;
    if (params !== undefined) payload.params = params;

    const response = await fetch(this.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      const name = error instanceof Error ? error.name : '';
      const ambiguous = name === 'AbortError' || name === 'TimeoutError' || name === 'ConnectTimeoutError';
      throw new McpError(
        ambiguous ? 'MCP 请求超时或连接中断，订单结果需要人工核对。' : '无法连接 MCP 服务。',
        { ambiguous },
      );
    });

    const returnedSessionId = response.headers.get('mcp-session-id');
    if (returnedSessionId) this.sessionId = returnedSessionId;

    if (!response.ok) throw await this.describeHttpFailure(response);

    const raw = await response.text();
    if (notify) return undefined as T;
    if (!raw.trim()) throw new McpError(`MCP ${method} 返回了空响应体`);

    const envelope = this.parseBody(raw, response.headers.get('content-type') ?? '');

    if (envelope.error) {
      throw new McpError(`MCP ${method} 返回错误。`, {
        code: envelope.error.code,
      });
    }
    if (!('result' in envelope)) {
      throw new McpError(`MCP ${method} 响应缺少 result 字段`);
    }
    return envelope.result as T;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.hasToken) {
      throw new McpError('缺少 MCP Token：请在 .env 中设置 MCD_MCP_TOKEN');
    }
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'mcd-txt-order', version: '1.0.0' },
    });
    await this.request(
      'notifications/initialized',
      undefined,
      { notify: true },
    ).catch(() => undefined);
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    await this.initialize();
    const result = await this.request<{ tools?: McpToolDef[] }>('tools/list');
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpCallResult> {
    await this.initialize();
    const result = await this.request<McpCallResult>('tools/call', { name, arguments: args });
    return result ?? {};
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function validateMcpUrl(value: string, allowInsecureLoopback: boolean): string {
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new McpError('MCD_MCP_URL 配置无效。');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpError('MCD_MCP_URL 配置无效。');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname) {
    throw new McpError('MCD_MCP_URL 不得包含凭据、查询参数或片段。');
  }
  if (parsed.protocol === 'https:') return parsed.toString();
  if (parsed.protocol === 'http:' && allowInsecureLoopback && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return parsed.toString();
  }
  throw new McpError('MCD_MCP_URL 必须使用 HTTPS；仅允许显式配置的本机回环 HTTP 代理。');
}

/** 把 ToolResult 里的 content / structuredContent 收敛成可直接遍历的数据 */
export function unwrapToolResult(result: McpCallResult): unknown {
  if (result?.structuredContent !== undefined && result.structuredContent !== null) {
    return result.structuredContent;
  }

  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parsed: unknown[] = [];
  const texts: string[] = [];

  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      const maybe = tryParseJson(block.text);
      if (maybe !== undefined) parsed.push(maybe);
      continue;
    }
    if (block?.data !== undefined) parsed.push(block.data);
  }

  if (parsed.length === 1) return parsed[0];
  if (parsed.length > 1) return parsed;
  if (texts.length === 1) return texts[0];
  if (texts.length > 1) return texts;
  return undefined;
}

/** ToolResult 的纯文本形态，用于给用户展示 */
export function toolResultText(result: McpCallResult): string {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .map((block) => (block?.type === 'text' ? block.text ?? '' : ''))
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
}

export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 不是 JSON 就原样返回文本 */
  }
  return undefined;
}

function pickFirstString(...values: (string | undefined | null)[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
