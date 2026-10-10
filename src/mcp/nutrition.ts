/**
 * 营养数据解析器。
 *
 * 背景：`list-nutrition-foods` 这个工具的返回值不是一个结构化数组，
 * 而是**一整段 Markdown 字符串**（实测 160 条），长这样：
 *
 * ```
 * [160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:
 *   猪柳麦满分,null,1288,308,16,16,24,781,213
 *   中薯条,null,1210,289,4,12,38,165,18
 * ```
 *
 * 要点：
 * 1. 首行是 `[总数]{字段列表}:`，字段名顺序必须从这里读，**不能写死**，否则服务端加字段就串位。
 * 2. 数据行行首有两个空格。
 * 3. `nutritionDescription` 实测恒为 `null`。
 * 4. 品名里可能含逗号（如「蒜了吧黄油风味薄皮脆汁鸡-琵琶腿」），
 *    所以**不能无脑按逗号切分** —— 做法是从右侧倒推数值字段，剩下的整体作为品名。
 */

import type { NutritionRecord } from '../domain/types.ts';

export interface ParseNutritionResult {
  readonly records: NutritionRecord[];
  /** 跳过（解析失败）的行数，用于观察服务端格式是否变了 */
  readonly skipped: number;
  /** 报文声明的总条数 */
  readonly declaredTotal: number;
}

const HEADER_RE = /^\[(\d+)\]\{([^}]*)\}\s*:?\s*$/;

/**
 * 解析 `list-nutrition-foods` 的返回内容。
 * 入参可以是 Markdown 原文，也可以是一个内含 `data` 字符串字段的对象。
 */
export function parseNutritionPayload(payload: unknown): ParseNutritionResult {
  const text = extractText(payload);
  return parseNutritionMarkdown(text);
}

export function parseNutritionMarkdown(text: string): ParseNutritionResult {
  const records: NutritionRecord[] = [];
  if (!text || !text.trim()) return { records, skipped: 0, declaredTotal: 0 };

  const lines = text.split(/\r?\n/);
  let fieldNames: string[] = [];
  let declaredTotal = 0;
  let skipped = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(HEADER_RE);
    if (header) {
      declaredTotal = Number.parseInt(header[1] ?? '0', 10) || 0;
      fieldNames = (header[2] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      continue;
    }

    if (fieldNames.length === 0) continue;

    const record = parseNutritionLine(line, fieldNames);
    if (record) records.push(record);
    else skipped += 1;
  }

  return { records, skipped, declaredTotal };
}

/**
 * 单行解析。因为品名可能包含逗号，这里按字段数**从右侧倒推**：
 * 数值字段（7 个，紧跟在品名之后）一定在最右边且不含逗号，
 * 于是左边剩下的所有内容合并成 `productName`。
 */
function parseNutritionLine(line: string, fieldNames: string[]): NutritionRecord | undefined {
  const parts = line.split(',');
  const trailingCount = fieldNames.length - 1; // 除 productName 之外的字段数
  if (parts.length < fieldNames.length) return undefined;

  const nameParts = parts.slice(0, parts.length - trailingCount);
  const valueParts = parts.slice(parts.length - trailingCount);

  const productName = nameParts.join(',').trim();
  if (!productName) return undefined;

  const values: Record<string, string> = {};
  for (let i = 0; i < valueParts.length; i += 1) {
    const key = fieldNames[i + 1];
    if (!key) continue;
    values[key] = valueParts[i]?.trim() ?? '';
  }

  const nutritionDescription = values.nutritionDescription ?? 'null';
  return {
    productName,
    nutritionDescription: nutritionDescription === 'null' || nutritionDescription === ''
      ? null
      : nutritionDescription,
    energyKj: toNumber(values.energyKj),
    energyKcal: toNumber(values.energyKcal),
    protein: toNumber(values.protein),
    fat: toNumber(values.fat),
    carbohydrate: toNumber(values.carbohydrate),
    sodium: toNumber(values.sodium),
    calcium: toNumber(values.calcium),
  };
}

function toNumber(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d.-]/g, '');
  if (!cleaned) return 0;
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 从各种形态里抠出 Markdown 文本 */
function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, unknown>;

  if (typeof obj.data === 'string') return obj.data;
  if (obj.data && typeof obj.data === 'object') {
    const nested = obj.data as Record<string, unknown>;
    for (const value of Object.values(nested)) {
      if (typeof value === 'string' && value.includes('{')) return value;
    }
  }
  for (const value of Object.values(obj)) {
    if (typeof value === 'string' && value.includes('{')) return value;
  }
  return '';
}

/**
 * 建立「品名 → 营养」索引。
 * 品名重复时保留第一条 —— 实测 160 条里无明显重名，但防御一下不会亏。
 */
export function buildNutritionIndex(records: readonly NutritionRecord[]): Map<string, NutritionRecord> {
  const index = new Map<string, NutritionRecord>();
  for (const record of records) {
    if (!index.has(record.productName)) index.set(record.productName, record);
  }
  return index;
}

/**
 * 按名称找营养数据 —— 完全相等优先，其次正向包含取最长匹配。
 *
 * 为什么不用统一模糊：营养素展示要给具体数值，
 * 宁可查不到返回 undefined，也不要把「麦辣鸡腿堡」的营养挂到「板烧鸡腿堡」上。
 */
export function lookupNutrition(
  index: ReadonlyMap<string, NutritionRecord>,
  productName: string,
): NutritionRecord | undefined {
  const exact = index.get(productName);
  if (exact) return exact;

  let best: NutritionRecord | undefined;
  let bestLength = 0;
  for (const record of index.values()) {
    if (!record.productName || !productName) continue;
    if (productName.includes(record.productName) || record.productName.includes(productName)) {
      const score = Math.min(record.productName.length, productName.length);
      if (score > bestLength) {
        bestLength = score;
        best = record;
      }
    }
  }
  return best;
}
