/** S9-A2 to A5: URL, transport, body-boundary, and rate-limit checks. */

import { createGateway } from '../src/mcp/gateway.ts';
import { McpStreamableHttpClient } from '../src/mcp/client.ts';
import { RealGateway } from '../src/mcp/gateway.ts';
import { isSafePaymentUrl, parseOrderResult } from '../src/mcp/normalize.ts';
import { ConversationCore } from '../src/channel/core.ts';
import { ChannelServer } from '../src/channel/server.ts';
import { renderMockPage } from '../src/channel/mock.ts';
import { internalErrorLabel, publicErrorMessage } from '../src/safety/publicError.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(isSafePaymentUrl('https://pay.mcd.cn/order/1'), 'trusted HTTPS payment host rejected');
assert(isSafePaymentUrl('https://example.invalid/mock-pay/1'), 'sample payment host rejected');
assert(!isSafePaymentUrl('javascript:alert(1)'), 'javascript URL accepted');
assert(!isSafePaymentUrl('data:text/html,alert(1)'), 'data URL accepted');
assert(!isSafePaymentUrl('http://pay.mcd.cn/order/1'), 'plain HTTP payment URL accepted');
assert(!isSafePaymentUrl('https://evil.example/order/1'), 'unlisted payment host accepted');
assert(!isSafePaymentUrl('https://evil.mcd.cn/order/1'), 'implicit payment subdomain accepted');
assert(!isSafePaymentUrl('https://pay.mcd.cn/order/1\nX-Injected: yes'), 'control character accepted');
const parsed = parseOrderResult({ success: true, data: { orderId: 'ORDER-1', payUrl: 'javascript:alert(1)' } });
assert(parsed === undefined, 'unsafe payment URL must reject the order result');
const missingUrl = parseOrderResult({ success: true, data: { orderId: 'ORDER-2' } });
assert(missingUrl === undefined, 'missing payment URL must reject the order result');
const rawProviderError = new Error('provider token=SECRET-DO-NOT-LEAK https://mcd.example.test/raw');
assert(!publicErrorMessage(rawProviderError).includes('SECRET-DO-NOT-LEAK'), 'public error leaked provider text');
assert(internalErrorLabel(rawProviderError) === 'Error', 'internal error label retained provider text');
assert(publicErrorMessage(null) === '服务暂时不可用，请稍后再试。', 'null error broke public redaction');
assert(publicErrorMessage(undefined) === '服务暂时不可用，请稍后再试。', 'undefined error broke public redaction');
const mockHtml = renderMockPage('演示模式');
assert(/<input[^>]+maxlength="2000"/.test(mockHtml), 'mock input has no client-side length cap');
assert(mockHtml.includes('请求失败，请稍后重试。'), 'mock network failure has no fixed public message');
assert(!mockHtml.includes("' + e"), 'mock network failure exposes raw exception text');
let ambiguousCreateOrder = false;
const offlineFailingClient = {
  callTool: async () => {
    throw new Error('simulated connection reset');
  },
} as unknown as McpStreamableHttpClient;
try {
  await new RealGateway(offlineFailingClient).createOrder({
    cart: {
      scene: 'pickup',
      store: { code: 'S9-TEST', name: 'S9 测试门店' },
      items: [{ productCode: 'P-1', name: '测试餐品', quantity: 1, menuPriceCents: 100 }],
      needTableware: false,
    },
    takeWayCode: 'eat-in',
  });
} catch (error) {
  ambiguousCreateOrder = (error as { readonly ambiguous?: unknown }).ambiguous === true;
}
assert(ambiguousCreateOrder, 'create-order transport failure must enter unknown state');

let rejectedPublicHttp = false;
try {
  new McpStreamableHttpClient({ url: 'http://public.example.test' });
} catch {
  rejectedPublicHttp = true;
}
assert(rejectedPublicHttp, 'public HTTP MCP endpoint accepted');
const loopback = new McpStreamableHttpClient({ url: 'http://127.0.0.1:8788', allowInsecureLoopback: true });
assert(loopback.endpoint.startsWith('http://127.0.0.1:8788'), 'explicit loopback HTTP proxy rejected');
const ipv6Loopback = new McpStreamableHttpClient({ url: 'http://[::1]:8788', allowInsecureLoopback: true });
assert(ipv6Loopback.endpoint.startsWith('http://[::1]:8788'), 'explicit IPv6 loopback HTTP proxy rejected');
let rejectedLocalhost = false;
try {
  new McpStreamableHttpClient({ url: 'http://localhost:8788', allowInsecureLoopback: true });
} catch {
  rejectedLocalhost = true;
}
assert(rejectedLocalhost, 'hostname-based localhost HTTP proxy accepted');

const core = new ConversationCore({ bundle: createGateway('sample') });
const server = new ChannelServer({
  core,
  port: 0,
  host: '127.0.0.1',
  exposeMock: true,
  maxBodyBytes: 128,
  rateLimitMax: 2,
  rateLimitWindowMs: 10_000,
});
const instance = await server.listen();
try {
  const address = instance.address();
  if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
  const base = `http://127.0.0.1:${address.port}`;
  const tooLarge = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 's9', text: 'x'.repeat(300) }),
  });
  assert(tooLarge.status === 413, `oversized body returned ${tooLarge.status}`);

  await fetch(`${base}/api/chat`, { method: 'POST', body: 'x'.repeat(300) });
  const limited = await fetch(`${base}/api/chat`, { method: 'POST', body: 'x'.repeat(300) });
  assert(limited.status === 429, `rate limit returned ${limited.status}`);
} finally {
  await new Promise<void>((resolve) => instance.close(() => resolve()));
}

console.log('S9-A2..A5 PASS: payment URL, MCP transport, body cap, and rate limit');
