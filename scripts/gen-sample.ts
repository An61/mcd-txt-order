/**
 * 生成离线示例数据集 `src/data/sample.ts`。
 *
 * 数据源来自**真实 MCP 探针产出的快照**（`.cache/probe/`，已 gitignore）。
 * 这样做的好处：没 Token 的评审者 clone 下来，`npm run demo` 里
 * 「巨无霸 香梅北」命中的是**真实门店与真实价格**，而不是手编的假数据。
 *
 * 用法：node --experimental-strip-types scripts/gen-sample.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findProjectRoot } from '../src/env.ts';

const ROOT = findProjectRoot();
const PROBE = resolve(ROOT, '.cache', 'probe');

interface RawMeal {
  name: string;
  image?: string;
  currentPrice?: string;
  originalPrice?: string;
  canWithOrder?: boolean;
}

interface RawCategory {
  name: string;
  meals: { code: string; tags?: string[] }[];
}

function readJson<T>(file: string): T {
  const path = resolve(PROBE, file);
  if (!existsSync(path)) throw new Error(`缺少探针快照：${file}（请先运行 scripts/probe-order-chain2.ts）`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

async function main(): Promise<void> {
  const menuPayload = readJson<{ data: { categories: RawCategory[]; meals: Record<string, RawMeal> } }>(
    'chain2-meals-reserved-lunch.json',
  );
  const storePayload = readJson<{
    data: {
      storeCode: string;
      storeName: string;
      address: string;
      distance: number;
      businessStatus: boolean;
      businessStartTime: string;
      businessEndTime: string;
    }[];
  }>('chain-stores-keyword-location.json');
  const detailPayload = readJson<{ data: Record<string, unknown> }>('chain2-detail-reserved-lunch.json');

  const dict = menuPayload.data.meals;
  const categories = menuPayload.data.categories;

  // code → { tags, categories }
  const tagsByCode = new Map<string, Set<string>>();
  const catsByCode = new Map<string, string[]>();
  for (const category of categories) {
    for (const entry of category.meals ?? []) {
      const tags = tagsByCode.get(entry.code) ?? new Set<string>();
      for (const tag of entry.tags ?? []) tags.add(tag);
      tagsByCode.set(entry.code, tags);
      catsByCode.set(entry.code, [...(catsByCode.get(entry.code) ?? []), category.name]);
    }
  }

  const itemLines: string[] = [];
  for (const [code, meal] of Object.entries(dict)) {
    const tags = [...(tagsByCode.get(code) ?? [])];
    const cats = catsByCode.get(code) ?? [];
    itemLines.push(
      `  { code: '${code}', name: '${escapeString(meal.name)}', yuan: '${meal.currentPrice ?? ''}', ` +
        `originalYuan: '${meal.originalPrice ?? meal.currentPrice ?? ''}', ` +
        `tags: [${tags.map((t) => `'${escapeString(t)}'`).join(', ')}], ` +
        `cats: [${cats.map((c) => `'${escapeString(c)}'`).join(', ')}], ` +
        `canWithOrder: ${meal.canWithOrder === true} },`,
    );
  }

  const categoryLines = categories.map((category) => {
    const codes = (category.meals ?? []).map((entry) => `'${entry.code}'`).join(', ');
    return `  { name: '${escapeString(category.name)}', codes: [${codes}] },`;
  });

  const storeLines = storePayload.data.slice(0, 8).map((store) => {
    return (
      `  { code: '${store.storeCode}', name: '${escapeString(store.storeName)}', ` +
      `address: '${escapeString(store.address)}', distance: ${store.distance}, ` +
      `city: '深圳', open: ${store.businessStatus === true}, ` +
      `openTime: '${store.businessStartTime}', closeTime: '${store.businessEndTime}' },`
    );
  });

  const detailJson = JSON.stringify(detailPayload.data, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');

  const content = `/**
 * 内置示例数据 —— **仅供离线演示**（T9）。
 *
 * ⚠️ 重要说明：
 * 1. 本文件数据是从麦当劳 MCP **真实探针快照**生成的（门店、菜单、价格均来自真实响应），
 *    但它是某一时刻的**快照**，已经可能过时，**不代表当前营业状态与实时价格**。
 * 2. 它不是官方发布的数据源。真实使用时一律以 \`query-meals\` 与 \`query-nearby-stores\`
 *    的实时返回为准，本文件仅服务于「没有 Token 也能跑通演示」这一个目的。
 * 3. **不含任何凭据**（无 Token、无配送地址、无账号信息），可安全随仓库分发。
 *
 * 用途：没有 MCP Token 时，\`npm run demo\` 依然能完整走完
 * 「输入 → 门店命中 → 菜单匹配 → 预览 → 确认 → 支付链接（示例）」的链路，
 * 让评审者 clone 下来就能玩。
 *
 * 本文件由 \`scripts/gen-sample.ts\` 生成，**请勿手工编辑**。
 * 生成时间：${new Date().toISOString()}
 */

