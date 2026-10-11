/**
 * 文本归一工具 —— 用户输入的第一道关口。
 *
 * 公众号里来的输入千奇百怪：全角空格、中英混排、颜文字、多余标点、
 * 「帮我点一个巨无霸谢谢」这种带客套话的长句。这里统一收敛成可比对的形式。
 */

/** 全角 ASCII（！＃＄％…）与常见全角标点 → 半角 */
const FULLWIDTH_OFFSET = 0xfee0;

const PUNCT_MAP: Readonly<Record<string, string>> = {
  '，': ',',
  '。': '.',
  '、': ',',
  '；': ';',
  '：': ':',
  '？': '?',
  '！': '!',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '《': '<',
  '》': '>',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '—': '-',
  '～': '~',
};

/**
 * 全角字符转半角。保留中文，只转换「视觉宽度」不同的 ASCII 与标点。
 */
export function foldWidth(input: string): string {
  let out = '';
  for (const ch of input) {
    const mapped = PUNCT_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    // 全角 ASCII 区段 ！(FF01) ~ ～(FF5E)
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCodePoint(code - FULLWIDTH_OFFSET);
      continue;
    }
    // 全角空格 Ideographic Space
    if (code === 0x3000) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 归一到可比对的紧凑形式：半角、去空白、小写 */
export function normalizeCompact(input: string): string {
  return foldWidth(input).toLowerCase().replace(/\s+/g, '');
}

/** 归一到"单空格分隔"的自然形式：半角、trim、连续空白折叠成一个空格 */
export function normalizeLoose(input: string): string {
  return foldWidth(input).trim().replace(/\s+/g, ' ');
}

/** 去掉句尾标点，避免「巨无霸。」匹配不到「巨无霸」 */
export function trimPunctuation(input: string): string {
  return input.replace(/^[\s,.;:!?'"()[\]<>~*#-]+/, '').replace(/[\s,.;:!?'"()[\]<>~*#-]+$/, '');
}

/**
 * 剥离下单语境里的客套话与动词前缀。
 * 例如「帮我点两个巨无霸谢谢」→「两个巨无霸谢谢」→ 再去掉句尾客套 →「两个巨无霸」。
 */
const LEADING_NOISE = [
  '我想要',
  '我想吃',
  '我想买',
  '我想点',
  '我想要点',
  '帮我点一个',
  '帮我来一个',
  '帮我下单',
  '帮我点',
  '给我来一个',
  '给我来',
  '给我点',
  '下单',
  '点一份',
  '来一份',
  '来一个',
  '我要点',
  '我要买',
  '我要一份',
  '我要一个',
  '我要',
  '想吃',
];

const TRAILING_NOISE = ['谢谢', '吧', '呢', '啊', '呀', '哦', '啦', '谢谢啦', '麻烦了'];

export function stripCourtesy(input: string): string {
  let text = normalizeLoose(input);
  let changed = true;
  // 反复剥离，支持「我想点个」叠加的情况，最多 3 轮防止死循环
  for (let round = 0; round < 3 && changed; round += 1) {
    changed = false;
    for (const noise of LEADING_NOISE) {
      if (text.startsWith(noise) && text.length > noise.length) {
        text = text.slice(noise.length).trim();
        changed = true;
      }
    }
    for (const noise of TRAILING_NOISE) {
      if (text.endsWith(noise) && text.length > noise.length) {
        text = text.slice(0, -noise.length).trim();
        changed = true;
      }
    }
  }
  return trimPunctuation(text);
}

/** 是否主要由 ASCII 组成（用于判断要不要走拼音/英文别名分支） */
export function isMostlyAscii(input: string): boolean {
  const ascii = input.replace(/[^\x20-\x7e]/g, '').length;
  return input.length > 0 && ascii / input.length > 0.6;
}

/**
 * 二元组 Dice 系数，用于模糊相似度。
 * 比编辑距离更适合短中文串：不考虑顺序，对「巨无霸堡」vs「巨无霸」这类也更友好。
 */
export function diceCoefficient(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }

  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      hits += 1;
    }
  }

  return (2 * hits) / (a.length - 1 + (b.length - 1));
}

/**
 * 判断 `short` 是否为 `long` 的子序列（允许缺字，保序）。
 * 例如 "小区便利" 是 "示例市小区便利店" 的子序列 —— 对付漏字很好用。
 */
export function isSubsequence(short: string, long: string): boolean {
  let i = 0;
  for (const ch of long) {
    if (ch === short[i]) i += 1;
    if (i === short.length) return true;
  }
  return i === short.length;
}
