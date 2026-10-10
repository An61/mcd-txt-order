/**
 * 公众号消息加解密（安全模式 / 兼容模式）。零依赖，只用 node:crypto。
 *
 * 为什么必须自己实现这一段：
 * 公众号后台的「消息加解密方式」一旦选了安全模式，微信推过来的 body 里
 * 只有一个 `<Encrypt>` 字段 —— 不解密就完全不知道用户说了什么。
 * 而官方文档给的示例是 Python / Java / PHP，Node 版要么依赖 xml2js，
 * 要么就是复制粘贴的残缺实现。这里把它做成**可单测的纯函数**，
 * 用 scripts/check-m8.ts 里的往返断言兜住。
 *
 * 算法要点（按官方规范，逐条对应下方代码）：
 *   ① EncodingAESKey 是 43 位字符，补一个 '=' 后 base64 解码得 32 字节密钥，IV 取其前 16 字节
 *   ② 明文结构 = 16 字节随机串 + 4 字节网络序长度 + 明文 + AppID
 *   ③ 用 PKCS#7 补齐到 **32** 字节的整数倍（不是常见的 16，这是最容易错的一处）
 *   ④ AES-256-CBC，且必须 `setAutoPadding(false)`：填充由我们自己按 32 做
 *   ⑤ 消息签名 msg_signature = SHA1(sort(token, timestamp, nonce, 密文))
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** 官方规定 EncodingAESKey 为 43 个字符 */
export const ENCODING_AES_KEY_LENGTH = 43;

/** 明文前缀：16 字节随机串 + 4 字节长度 */
const HEADER_BYTES = 20;

/** 分组长度：这里是 32 而非 AES 标准块长 16 —— 官方规范如此 */
const BLOCK_SIZE = 32;

/**
 * 43 位 EncodingAESKey → 32 字节密钥。
 *
 * 校验放在这里而不是调用处，好处是「配置写错」会在服务**启动时**就炸出来，
 * 而不是等到微信第一次推消息才在解密阶段报一个看不懂的错。
 */
export function parseEncodingAesKey(encodingAesKey: string): Buffer {
  const raw = String(encodingAesKey ?? '').trim();
  if (raw.length !== ENCODING_AES_KEY_LENGTH) {
    throw new Error(
      `EncodingAESKey 必须是 ${ENCODING_AES_KEY_LENGTH} 位字符，当前 ${raw.length} 位。` +
        '（公众号后台「基本配置 → 服务器配置」里点「随机生成」可得）',
    );
  }
  const key = Buffer.from(`${raw}=`, 'base64');
  if (key.length !== 32) {
    throw new Error('EncodingAESKey 解码后不是 32 字节，请确认是从后台复制的完整值');
  }
  return key;
}

/** 官方签名算法：参与排序的元素由调用方给出，避免每处重复写排序逻辑 */
export function sha1OfSorted(parts: readonly string[]): string {
  return createHash('sha1').update([...parts].sort().join('')).digest('hex');
}

export interface EncryptedReply {
  /** 完整 XML，可直接作为响应体 */
  readonly xml: string;
  readonly encrypt: string;
  readonly msgSignature: string;
  readonly timestamp: string;
  readonly nonce: string;
}

export class WechatMessageCrypto {
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private readonly token: string;
  private readonly appId: string;

  constructor(params: {
    readonly token: string;
    readonly appId: string;
    readonly encodingAesKey: string;
  }) {
    this.key = parseEncodingAesKey(params.encodingAesKey);
    this.iv = this.key.subarray(0, 16);
    this.token = params.token;
    this.appId = params.appId;
  }

