/**
 * M8 生产上线自检（消息加解密 / 生产化服务 / 路由隔离）。
 *
 * 这一层钉死的是**上线才会暴露**的问题：
 *   · 安全模式下 echostr 是密文 —— 直接回给微信就会一直「token 验证失败」
 *   · 填充按 32 字节而不是 16 —— 错了加密能过、解密必炸
 *   · 对外监听时调试入口必须自动关闭 —— 否则等于把下单能力开放给公网
 *
 * 全程离线：不连 MCP、不连微信、不发起任何真实下单。
 */

import {
  WechatMessageCrypto,
  extractEncrypt,
  isEncryptedEnvelope,
  parseEncodingAesKey,
  sha1OfSorted,
} from '../src/channel/crypto.ts';
import {
  ChannelServer,
  WELCOME_TEXT,
  resolveWechatVerify,
} from '../src/channel/server.ts';
import { ConversationCore } from '../src/channel/core.ts';
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

const TOKEN = 'prod_token_xyz';
const APP_ID = 'wx1234567890abcdef';
// 43 位，取自官方允许的字符范围
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

const crypto = new WechatMessageCrypto({ token: TOKEN, appId: APP_ID, encodingAesKey: AES_KEY });

// ─────────────────────────────────────────────────────────────
section('EncodingAESKey 解析');

{
  const key = parseEncodingAesKey(AES_KEY);
  check('43 位密钥解码为 32 字节', key.length === 32);

  let threw = false;
  try {
    parseEncodingAesKey('tooshort');
  } catch {
    threw = true;
  }
  check('长度不足时明确报错', threw);

  threw = false;
  try {
    parseEncodingAesKey('');
  } catch {
    threw = true;
  }
  check('空值也报错（避免"能启动但解不了密"）', threw);

  check('43 位之外的常见错误长度(44)被拒', (() => {
    try {
      parseEncodingAesKey(`${AES_KEY}=`);
      return false;
    } catch {
      return true;
    }
  })());
}

// ─────────────────────────────────────────────────────────────
section('加解密往返（AES-256-CBC + PKCS#7@32）');

{
  const plain = '<xml><ToUserName><![CDATA[gh_x]]></ToUserName><Content><![CDATA[巨无霸 香梅北]]></Content></xml>';
  const cipherText = crypto.encrypt(plain);
  const back = crypto.decrypt(cipherText);
  check('加密再解密能还原原文', back === plain);
  check('密文是 base64', /^[A-Za-z0-9+/]+={0,2}$/.test(cipherText));
  check('密文长度是 32 字节的整数倍', Buffer.from(cipherText, 'base64').length % 32 === 0);
  check('中文不会丢字符', back.includes('巨无霸 香梅北'));

  // 两次加密结果必须不同（16 字节随机前缀），否则等于把 IV 写死了
  check('相同明文两次加密结果不同（随机前缀生效）', crypto.encrypt(plain) !== cipherText);

  // 超长消息（>1 个分组）也不能错
  const long = `<xml><Content><![CDATA[${'麦'.repeat(500)}]]></Content></xml>`;
  check('长消息跨分组还原正确', crypto.decrypt(crypto.encrypt(long)) === long);
}

{
  // 篡改检测：换掉密文尾部（AppID 区域）应当被拒
  const cipherText = crypto.encrypt('<xml><Content><![CDATA[hi]]></Content></xml>');
  const buf = Buffer.from(cipherText, 'base64');
  buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff;
  let threw = false;
  try {
    crypto.decrypt(buf.toString('base64'));
  } catch {
    threw = true;
  }
  check('密文被篡改时拒绝解密', threw);
}

{
  // AppID 不一致：用另一个 AppID 构造的密文，本实例必须拒绝
  const other = new WechatMessageCrypto({
    token: TOKEN,
    appId: 'wx_other_other_other',
    encodingAesKey: AES_KEY,
  });
  const foreign = other.encrypt('<xml><Content><![CDATA[hi]]></Content></xml>');
  let message = '';
  try {
    crypto.decrypt(foreign);
  } catch (error) {
    message = String(error instanceof Error ? error.message : error);
  }
  check('其它公众号的密文被拒绝（核对尾部 AppID）', message.includes('AppID'), message);
}

{
  let threw = false;
  try {
    crypto.decrypt('not-base64!!!');
  } catch {
    threw = true;
  }
  check('非 base64 输入被拒绝', threw);
}

