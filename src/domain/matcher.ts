/**
 * 四级降级匹配（FR-7 / FR-8 / FR-9）。
 *
 * 降级顺序：
 *   1. **精确**  归一后与品名完全相等            → 1.00
 *   2. **别名**  命中用户配置的别名（含拼音缩写） → 0.95
 *   3. **包含**  品名包含查询串，或查询串包含品名 → 0.50 ~ 0.90（按长度占比给分）
 *   4. **模糊**  二元组相似度 + 子序列命中        → 0 ~ 0.70
 *
 * 两条硬约束：
 * - **候选分差过小必须让用户选**（FR-8），不许悄悄取第一名 —— 点错单是要真花钱的。
 * - **「单汉堡」与「套餐」要能区分**（FR-9）。实测菜单里确实同时存在
 *   「巨无霸」和「某某套餐」两种品名，靠名字本身就够区分，这里只做加权。
 */

import { diceCoefficient, isSubsequence, normalizeCompact } from './text.ts';

export type MatchLevel = 'exact' | 'alias' | 'contains' | 'fuzzy';

export interface MatchCandidate {
  readonly id: string;
  readonly name: string;
  /** 用户自定义别名，可含中文别名与拼音缩写（jwb / xinghe） */
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
}

export interface Scored<T> {
  readonly item: T;
  readonly score: number;
  readonly level: MatchLevel;
}

export type MatchStatus = 'hit' | 'ambiguous' | 'miss';

export interface MatchOutcome<T> {
  readonly status: MatchStatus;
  readonly best?: Scored<T>;
  /** 待选列表，用于追问用户选哪一个 */
  readonly candidates: Scored<T>[];
}

export interface MatchOptions {
  /** `single` 倾向单品、`combo` 倾向套餐 */
  prefer?: 'single' | 'combo';
  /** 最低可接受分数，低于此值视为没匹配到 */
  minScore?: number;
  /** 第一名与第二名分差小于此值时判定为「候选难分」 */
  ambiguityGap?: number;
  /** 最多返回多少个候选 */
  limit?: number;
}

/** 低于这个分数就当没找到 —— 宁可让用户再说一遍，也不要点错单 */
export const MIN_SCORE = 0.45;
/** 分差阈值：实测中文短串下 0.05 已足够区分「巨无霸」与「巨无霸套餐」 */
export const AMBIGUITY_GAP = 0.05;
export const MAX_CANDIDATES = 5;

/** 名称里带这些词的，视为套餐/组合类商品 */
const COMBO_NAME_PATTERN = /套餐|组合|件套|欢乐|桶|全家餐|多人餐/;

/**
 * 给候选打分并排序。返回的数组已按分数降序，包含所有超过 minScore 的候选。
 */
