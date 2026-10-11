/**
 * M4 渠道层自检（T19~T23 + T37）。
 *
 * 这一层最容易出事的地方不是逻辑，而是**协议细节** —— 签名算错、XML 拼错、
 * CDATA 没转义、FromUserName 忘记互换，每一个都能让公众号彻底收不到消息，
 * 而且报错信息毫无提示。所以这里逐条钉死。
 *
 * 全程离线：不连 MCP、不连微信、不发起任何真实下单。
 */

import { createHash } from 'node:crypto';

import { ConversationCore } from '../src/channel/core.ts';
import { renderMockPage } from '../src/channel/mock.ts';
import {
  MessageDeduplicator,
  dedupeKeyOf,
} from '../src/channel/dedupe.ts';
import {
  AccessTokenProvider,
  buildSuccessReply,
  buildTextReply,
  describeWechatError,
  parseWechatXml,
  verifySignature,
} from '../src/channel/wechat.ts';
import { ChannelServer, extractText } from '../src/channel/server.ts';
import { createGateway } from '../src/mcp/gateway.ts';

let passed = 0;
let failed = 0;

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
}

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? `  → ${detail}` : ''}`);
  }
}

function sha1Of(values: readonly string[]): string {
  return createHash('sha1').update([...values].sort().join('')).digest('hex');
}

const TOKEN = 'demo_token_abc';

// ─────────────────────────────────────────────────────────────
section('T37 消息去重（微信 5 秒重试 3 次的防线）');

{
  const dedupe = new MessageDeduplicator();
  const key = 'msg:123456';
  check('首次投递应当处理', dedupe.check(key) === 'process');
  check('第二次投递判为重复', dedupe.check(key) === 'duplicate');
  check('第三次仍然重复', dedupe.check(key) === 'duplicate');
  check('不同的 key 互不干扰', dedupe.check('msg:999') === 'process');
  check('forget 后允许重新处理', dedupe.forget(key) === true && dedupe.check(key) === 'process');
}

{
  // 官方口径：普通消息用 MsgId，事件用 FromUserName + CreateTime
  check(
    '普通消息用 MsgId 去重',
    dedupeKeyOf({ msgId: '7001', fromUserName: 'oA', createTime: '1700000000' }) === 'msg:7001',
  );
  check(
    '事件消息退化到 FromUserName+CreateTime',
    dedupeKeyOf({ fromUserName: 'oA', createTime: '1700000000' }) === 'evt:oA:1700000000',
  );
  check('两者都没有时无法去重', dedupeKeyOf({}) === undefined);
  check(
    '同秒不同用户的事件不冲突',
    dedupeKeyOf({ fromUserName: 'oB', createTime: '1700000000' }) !==
      dedupeKeyOf({ fromUserName: 'oA', createTime: '1700000000' }),
  );
}

{
  let clock = 0;
  const dedupe = new MessageDeduplicator({ ttlMs: 1000, now: () => clock });
  dedupe.check('k');
  clock = 1500;
  check('超过 TTL 后可重新处理', dedupe.check('k') === 'process');

  const bounded = new MessageDeduplicator({ maxEntries: 5, now: () => 0 });
  for (let i = 0; i < 20; i += 1) bounded.check(`k${i}`);
  check('容量有上限，不会无限增长', bounded.size <= 5, String(bounded.size));
}

// ─────────────────────────────────────────────────────────────
section('T21 公众号验签');

{
  const timestamp = '1700000000';
  const nonce = 'n0nc3';
  const signature = sha1Of([TOKEN, timestamp, nonce]);
  check('正确签名通过', verifySignature({ token: TOKEN, signature, timestamp, nonce }));
  check(
    '错误签名被拒',
    !verifySignature({ token: TOKEN, signature: 'deadbeef', timestamp, nonce }),
  );
  check(
    '换 token 后同一签名失效',
    !verifySignature({ token: 'other_token', signature, timestamp, nonce }),
  );
  check('空签名直接拒绝', !verifySignature({ token: TOKEN, signature: '', timestamp, nonce }));
}

// ─────────────────────────────────────────────────────────────
section('T21 XML 解析与被动回复');

{
  const xml = [
    '<xml>',
    '<ToUserName><![CDATA[gh_123]]></ToUserName>',
    '<FromUserName><![CDATA[oAbc]]></FromUserName>',
    '<CreateTime>1700000000</CreateTime>',
    '<MsgType><![CDATA[text]]></MsgType>',
    '<Content><![CDATA[巨无霸 星河]]></Content>',
    '<MsgId>1234567890</MsgId>',
    '</xml>',
  ].join('');

  const parsed = parseWechatXml(xml);
  check('解析 ToUserName', parsed.ToUserName === 'gh_123');
  check('解析 FromUserName', parsed.FromUserName === 'oAbc');
  check('解析 Content（去 CDATA）', parsed.Content === '巨无霸 星河');
  check('解析 MsgId', parsed.MsgId === '1234567890');

  const entity = parseWechatXml('<xml><Content><![CDATA[a &amp; b]]></Content></xml>');
  check('CDATA 内的实体被还原', entity.Content === 'a & b', entity.Content);

  const plain = parseWechatXml('<xml><Content>no-cdata</Content></xml>');
  check('无 CDATA 的字段也能解析', plain.Content === 'no-cdata', plain.Content);
  check('空输入不抛异常', Object.keys(parseWechatXml('')).length === 0);
}

{
  const reply = buildTextReply({ toUserName: 'oAbc', fromUserName: 'gh_123', content: '你好' });
  check('回复的 ToUserName 是用户（方向已互换）', reply.includes('<ToUserName><![CDATA[oAbc]]></ToUserName>'));
  check('回复的 FromUserName 是公众号', reply.includes('<FromUserName><![CDATA[gh_123]]></FromUserName>'));
  check('MsgType 为 text', reply.includes('<MsgType><![CDATA[text]]></MsgType>'));
  check('带 CreateTime', /<CreateTime>\d+<\/CreateTime>/.test(reply));

  const tricky = buildTextReply({ toUserName: 'o', fromUserName: 'g', content: 'a]]>b' });
  check('内容里的 ]]> 被转义（否则 XML 被截断）', !tricky.includes('a]]>b'));
  check('转义后仍可被自己解析回来', parseWechatXml(tricky).Content === 'a]]>b', parseWechatXml(tricky).Content);

  check('success 回复就是字符串 success', buildSuccessReply() === 'success');
}

{
  check('文本消息可提取', extractText({ MsgType: 'text', Content: '巨无霸' }) === '巨无霸');
  check('空白文本被忽略', extractText({ MsgType: 'text', Content: '   ' }) === undefined);
  check('语音走 Recognition', extractText({ MsgType: 'voice', Recognition: '巨无霸' }) === '巨无霸');
  check('图片消息不支持', extractText({ MsgType: 'image', PicUrl: 'x' }) === undefined);
  check('关注事件不支持', extractText({ MsgType: 'event', Event: 'subscribe' }) === undefined);
}

// ─────────────────────────────────────────────────────────────
section('T23 客服消息与降级');

{
  check('45015 翻译成超窗提示', describeWechatError(45015).includes('48 小时'));
  check('48001 点明是权限问题', describeWechatError(48001).includes('客服消息权限'));
  check('未知错误码也能给出可读文案', describeWechatError(99999, 'x').includes('99999'));

  const provider = new AccessTokenProvider('id', 'secret');
  check('未获取时无缓存', (provider as unknown as { cached?: unknown }).cached === undefined);
  provider.invalidate();
  check('invalidate 不抛异常', true);
}

// ─────────────────────────────────────────────────────────────
section('T20 网页模拟器');

{
  const html = renderMockPage('演示模式（离线示例数据）');
  check('是完整 HTML 文档', html.startsWith('<!doctype html>'));
  check('不引外部脚本', !/<script[^>]+src=/i.test(html));
  check('不引外部样式/字体', !/<link[^>]+href=/i.test(html));
  check('含对话接口调用', html.includes('/api/chat'));
  check('模式标签被注入', html.includes('演示模式'));
  check('预设指令包含主场景', html.includes('巨无霸不要酸黄瓜 星河'));

  const escaped = renderMockPage('<img src=x onerror=alert(1)>');
  check('模式标签做了 HTML 转义（防注入）', !escaped.includes('<img src=x'));
}

// ─────────────────────────────────────────────────────────────
section('T22 HTTP 服务');

const core = new ConversationCore({ bundle: createGateway('sample') });
const server = new ChannelServer({ core, port: 0, token: TOKEN, modeLabel: '演示模式（离线示例数据）' });

const instance = await server.listen();
const addr = instance.address();
const port = typeof addr === 'object' && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
check('服务成功监听', port > 0, String(port));

{
  const res = await fetch(`${base}/healthz`);
  const body = (await res.json()) as Record<string, unknown>;
  check('健康检查返回 200', res.status === 200);
  check('健康检查含数据模式', typeof body.mode === 'string' && body.mode.length > 0, String(body.mode));
  check('健康检查报告异步推送能力', typeof body.asyncPush === 'boolean');
  check('WECHAT_TOKEN 已配置被识别', body.wechatConfigured === true);
}

{
  const res = await fetch(`${base}/`);
  const html = await res.text();
  check('首页返回网页模拟器', res.status === 200 && html.includes('<!doctype html>'));
  check('首页 Content-Type 为 HTML', (res.headers.get('content-type') ?? '').includes('text/html'));
  check('未配置 AppSecret 时异步推送关闭', server.canPushAsync === false);
}

{
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'web-test-1', text: '巨无霸 星河' }),
  });
  const body = (await res.json()) as { text?: string; kind?: string };
  check('对话接口返回 200', res.status === 200);
  check('对话接口给出预览卡片', body.kind === 'preview', String(body.kind));
  check('预览里有真实门店名', (body.text ?? '').includes('星河'));
  check('预览里有金额', /¥|元/.test(body.text ?? ''));

  const bad = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-json',
  });
  check('非法 JSON 返回 400 而非崩溃', bad.status === 400);
}

// ─────────────────────────────────────────────────────────────
section('T21 公众号回调端到端');

function signedUrl(path: string, extra: Record<string, string> = {}): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'abc123';
  const params = new URLSearchParams({ ...extra, timestamp, nonce });
  const signature = sha1Of([TOKEN, timestamp, nonce]);
  params.set('signature', signature);
  return `${base}${path}?${params.toString()}`;
}

{
  const res = await fetch(signedUrl('/wechat', { echostr: 'ECHO_ME' }));
  const text = await res.text();
  check('服务器配置校验回显 echostr', res.status === 200 && text === 'ECHO_ME', text);

  const bad = await fetch(`${base}/wechat?signature=wrong&timestamp=1&nonce=2&echostr=X`);
  check('签名错误时不回显 echostr', (await bad.text()) !== 'X');
}

async function postWechat(
  bodyXml: string,
  signature?: string,
  target: string = base,
): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'abc123';
  const sig = signature ?? sha1Of([TOKEN, timestamp, nonce]);
  const url = `${target}/wechat?signature=${sig}&timestamp=${timestamp}&nonce=${nonce}`;
  return fetch(url, { method: 'POST', body: bodyXml });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textXml(content: string, msgId: string, openId = 'oUser1'): string {
  return [
    '<xml>',
    '<ToUserName><![CDATA[gh_demo]]></ToUserName>',
    `<FromUserName><![CDATA[${openId}]]></FromUserName>`,
    '<CreateTime>1700000000</CreateTime>',
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content><![CDATA[${content}]]></Content>`,
    `<MsgId>${msgId}</MsgId>`,
    '</xml>',
  ].join('');
}