// ─────────────────────────────────────────────────────────────
section('消息签名 msg_signature');

{
  const encrypt = crypto.encrypt('<xml><Content><![CDATA[hi]]></Content></xml>');
  const timestamp = '1700000000';
  const nonce = '12345';
  const good = sha1OfSorted([TOKEN, timestamp, nonce, encrypt]);

  check(
    '正确的 msg_signature 通过',
    crypto.verifyMessageSignature({ msgSignature: good, timestamp, nonce, encrypt }),
  );
  check(
    '错误的签名被拒绝',
    !crypto.verifyMessageSignature({ msgSignature: good.replace(/^./, 'x'), timestamp, nonce, encrypt }),
  );
  check(
    '密文被换掉后签名不再匹配',
    !crypto.verifyMessageSignature({ msgSignature: good, timestamp, nonce, encrypt: `${encrypt}x` }),
  );
  check('空签名直接判否', !crypto.verifyMessageSignature({ msgSignature: '', timestamp, nonce, encrypt }));
}

// ─────────────────────────────────────────────────────────────
section('服务器配置校验（含安全模式的加密 echostr）');

{
  const timestamp = '1700000000';
  const nonce = '54321';
  const signature = sha1OfSorted([TOKEN, timestamp, nonce]);

  const plainResult = resolveWechatVerify({
    token: TOKEN,
    mode: 'plain',
    signature,
    msgSignature: '',
    timestamp,
    nonce,
    echostr: 'hello-echo',
  });
  check('明文模式原样回显 echostr', plainResult.ok && plainResult.body === 'hello-echo');

  const badResult = resolveWechatVerify({
    token: TOKEN,
    mode: 'plain',
    signature: 'deadbeef',
    msgSignature: '',
    timestamp,
    nonce,
    echostr: 'hello-echo',
  });
  check('签名不符时给出明确文案', !badResult.ok && badResult.body === 'signature mismatch');

  // 安全模式：echostr 是密文，必须解密后返回
  const encryptedEcho = crypto.encrypt('real-echo');
  const secureResult = resolveWechatVerify({
    token: TOKEN,
    mode: 'encrypt',
    crypto,
    signature,
    msgSignature: '',
    timestamp,
    nonce,
    echostr: encryptedEcho,
  });
  check('安全模式解密 echostr 后回显明文', secureResult.ok && secureResult.body === 'real-echo');

  // 安全模式但没配密钥 → 必须明确说缺什么，而不是抛异常
  const noKey = resolveWechatVerify({
    token: TOKEN,
    mode: 'encrypt',
    signature,
    msgSignature: '',
    timestamp,
    nonce,
    echostr: encryptedEcho,
  });
  check('安全模式缺密钥时给出可执行提示', !noKey.ok && noKey.body.includes('WECHAT_ENCODING_AES_KEY'));

  // 没配 token 时
  const noToken = resolveWechatVerify({
    token: '',
    mode: 'plain',
    signature,
    msgSignature: '',
    timestamp,
    nonce,
    echostr: 'x',
  });
  check('未配置 token 时给出提示而非崩溃', !noToken.ok && noToken.body.includes('WECHAT_TOKEN'));
}

// ─────────────────────────────────────────────────────────────
section('加密信封识别');

{
  check('识别含 Encrypt 的 body', isEncryptedEnvelope('<xml><Encrypt><![CDATA[abc]]></Encrypt></xml>'));
  check('普通明文 body 判为未加密', !isEncryptedEnvelope('<xml><Content><![CDATA[hi]]></Content></xml>'));
  check('能取出 CDATA 里的密文', extractEncrypt('<xml><Encrypt><![CDATA[abc123]]></Encrypt></xml>') === 'abc123');
  check('无 CDATA 时也能取出密文', extractEncrypt('<xml><Encrypt>abc123</Encrypt></xml>') === 'abc123');
}

{
  const reply = crypto.encryptReply('<xml><Content><![CDATA[你好]]></Content></xml>', () => 1700000000000);
  check('加密回复含 Encrypt 字段', reply.xml.includes('<Encrypt>'));
  check('加密回复含 MsgSignature', reply.xml.includes('<MsgSignature>'));
  check('加密回复含 TimeStamp 与 Nonce', reply.xml.includes('<TimeStamp>') && reply.xml.includes('<Nonce>'));
  check('时间戳取自传入的 now', reply.timestamp === '1700000000');
  check('回复可被对方解密还原', (() => {
    const dec = crypto.decrypt(extractEncrypt(reply.xml));
    return dec.includes('你好');
  })());
}