export function rank<T extends MatchCandidate>(
  query: string,
  items: readonly T[],
  options: MatchOptions = {},
): Scored<T>[] {
  const minScore = options.minScore ?? MIN_SCORE;
  const needle = normalizeCompact(query);
  if (!needle) return [];

  const scored: Scored<T>[] = [];

  for (const item of items) {
    const result = scoreOne(needle, item, options);
    if (!result || result.score < minScore) continue;
    scored.push(result);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * 选出唯一结果；拿不稳时返回 `ambiguous`，由上层把候选列表抛给用户。
 */
export function pickOne<T extends MatchCandidate>(
  query: string,
  items: readonly T[],
  options: MatchOptions = {},
): MatchOutcome<T> {
  const limit = options.limit ?? MAX_CANDIDATES;
  const gap = options.ambiguityGap ?? AMBIGUITY_GAP;
  const ranked = rank(query, items, options);

  if (ranked.length === 0) return { status: 'miss', candidates: [] };
  if (ranked.length === 1) {
    const best = ranked[0];
    return { status: 'hit', best, candidates: ranked.slice(0, limit) };
  }

  const first = ranked[0];
  const second = ranked[1];
  if (!first || !second) return { status: 'miss', candidates: [] };

  if (first.score - second.score < gap) {
    return { status: 'ambiguous', best: first, candidates: ranked.slice(0, limit) };
  }

  return { status: 'hit', best: first, candidates: ranked.slice(0, limit) };
}

// ─────────────────────────────────────────────────────────────
// 打分细节
// ─────────────────────────────────────────────────────────────

function scoreOne<T extends MatchCandidate>(
  needle: string,
  item: T,
  options: MatchOptions,
): Scored<T> | undefined {
  const name = normalizeCompact(item.name);
  if (!name) return undefined;

  let score = 0;
  let level: MatchLevel = 'fuzzy';

  if (name === needle) {
    score = 1;
    level = 'exact';
  } else {
    const aliasScore = scoreAliases(needle, item.aliases);
    if (aliasScore > 0) {
      score = aliasScore;
      level = 'alias';
    } else if (name.includes(needle) && needle.length >= 2) {
      // 长度越接近，说明用户写得越完整，置信度越高
      const ratio = Math.min(name.length, needle.length) / Math.max(name.length, needle.length);
      score = 0.5 + 0.4 * ratio;
      level = 'contains';
    } else if (needle.includes(name) && name.length >= 2) {
      // 反方向包含：用户说得比品名长（「巨无霸不要酸黄瓜」vs「巨无霸」）。
      // 实测踩过的坑：菜单里有单字品名「派」，用户说「仰望星空派」时会被反向命中。
      // 因此要求品名至少占查询长度的一半，否则不当作命中。
      const ratio = name.length / needle.length;
      if (ratio < REVERSE_CONTAINS_MIN_RATIO) {
        // 交给下面的 fuzzy 兜底
        const fuzzy = scoreFuzzy(name, needle, item.tags);
        if (fuzzy === undefined) return undefined;
        score = fuzzy.score;
        level = 'fuzzy';
      } else {
        score = 0.5 + 0.4 * ratio;
        level = 'contains';
      }
    } else {
      const fuzzy = scoreFuzzy(name, needle, item.tags);
      if (fuzzy === undefined) return undefined;
      score = fuzzy.score;
      level = 'fuzzy';
    }
  }

  score += preferenceBonus(name, options);
  score += tagBonus(needle, item.tags);

  return { item, score: clamp(score, 0, 1), level };
}

/**
 * 兜底的模糊分：二元组相似度 + 子序列命中，最后再试标签。
 * 返回 undefined 表示这个候选完全跟不上，直接丢弃。
 */
function scoreFuzzy(
  name: string,
  needle: string,
  tags: readonly string[] | undefined,
): { score: number } | undefined {
  const similarity = diceCoefficient(name, needle);
  const subsequence = isSubsequence(needle, name) || isSubsequence(name, needle);
  const raw = Math.max(similarity, subsequence ? 0.5 : 0);
  if (raw > 0) return { score: raw * 0.7 };

  const tagScore = scoreTags(needle, tags);
  if (tagScore <= 0) return undefined;
  return { score: tagScore };
}

/** 别名命中。别名是全字匹配，所以给到仅次于精确分的水平 */
function scoreAliases(needle: string, aliases: readonly string[] | undefined): number {
  if (!aliases || aliases.length === 0) return 0;
  let best = 0;
  for (const alias of aliases) {
    const folded = normalizeCompact(alias);
    if (!folded) continue;
    if (folded === needle) return 0.95;
    if (folded.includes(needle) && needle.length >= 2) {
      const ratio = needle.length / folded.length;
      best = Math.max(best, 0.6 + 0.3 * ratio);
    }
  }
  return best;
}

/** 标签（如「人气产品」「早餐卡专享价」）给一点点加分，不足以逆转主判断 */
function tagBonus(needle: string, tags: readonly string[] | undefined): number {
  if (!tags) return 0;
  for (const tag of tags) {
    if (normalizeCompact(tag) === needle) return 0.03;
  }
  return 0;
}

function scoreTags(needle: string, tags: readonly string[] | undefined): number {
  if (!tags) return 0;
  for (const tag of tags) {
    const folded = normalizeCompact(tag);
    if (folded === needle) return 0.5;
    if (folded.includes(needle) && needle.length >= 2) return 0.42;
  }
  return 0;
}

/**
 * 套餐 / 单品 偏好加权（FR-9）。
 * 幅度刻意压得很小：它只在「用户明确说了套餐或单点」时打破平局，
 * 不会把「巨无霸」硬推给「巨无霸套餐」。
 */
function preferenceBonus(name: string, options: MatchOptions): number {
  const isCombo = COMBO_NAME_PATTERN.test(name);
  if (options.prefer === 'single') return isCombo ? -0.08 : 0.04;
  if (options.prefer === 'combo') return isCombo ? 0.06 : 0;
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ─────────────────────────────────────────────────────────────
// 把领域对象转成可匹配候选
// ─────────────────────────────────────────────────────────────

/** 把任意带 name 的对象变成候选。别名由调用方附加。 */
export function toCandidate(
  source: { code: string; name: string; tags?: readonly string[] },
  aliases?: readonly string[],
): MatchCandidate {
  return {
    id: source.code,
    name: source.name,
    tags: source.tags,
    aliases,
  };
}

/** 反向包含时，品名至少要占查询的一半长度才算命中 */
const REVERSE_CONTAINS_MIN_RATIO = 0.5;

/**
 * 菜单感知的「品名 + 特制」切分。
 *
 * 为什么不靠关键词切：真实菜单里「巨无霸」含「无」、「酥酥多笋卷」含「多」，
 * 任何关键词黑名单都会误伤品名。这里的做法是**用菜单自身来验证切分点**：
 * 从最长前缀开始逐步缩短，哪个前缀能在菜单里稳定命中，剩下那段就是特制。
 *
 * @example resolveItemText('巨无霸不要酸黄瓜', items) → { 品名: 巨无霸, 特制: '不要酸黄瓜' }
 */
export interface ItemTextResolution<T> {
  readonly outcome: MatchOutcome<T>;
  /** 从文本尾部切出的特制说明；没切到则为 undefined */
  readonly specText?: string;
}

export function resolveItemText<T extends MatchCandidate>(
  text: string,
  items: readonly T[],
  options: MatchOptions = {},
): ItemTextResolution<T> {
  const cleaned = trimSpecNoise(text);
  const direct = pickOne(cleaned, items, options);
  if (direct.status !== 'miss') return { outcome: direct };

  // 从最长前缀开始试探，但**只接受强命中**（精确 / 别名）。
  // 如果这里放宽到「包含」，「巨无霸不要酸黄瓜」会在 head=「巨无霸不要酸」时就命中，
  // 剩下的特制被切成「黄瓜」—— 这是实测出来的失败样例。
  let looseHit: { cut: number; tail: string } | undefined;

  for (let cut = cleaned.length - 2; cut >= 2; cut -= 1) {
    const head = trimSpecNoise(cleaned.slice(0, cut));
    const tail = cleaned.slice(cut).trim();
    if (!head || tail.length < 2) continue;

    const headOutcome = pickOne(head, items, options);
    if (headOutcome.status === 'miss') continue;

    const level = headOutcome.best?.level;
    if (level === 'exact' || level === 'alias') {
      return { outcome: headOutcome, specText: tail };
    }
    // 弱命中先记下来（取最长的），全部试完没有强命中时再用
    if (!looseHit) looseHit = { cut, tail };
  }

  if (looseHit) {
    const outcome = pickOne(trimSpecNoise(cleaned.slice(0, looseHit.cut)), items, options);
    return { outcome, specText: looseHit.tail };
  }

  return { outcome: direct };
}

function trimSpecNoise(text: string): string {
  return text.trim().replace(/[\s,，、]+$/, '');
}

/** 给同级排序用：名称短的排前面（更可能是用户想说的那个） */
export function compareByNameLength(a: MatchCandidate, b: MatchCandidate): number {
  return a.name.length - b.name.length;
}