{
  const res = await postWechat(textXml('巨无霸 星河', '111000111'));
  const text = await res.text();
  check('文字消息返回被动回复 XML', res.status === 200 && text.includes('<MsgType><![CDATA[text]]></MsgType>'));
  check('回复定向到发消息的用户', text.includes('<ToUserName><![CDATA[oUser1]]></ToUserName>'));

  const replyText = parseWechatXml(text).Content ?? '';
  check('回复内容是预览卡片', replyText.includes('星河'), replyText.slice(0, 60));

  // 微信重试：同一 MsgId 再来两次
  const retry1 = await postWechat(textXml('巨无霸 星河', '111000111'));
  const retry2 = await postWechat(textXml('巨无霸 星河', '111000111'));
  check('重试 1 被去重拦下（回 success）', (await retry1.text()) === 'success');
  check('重试 2 被去重拦下（回 success）', (await retry2.text()) === 'success');

  const fresh = await postWechat(textXml('巨无霸 星河', '222000222'));
  check('新 MsgId 正常处理', (await fresh.text()).includes('<MsgType>'));

  const forged = await postWechat(textXml('巨无霸', '333'), 'forged-signature');
  check('伪造签名被拒（403）', forged.status === 403);
}

{
  // 无客服权限时的降级：结果进待回补队列
  type Privates = { deliverLater: (openId: string, text: string) => Promise<unknown> };
  const privates = server as unknown as Privates;
  await privates.deliverLater('oUser9', '这是迟到的结果');
  check('无客服权限时结果进入待回补队列', server.takePending('oUser9') === '这是迟到的结果');
  check('取出一次后清空', server.takePending('oUser9') === undefined);

  let clock = 0;
  const timed = new ChannelServer({ core, port: 0, token: TOKEN, now: () => clock });
  const timedPrivates = timed as unknown as Privates;
  await timedPrivates.deliverLater('oUser9', '过期结果');
  clock = 31 * 60 * 1000;
  check('超过 30 分钟的待回补结果被丢弃', timed.takePending('oUser9') === undefined);
}