  /** AES-256-CBC 加密，返回 base64 密文 */
  encrypt(plainText: string): string {
    const payload = Buffer.from(plainText, 'utf8');
    const header = Buffer.alloc(HEADER_BYTES);
    randomBytes(16).copy(header, 0);
    header.writeUInt32BE(payload.length, 16);

    const body = Buffer.concat([header, payload, Buffer.from(this.appId, 'utf8')]);
    const padLen = BLOCK_SIZE - (body.length % BLOCK_SIZE);
    const padded = Buffer.concat([body, Buffer.alloc(padLen, padLen)]);

    const cipher = createCipheriv('aes-256-cbc', this.key, this.iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  }

  /**
   * 解密，返回明文 XML。
   *
   * 除了 PKCS#7 校验，还会**核对尾部 AppID** —— 这一步常被省略，
   * 但它是识别「密文被换成了其它公众号的」的唯一手段。
   */
  decrypt(encrypt: string): string {
    const cipherText = Buffer.from(String(encrypt ?? ''), 'base64');
    if (cipherText.length === 0 || cipherText.length % BLOCK_SIZE !== 0) {
      throw new Error('密文长度非法：不是 base64 或未按 32 字节对齐');
    }

    const decipher = createDecipheriv('aes-256-cbc', this.key, this.iv);
    decipher.setAutoPadding(false);
    const decoded = Buffer.concat([decipher.update(cipherText), decipher.final()]);

    const padLen = decoded[decoded.length - 1] ?? 0;
    if (padLen < 1 || padLen > BLOCK_SIZE || padLen > decoded.length) {
      throw new Error('PKCS#7 填充非法，密文可能已被篡改');
    }
    for (let i = decoded.length - padLen; i < decoded.length; i += 1) {
      if (decoded[i] !== padLen) throw new Error('PKCS#7 填充字节不一致，密文可能已被篡改');
    }

    const body = decoded.subarray(0, decoded.length - padLen);
    if (body.length <= HEADER_BYTES) throw new Error('解密后长度不足，无法读取消息头');

    const length = body.readUInt32BE(16);
    if (HEADER_BYTES + length > body.length) {
      throw new Error('解密后声明的长度越界，密文可能已被篡改');
    }

    const xml = body.subarray(HEADER_BYTES, HEADER_BYTES + length).toString('utf8');
    const fromAppId = body.subarray(HEADER_BYTES + length).toString('utf8');
    if (fromAppId !== this.appId) {
      throw new Error('密文尾部的 AppID 与本机配置不一致，拒绝处理');
    }
    return xml;
  }

  /** 校验消息体签名（安全/兼容模式下的 msg_signature） */
  verifyMessageSignature(params: {
    readonly msgSignature: string;
    readonly timestamp: string;
    readonly nonce: string;
    readonly encrypt: string;
  }): boolean {
    const { msgSignature, timestamp, nonce, encrypt } = params;
    if (!msgSignature) return false;

    const digest = sha1OfSorted([this.token, timestamp, nonce, encrypt]);
    const a = Buffer.from(digest, 'utf8');
    const b = Buffer.from(msgSignature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** 把一条明文回复 XML 包装成加密模式的响应体 */
  encryptReply(plainXml: string, now: () => number = Date.now): EncryptedReply {
    const encrypt = this.encrypt(plainXml);
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = String(Math.floor(Math.random() * 1e10));
    const msgSignature = sha1OfSorted([this.token, timestamp, nonce, encrypt]);

    const xml = [
      '<xml>',
      `<Encrypt><![CDATA[${encrypt}]]></Encrypt>`,
      `<MsgSignature><![CDATA[${msgSignature}]]></MsgSignature>`,
      `<TimeStamp>${timestamp}</TimeStamp>`,
      `<Nonce><![CDATA[${nonce}]]></Nonce>`,
      '</xml>',
    ].join('');

    return { xml, encrypt, msgSignature, timestamp, nonce };
  }
}

/** 判断微信推来的 body 是否为加密信封（兼容模式下两种形态都可能出现） */
export function isEncryptedEnvelope(xml: string): boolean {
  return /<Encrypt>([\s\S]*?)<\/Encrypt>/i.test(String(xml ?? ''));
}

/** 从加密信封里取出密文文本 */
export function extractEncrypt(xml: string): string {
  const match = /<Encrypt>(?:\s*<!\[CDATA\[)?([\s\S]*?)(?:\]\]>\s*)?<\/Encrypt>/i.exec(
    String(xml ?? ''),
  );
  return (match?.[1] ?? '').trim();
}
