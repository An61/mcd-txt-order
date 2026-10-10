/**
 * 数量与多品解析（判断用户"到底要了几份"）。
 *
 * 用户原话样例：
 * - 「巨无霸」                → 1 份
 * - 「两个巨无霸一杯可乐」      → 巨无霸×2、可乐×1（连写，没有分隔符）
 * - 「2份麦辣鸡腿堡、大薯条」  → 麦辣鸡腿堡×2、大薯条×1
 * - 「巨无霸不要酸黄瓜」        → 巨无霸×1（**特制由 matcher.resolveItemText 菜单感知地切出**，
 *                                这里不猜关键词 —— 实测「酥酥多笋卷」里有「多」、
 *                                「巨无霸」里有「无」，靠关键词切分必然误伤）
 * - 「麦乐鸡5块」              → **整段是品名**，不能被拆成「麦乐鸡 ×5」
 *
 * 最后一条是这里最大的坑：菜单里存在「麦乐鸡5块」「麦辣鸡翅-2块」这种
 * **名字自带数字**的餐品。为了不误伤，本模块采用如下取舍：
 *
 * | 形态 | 是否当作数量 | 理由 |
 * |---|---|---|
 * | 中文数字 + 量词（两个 / 一杯 / 三份） | ✅ 是 | 品名里几乎不出现「数字+量词」组合 |
 * | 阿拉伯数字位于片段开头（2份） | ✅ 是 | 用户显式书写，意图明确 |
 * | 阿拉伯数字紧跟在汉字后面（麦乐鸡5块） | ❌ 否 | 极可能是品名的一部分 |
 * | 尾部 `x2` / `*2`（巨无霸x2） | ✅ 是 | 用户显式书写 |
 */

import { normalizeLoose, stripCourtesy, trimPunctuation } from './text.ts';

export interface RawItemSpec {
  /** 归一化后的名称片段，如「巨无霸」 */
  readonly name: string;
  /** 数量，恒 ≥ 1 */
  readonly quantity: number;
  /** 用户明确说了「套餐 / 组合 / 件套」 */
  readonly wantsCombo: boolean;
  /** 用户明确说了「单品 / 单点 / 单汉堡」 */
  readonly wantsSingle: boolean;
}

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  俩: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};

/** 中文数字字符类（含十） */
const CN_NUM_CLASS = '零〇一壹二两俩贰三叁四肆五伍六陆七柒八捌九玖十';

/** 量词。出现在数字后面表示一份的量，解析完成后会被吞掉 */
const QUANTIFIER_CLASS = '个份杯盒块包套支瓶罐只枚客例张片碗桶:';

/** 「俩」特殊：口语里直接接品名，不带量词（「俩巨无霸」） */
const STANDALONE_CHINESE_NUM = ['俩'];

/** 分隔符：空白、中文逗号、顿号、分号、加号 */
const SEPARATOR_CLASS = '[\\s,，、;；+＋]';
const SEPARATOR_RE = new RegExp(SEPARATOR_CLASS);

/** 连接词：切成两个片段 */
const CONJUNCTIONS = ['还有', '另外', '加上', '以及', '再加', '和', '与'];

const COMBO_PATTERN = /套餐|组合|件套|三件套|二件套/;
const SINGLE_PATTERN = /单品|单点|单汉堡|单个|只要汉堡|不要套餐/;

/**
 * 解析一段用户文本，产出若干「餐品意图」。
 * 没识别出任何餐品时返回空数组，由上层决定是回帮助还是做其它处理。
 */
export function parseItemSpecs(input: string): RawItemSpec[] {
  const cleaned = stripCourtesy(input);
  if (!cleaned) return [];

  const specs: RawItemSpec[] = [];
  for (const segment of splitByConjunction(cleaned)) {
    for (const spec of parseSegment(segment)) specs.push(spec);
  }
  return mergeDuplicates(specs);
}

// ─────────────────────────────────────────────────────────────
// 片段切分
// ─────────────────────────────────────────────────────────────

function splitByConjunction(text: string): string[] {
  let working = text;
  for (const word of CONJUNCTIONS) {
    working = working.split(word).join(' ');
  }
  return working
    .split(SEPARATOR_RE)
    .map((piece) => trimPunctuation(piece))
    .filter((piece) => piece.length > 0);
}

/**
 * 一个片段里可能含多个餐品（「两个巨无霸一杯可乐」），按数量标记切开。
 * 采用「先找出所有合法数量标记的位置，再据此切段」的写法 —— 比逐字符状态机好验证。
 */
function splitByQuantity(segment: string): string[] {
  const marks = findQuantityMarks(segment);
  if (marks.length === 0) return [segment];

  const pieces: string[] = [];
  const head = trimPunctuation(segment.slice(0, marks[0]?.start ?? 0));
  if (head) pieces.push(head);

  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i]?.start ?? 0;
    const end = marks[i + 1]?.start ?? segment.length;
    const piece = trimPunctuation(segment.slice(start, end));
    if (piece) pieces.push(piece);
  }

  return pieces.length > 0 ? pieces : [segment];
}