// 注意：本脚本位于 scripts/（不是 src/scripts/），相对路径必须带 src/。
// 曾写成 '../domain/...'，在大小写敏感的文件系统（Linux/CI）上会直接 ENOENT；
// Windows 不区分大小写且曾能从旧位置解析，所以一直没暴露。
import { hasPrice, yuanToCents, type Menu, type MenuCategory, type MenuItem, type Store } from '../src/domain/types.ts';
import { parseMealDetail } from '../src/mcp/normalize.ts';
import type { ParseNutritionResult } from '../src/mcp/nutrition.ts';

// ─────────────────────────────────────────────────────────────
// 门店
// ─────────────────────────────────────────────────────────────

export interface SampleStoreRow {
  readonly code: string;
  readonly name: string;
  readonly address: string;
  readonly distance: number;
  readonly city: string;
  readonly open: boolean;
  readonly openTime: string;
  readonly closeTime: string;
}

const SAMPLE_STORE_ROWS: readonly SampleStoreRow[] = [
${storeLines.join('\n')}
];

export const SAMPLE_STORES: readonly Store[] = SAMPLE_STORE_ROWS.map((row) => ({
  code: row.code,
  name: row.name,
  address: row.address,
  distanceMeters: row.distance,
  city: row.city,
  open: row.open,
  businessStartTime: row.openTime,
  businessEndTime: row.closeTime,
  supportsReservation: true,
}));

/** 演示默认门店：与 config/favorites.example.json 里的「福田香梅北」对应 */
export const SAMPLE_DEFAULT_STORE_CODE = '${storePayload.data[0]?.storeCode ?? ''}';

// ─────────────────────────────────────────────────────────────
// 菜单
// ─────────────────────────────────────────────────────────────

interface SampleItemRow {
  readonly code: string;
  readonly name: string;
  /** 「元」的字符串，与 \`query-meals\` 的原始形态保持一致 */
  readonly yuan: string;
  readonly originalYuan: string;
  readonly tags: readonly string[];
  readonly cats: readonly string[];
  readonly canWithOrder: boolean;
}

const SAMPLE_ITEM_ROWS: readonly SampleItemRow[] = [
${itemLines.join('\n')}
];

const SAMPLE_CATEGORY_ROWS: readonly MenuCategory[] = [
${categoryLines.join('\n')}
];

function toMenuItem(row: SampleItemRow): MenuItem {
  return {
    code: row.code,
    name: row.name,
    priceCents: yuanToCents(row.yuan),
    originalPriceCents: yuanToCents(row.originalYuan),
    tags: row.tags,
    categories: row.cats,
    canWithOrder: row.canWithOrder,
  };
}

const SAMPLE_ITEMS: readonly MenuItem[] = SAMPLE_ITEM_ROWS.map(toMenuItem);

export const SAMPLE_MENU: Menu = {
  storeCode: SAMPLE_DEFAULT_STORE_CODE,
  categories: SAMPLE_CATEGORY_ROWS,
  items: SAMPLE_ITEMS,
};

/** 只有拿到价格的那部分才是可下单的，避免把「价格未知」的商品卖给用户 */
export const SAMPLE_ORDERABLE_ITEMS: readonly MenuItem[] = SAMPLE_ITEMS.filter(hasPrice);

// ─────────────────────────────────────────────────────────────
// 餐品详情（含「不要酸黄瓜」所需的真实特制 code）
// ─────────────────────────────────────────────────────────────

/** 巨无霸的详情原文，取真实 \`query-meal-detail\` 响应 */
export const SAMPLE_MEAL_DETAIL_RAW: Record<string, unknown> = ${detailJson};

export const SAMPLE_MEAL_DETAIL_CODE = String(SAMPLE_MEAL_DETAIL_RAW.code ?? '');

/** 注意要包一层信封 —— normalize 的 readEnvelope 期待完整的 { success, data } 结构 */
export const SAMPLE_MEAL_DETAIL = parseMealDetail({
  success: true,
  code: 200,
  message: '离线快照',
  data: SAMPLE_MEAL_DETAIL_RAW,
});

// ─────────────────────────────────────────────────────────────
// 取餐方式（实测到店场景的两项）
// ─────────────────────────────────────────────────────────────

export const SAMPLE_TAKE_WAYS = [
  { code: 'eat-in', title: '堂食', subtitle: '店内用餐' },
  { code: 'take-in-store', title: '外带', subtitle: '店内自提' },
] as const;

/** 演示模式下产出的支付链接，明确标注不是真实地址 */
export const SAMPLE_PAY_URL = 'https://example.invalid/mock-pay/demo-order-0001';

/** 演示模式下的示例订单号 */
export const SAMPLE_ORDER_ID = 'DEMO-ORDER-0001';

/** 占位：营养数据在离线演示下不加载 */
export const SAMPLE_NUTRITION: ParseNutritionResult = { records: [], skipped: 0, declaredTotal: 0 };
`;

  const target = resolve(ROOT, 'src', 'data', 'sample.ts');
  writeFileSync(target, content, 'utf8');
  console.log(`已生成 ${target}`);
  console.log(`  门店 ${SAMPLE_STORE_COUNT} 家，菜单 ${Object.keys(dict).length} 条，分类 ${categories.length} 个`);
  console.log('  以上计数变量仅为日志占位，实际内容已写入文件。');
}

const SAMPLE_STORE_COUNT = 8;

main().catch((error: unknown) => {
  console.error('生成失败：', error);
  process.exitCode = 1;
});