// ─────────────────────────────────────────────────────────────
section('生产化服务：默认值与安全开关');

function makeServer(options: Partial<Parameters<typeof buildServer>[0]> = {}) {
  return buildServer(options);
}

function buildServer(options: {
  host?: string;
  exposeMock?: boolean;
  encryptMode?: 'plain' | 'mixed' | 'encrypt';
  encodingAesKey?: string;
  appId?: string;
  appSecret?: string;
  token?: string;
}) {
  const core = new ConversationCore({ bundle: createGateway('sample') });
  return new ChannelServer({
    core,
    port: 0,
    host: options.host ?? '127.0.0.1',
    token: options.token ?? TOKEN,
    appId: options.appId ?? APP_ID,
    appSecret: options.appSecret,
    encodingAesKey: options.encodingAesKey,
    encryptMode: options.encryptMode ?? 'plain',
    ...(options.exposeMock === undefined ? {} : { exposeMock: options.exposeMock }),
  });
}

{
  const local = makeServer({ host: '127.0.0.1' });
  check('仅听回环时默认开放调试入口', local.config.exposeMock === true);

  const pub = makeServer({ host: '0.0.0.0' });
  check('对外监听时默认关闭调试入口', pub.config.exposeMock === false);

  const forced = makeServer({ host: '0.0.0.0', exposeMock: true });
  check('显式 EXPOSE_MOCK 可强制打开', forced.config.exposeMock === true);

  check('监听地址被记录进 config', pub.config.host === '0.0.0.0');
  check('加解密模式被记录进 config', pub.config.encryptMode === 'plain');
  check('未配密钥时 cryptoReady 为 false', pub.config.cryptoReady === false);
  check(
    '配了密钥后 cryptoReady 为 true',
    makeServer({ encodingAesKey: AES_KEY }).config.cryptoReady === true,
  );
}

{
  let threw = false;
  let message = '';
  try {
    makeServer({ encryptMode: 'encrypt' });
  } catch (error) {
    threw = true;
    message = String(error instanceof Error ? error.message : error);
  }
  check('安全模式缺密钥时启动即失败（快速失败）', threw && message.includes('WECHAT_ENCODING_AES_KEY'), message);
}

{
  // 对外监听 + 明文模式：调试入口必须不可达
  const server = makeServer({ host: '0.0.0.0' });
  const instance = await server.listen();
  const address = instance.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const rootRes = await fetch(`http://127.0.0.1:${port}/`);
  check('对外模式下 / 返回 404', rootRes.status === 404, `实际 ${rootRes.status}`);

  const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    body: JSON.stringify({ text: '巨无霸 香梅北' }),
  });
  check('对外模式下 /api/chat 返回 404', chatRes.status === 404, `实际 ${chatRes.status}`);

  const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
  const health = (await healthRes.json()) as Record<string, unknown>;
  check('健康检查仍可用', healthRes.status === 200 && health.ok === true);
  check('健康检查暴露 exposeMock 供运维核对', health.exposeMock === false);
  check('健康检查暴露 encryptMode', health.encryptMode === 'plain');

  instance.close();
}

{
  // 回环监听：模拟器必须还在（否则本地调试没法用）
  const server = makeServer({ host: '127.0.0.1' });
  const instance = await server.listen();
  const address = instance.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const res = await fetch(`http://127.0.0.1:${port}/`);
  const html = await res.text();
  check('回环模式下网页模拟器可访问', res.status === 200 && html.includes('<html'));
  instance.close();
}

// ─────────────────────────────────────────────────────────────
section('关注欢迎语');

{
  check('欢迎语说明了用法', WELCOME_TEXT.includes('巨无霸 香梅北'));
  check('欢迎语提示需要确认才会下单', WELCOME_TEXT.includes('确认'));
  check('欢迎语提示帮助入口', WELCOME_TEXT.includes('帮助'));
  check('欢迎语长度适合手机阅读（<300 字）', WELCOME_TEXT.length < 300, `实际 ${WELCOME_TEXT.length}`);
}

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`M8 自检：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('⛔ 存在失败项，请修复后再上线。');
  process.exitCode = 1;
}