interface Mark {
  readonly start: number;
  readonly end: number;
}

function findQuantityMarks(segment: string): Mark[] {
  const pattern = new RegExp(
    `(?:([${CN_NUM_CLASS}]+)|(\\d+(?:\\.\\d+)?))\\s*[${QUANTIFIER_CLASS}]?`,
    'g',
  );
  const marks: Mark[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(segment)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }

    const digits = match[1] ?? '';
    const isChinese = Boolean(match[1]);
    const start = match.index;
    const end = start + match[0].length;

    const prevChar = start > 0 ? segment[start - 1] ?? '' : '';
    const atBoundary = start === 0 || SEPARATOR_RE.test(prevChar);

    // 量词是否已被本次匹配吃掉（「两个」「一杯」的位数在这里）
    // 注意不能去看 match 之后的文本 —— 量词已经被正则吞进 match[0] 了。
    const hasQuantifier = new RegExp(`[${QUANTIFIER_CLASS}]$`).test(match[0].trimEnd());

    if (isChinese) {
      // 中文数字：要求带量词，或是「俩」这类可省略量词的口语表达
      if (!hasQuantifier && !STANDALONE_CHINESE_NUM.includes(digits)) continue;
    } else if (!atBoundary) {
      // 阿拉伯数字夹在文字里 → 视为品名的一部分（麦乐鸡5块）
      continue;
    }

    // 与上一段 milk数量标记重叠则跳过，避免重复切分
    const previous = marks[marks.length - 1];
    if (previous && start < previous.end) continue;

    marks.push({ start, end });
  }

  return marks;
}

// ─────────────────────────────────────────────────────────────
// 单个餐品的解析
// ─────────────────────────────────────────────────────────────

function parseSegment(segment: string): RawItemSpec[] {
  const wantsCombo = COMBO_PATTERN.test(segment);
  const wantsSingle = SINGLE_PATTERN.test(segment);
  const specs: RawItemSpec[] = [];

  for (const piece of splitByQuantity(segment)) {
    const { quantity, nameSource } = readQuantity(piece);
    const name = trimPunctuation(normalizeLoose(nameSource));
    if (!name) continue;

    specs.push({
      name,
      quantity: Math.max(1, Math.floor(quantity)),
      wantsCombo,
      wantsSingle,
    });
  }

  return specs;
}

/** 从一个片段头部读出数量，返回剩余的名称部分 */
function readQuantity(text: string): { quantity: number; nameSource: string } {
  const trailing = /^(.*?)\s*[xX*×]\s*(\d+)$/.exec(text);
  if (trailing) {
    const qty = Number.parseInt(trailing[2] ?? '1', 10);
    return { quantity: Number.isFinite(qty) ? qty : 1, nameSource: trailing[1] ?? '' };
  }

  const match = new RegExp(
    `^\\s*(?:([${CN_NUM_CLASS}]+)|(\\d+(?:\\.\\d+)?))\\s*[${QUANTIFIER_CLASS}]?\\s*`,
  ).exec(text);
  if (!match) return { quantity: 1, nameSource: text };

  const chineseValue = match[1] ? parseChineseNumber(match[1]) : undefined;
  const arabicValue = match[2] ? Number.parseFloat(match[2]) : undefined;
  const quantity = chineseValue ?? arabicValue ?? 1;

  return { quantity: quantity > 0 ? quantity : 1, nameSource: text.slice(match[0].length) };
}

/**
 * 中文数字 → 阿拉伯数字。支持 十 / 十X / X十 / X十Y。
 * 解析不了返回 undefined，调用方按数量 1 处理。
 */
export function parseChineseNumber(text: string): number | undefined {
  if (!text) return undefined;

  if (text.includes('十')) {
    const [left, right] = text.split('十');
    const tens = left && left.length > 0 ? CN_DIGITS[left] : 1;
    const ones = right && right.length > 0 ? CN_DIGITS[right] : 0;
    if (tens === undefined || ones === undefined) return undefined;
    return tens * 10 + ones;
  }

  let total = 0;
  let matched = 0;
  for (const ch of text) {
    const digit = CN_DIGITS[ch];
    if (digit === undefined) return undefined;
    total = total * 10 + digit;
    matched += 1;
  }
  return matched > 0 ? total : undefined;
}

/** 同名条目合并数量 —— 「巨无霸 巨无霸」应当等于「两个巨无霸」 */
function mergeDuplicates(specs: RawItemSpec[]): RawItemSpec[] {
  const merged = new Map<string, RawItemSpec>();
  for (const spec of specs) {
    const key = spec.name;
    const existing = merged.get(key);
    if (existing) {
      merged.set(key, { ...existing, quantity: existing.quantity + spec.quantity });
      continue;
    }
    merged.set(key, spec);
  }
  return [...merged.values()];
}