// ─────────────────────────────────────────────────────────────
section('FR-21 5 秒超时 → success + 异步送达');

{
  // 故意做一个「慢」的核心：跑 400ms，而超时阈值设 100ms
  const slowCore = {
    gateway: { mode: 'sample', describe: () => '演示模式' },
    handle: async () => {
      await sleep(400);
      return { kind: 'preview', text: '迟到的预览卡片' };
    },
  } as unknown as ConversationCore;

  const slowServer = new ChannelServer({
    core: slowCore,
    port: 0,
    token: TOKEN,
    replyDeadlineMs: 100,
    now: () => 0,
  });
  const inst = await slowServer.listen();
  const slowAddr = inst.address();
  const slowBase = `http://127.0.0.1:${typeof slowAddr === 'object' && slowAddr ? slowAddr.port : 0}`;

  const res = await postWechat(textXml('巨无霸 星河', '900000001', 'oSlow'), undefined, slowBase);
  const text = await res.text();
  check('超时时立即回 success（官方推荐，可抑制重试）', text === 'success', text.slice(0, 40));

  check('此刻还没有结果', slowServer.takePending('oSlow') === undefined);
  await sleep(600);
  check('后台跑完后结果进入待回补队列', slowServer.takePending('oSlow') === '迟到的预览卡片');

  inst.close();
}

instance.close();

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`M4 自检：${passed} 通过 / ${failed} 失败`);
console.log('═'.repeat(52));

if (failed > 0) process.exitCode = 1;
