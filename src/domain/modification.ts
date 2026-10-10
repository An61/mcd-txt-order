/**
 * 「特制」翻译器 —— 把「不要酸黄瓜」变成服务端认得的 `modification.values[]`。
 *
 * ⚠️ 实测依据（2026-10-10，见 SPEC 6.3）：
 * `calculate-price` 对四种候选写法**全部返回 success 且响应体完全一致、不回显 modification**，
 * 也就是说**服务端侧无法验证特制是否真的生效**。
 *
 * 因此这里做的是**工程上的明确取舍**：采用语义最清晰的写法
 * `values:[{ code, key: <该项的 unselectedKey>, quantity: 0 }]`（即"取消该项"）。
 * 若将来发现服务端判定规则不同，改动只需落在本文件。
 */

import type { MealDetail, ModificationOption, ModificationValue } from './types.ts';

export type SpecAction = 'remove' | 'add' | 'less' | 'more';

export interface SpecIntent {
  readonly action: SpecAction;
  /** 用户提到的对象，如「酸黄瓜」 */
  readonly target: string;
  /** 原始短语，如「不要酸黄瓜」 */
  readonly phrase: string;
}

const ACTION_KEYWORDS: readonly { action: SpecAction; words: readonly string[] }[] = [
  { action: 'remove', words: ['不要', '不加', '不用', '去掉', '去', '免', '无'] },
  { action: 'add', words: ['多加', '加', '多放'] },
  { action: 'less', words: ['少', '少放', '微'] },
  { action: 'more', words: ['重', '重口'] },
];

/**
 * 解析「不要酸黄瓜、少 ice」这类短语。
 * 支持顿号/逗号/空格分隔的多个诉求。
 */
export function parseSpecPhrases(specText: string): SpecIntent[] {
  if (!specText || !specText.trim()) return [];

  return specText
    .split(/[\s,，、;；]+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map(parseSinglePhrase)
    .filter((intent): intent is SpecIntent => intent !== undefined);
}

function parseSinglePhrase(phrase: string): SpecIntent | undefined {
  for (const entry of ACTION_KEYWORDS) {
    for (const word of entry.words) {
      if (!phrase.startsWith(word)) continue;
      const target = phrase.slice(word.length).trim();
      if (!target) return undefined;
      return { action: entry.action, target, phrase };
    }
  }
  return undefined;
}

export interface BuildModificationResult {
  readonly values: ModificationValue[];
  /** 没能对上的诉求，需要如实告诉用户（不能假装成功） */
  readonly unmatched: string[];
  /** 命中的友好描述，如「不要酸黄瓜」 */
  readonly applied: string[];
}

/**
 * 对照 `query-meal-detail` 给出的真实选项，生成服务端入参。
 *
 * 没有匹配到时**刻意返回空 values + 非空 unmatched**：宁可在预览卡片里告诉用户
 * 「这一项没找到」，也不要悄悄忽略、让人吃到不想吃的东西。
 */
export function buildModification(
  detail: MealDetail,
  specText: string | undefined,
): BuildModificationResult {
  if (!specText || !specText.trim()) return { values: [], unmatched: [], applied: [] };

  const intents = parseSpecPhrases(specText);
  const values: ModificationValue[] = [];
  const applied: string[] = [];
  const unmatched: string[] = [];

  for (const intent of intents) {
    const option = findOption(detail, intent.target);
    if (!option) {
      unmatched.push(intent.phrase);
      continue;
    }

    if (intent.action === 'remove') {
      values.push({ code: option.code, key: option.unselectedKey, quantity: 0 });
      applied.push(`不要${option.name}`);
      continue;
    }

    if (intent.action === 'less') {
      // 「少冰」这类没有 0/1 语义，退化为保留默认但要如实标注
      applied.push(`少${option.name}（以门店出餐为准）`);
      continue;
    }

    if (intent.action === 'add' || intent.action === 'more') {
      const quantity = Math.min(option.maxQuantity, Math.max(1, option.selectedQuantity + 1));
      values.push({ code: option.code, key: option.selectedKey, quantity });
      applied.push(`多加${option.name}`);
    }
  }

  return { values, unmatched, applied };
}

/** 在详情里按名字找选项：完全相等优先，其次包含 */
export function findOption(detail: MealDetail, target: string): ModificationOption | undefined {
  const key = target.replace(/\s+/g, '');
  if (!key) return undefined;

  for (const group of detail.groups) {
    for (const option of group.options) {
      if (option.name === target) return option;
    }
  }
  for (const group of detail.groups) {
    for (const option of group.options) {
      if (option.name.includes(key) || key.includes(option.name)) return option;
    }
  }
  return undefined;
}

/** 预览卡片里的特制文案汇总 */
export function describeModification(applied: readonly string[], unmatched: readonly string[]): string {
  if (applied.length === 0 && unmatched.length === 0) return '无';
  const parts = [...applied];
  if (unmatched.length > 0) parts.push(`⚠️ 未识别：${unmatched.join('、')}`);
  return parts.join('；');
}
