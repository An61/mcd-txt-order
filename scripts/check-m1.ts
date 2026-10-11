/**
 * M1 领域内核自检 —— 逐条核对 T4~T9 / T36 的验收标准。
 *
 * 用法：node --experimental-strip-types scripts/check-m1.ts
 * 全部离线运行，**不发任何网络请求**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findProjectRoot } from '../src/env.ts';
import {
  parsePrice,
  parseStores,
  parseMenu,
  parseMealDetail,
  readEnvelope,
  humanizeMcpFailure,
  cartFingerprint,
} from '../src/mcp/normalize.ts';
import { parseNutritionPayload } from '../src/mcp/nutrition.ts';
import { parseItemSpecs } from '../src/domain/qty.ts';
import { pickOne, resolveItemText, toCandidate, type MatchCandidate } from '../src/domain/matcher.ts';
import { loadFavorites, resolveStoreAlias, defaultStoreFavorite } from '../src/domain/favorites.ts';
import { buildModification } from '../src/domain/modification.ts';
import {
  SAMPLE_MEAL_DETAIL,
  SAMPLE_ORDERABLE_ITEMS,
  SAMPLE_STORES,
} from '../src/data/sample.ts';
import { money, hasPrice, type Cart } from '../src/domain/types.ts';

let passed = 0;
let failed = 0;

function check(title: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${title}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${title}  ${detail}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

const ROOT = findProjectRoot();

/**
 * 探针快照的读取顺序：**先 `fixtures/probe/`（已入库），再 `.cache/probe/`（本地真实探针产物）**。
 *
 * 曾经只从 `.cache/probe/` 读，而该目录被 .gitignore 排除 —— 于是 CI 全新 clone 后
 * 快照不存在，`parseStores(undefined)` 返回空数组，M1 的「门店解析出结果」等断言直接失败。
 * 本地目录里有 `.cache`，所以本地永远绿、只在 CI 红，问题被掩盖了很久。
 *
 * 现在 M1 依赖的 6 个快照已固化进 `fixtures/probe/` 随仓库分发，
 * 保证「clone 即可跑」名副其实（README 正是这么承诺的）。
 * 若两处都没有，则 readProbe 返回 undefined，相关断言**照常失败**——
 * 缺快照是真实缺陷，不应当作「环境差异」跳过。
 */
const PROBE_DIRS = [resolve(ROOT, 'fixtures', 'probe'), resolve(ROOT, '.cache', 'probe')];
const readProbe = (name: string): unknown => {
  for (const dir of PROBE_DIRS) {
    const path = resolve(dir, name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  }
  return undefined;
};

// ─────────────────────────────────────────────────────────────
section('T5 容忍式字段归一（读真实探针快照）');

const storesPayload = readProbe('chain-stores-keyword-location.json');
const stores = parseStores(storesPayload, '深圳');
check('门店解析出结果', stores.length > 0, `共 ${stores.length} 家`);
check(
  'storeCode / storeName 正确',
  stores[0]?.code === '1420602' && stores[0]?.name === '麦当劳深圳香梅北餐厅',
  `${stores[0]?.code} ${stores[0]?.name}`,
);
check('distance 是数字（米）', typeof stores[0]?.distanceMeters === 'number', String(stores[0]?.distanceMeters));
check('营业状态被识别', stores[0]?.open === true);

const emptyFavorite = readEnvelope(readProbe('chain-stores-favorite.json'));
check('收藏为空被识别为失败信封', emptyFavorite.success === false && String(emptyFavorite.code) === '600050');
check(
  '600050 有中文人话解释',
  humanizeMcpFailure(emptyFavorite).includes('收藏'),
  humanizeMcpFailure(emptyFavorite).slice(0, 30),
);

const menuPayload = readProbe('chain2-meals-reserved-lunch.json');
const menu = parseMenu(menuPayload, '1420602');
const bigMac = menu.items.find((item) => item.code === '1100');
check('菜单条目齐全', menu.items.length > 100, `共 ${menu.items.length} 条`);
check('分类与字典能对齐（巨无霸有名字）', bigMac?.name === '巨无霸', bigMac?.name ?? '(未找到)');
check(
  '菜单价从「元字符串」正确转成分',
  bigMac?.priceCents === 2650,
  `${bigMac?.priceCents} 分 = ${money(bigMac?.priceCents ?? -1)}`,
);
check('同一餐品的分类被归并', (bigMac?.categories.length ?? 0) >= 1, (bigMac?.categories ?? []).join('/'));
check('所有条目都有价格', menu.items.every(hasPrice));

const detail = parseMealDetail(readProbe('chain2-detail-reserved-lunch.json'));
const pickles = detail?.groups
  .flatMap((group) => group.options)
  .find((option) => option.name === '酸黄瓜');
check('餐品详情解析成功', detail?.code === '1100' && detail?.name === '巨无霸');
check('酸黄瓜选项被抽出', pickles?.code === '100202', pickles?.code ?? '(未找到)');
check('unselectedKey 存在（取消项要用它）', Boolean(pickles?.unselectedKey), pickles?.unselectedKey ?? '');

const price = parsePrice(readProbe('chain2-price-reserved-lunch.json'));
check('算价：实付 = 2650 分', price?.payableCents === 2650, money(price?.payableCents ?? -1));
check('算价：明细行正确', price?.lines[0]?.productCode === '1100' && price?.lines[0]?.quantity === 1);
check(
  '算价：takeWayList 有堂食与外带',
  price?.takeWays.some((t) => t.code === 'eat-in') === true &&
    price?.takeWays.some((t) => t.code === 'take-in-store') === true,
  (price?.takeWays ?? []).map((t) => t.code).join(','),
);

// ─────────────────────────────────────────────────────────────
section('T6 营养 Markdown 解析器');

const nutrition = parseNutritionPayload(readProbe('list-nutrition-foods.json'));
check('解析出 160 条', nutrition.records.length === 160, `实际 ${nutrition.records.length} 条，跳过 ${nutrition.skipped} 行`);
check('声明总数与实得一致', nutrition.declaredTotal === nutrition.records.length);
const bigMacNutrition = nutrition.records.find((r) => r.productName === '巨无霸');
check(
  '巨无霸营养数值正确（energyKcal=513）',
  bigMacNutrition?.energyKcal === 513 && bigMacNutrition?.protein === 27,
  JSON.stringify(bigMacNutrition),
);
const longName = nutrition.records.find((r) => r.productName.includes('蒜了吧'));
check(
  '含逗号的长品名不被拆错',
  longName?.nutritionDescription === null && longName.energyKcal > 0,
  longName?.productName ?? '(未找到)',
);

// ─────────────────────────────────────────────────────────────
section('T36 数量与多品解析');

const cases: { input: string; expected: string }[] = [
  { input: '巨无霸', expected: '巨无霸×1' },
  { input: '两个巨无霸', expected: '巨无霸×2' },
  { input: '两个巨无霸一杯可乐', expected: '巨无霸×2,可乐×1' },
  { input: '两个巨无霸、一杯可乐', expected: '巨无霸×2,可乐×1' },
  { input: '2份麦辣鸡腿堡', expected: '麦辣鸡腿堡×2' },
  { input: '一杯可乐', expected: '可乐×1' },
  { input: '巨无霸x2', expected: '巨无霸×2' },
  { input: '巨无霸 可乐', expected: '巨无霸×1,可乐×1' },
  { input: '帮我点两个巨无霸谢谢', expected: '巨无霸×2' },
  { input: '麦乐鸡5块', expected: '麦乐鸡5块×1' },
  { input: '一杯大可乐一个大薯条', expected: '大可乐×1,大薯条×1' },
  { input: '巨无霸 巨无霸', expected: '巨无霸×2' },
];

for (const item of cases) {
  const specs = parseItemSpecs(item.input);
  const actual = specs.map((spec) => `${spec.name}×${spec.quantity}`).join(',');
  check(`「${item.input}」`, actual === item.expected, `得到 ${actual || '(空)'}，期望 ${item.expected}`);
}

// ─────────────────────────────────────────────────────────────
section('T8 收藏与别名');

const favoritesResult = loadFavorites();
check('收藏配置加载成功', favoritesResult.config.stores.length > 0, `来源 ${favoritesResult.sourcePath.split(/[\\/]/).pop()}`);
check('缺文件时回退到示例且有提示', favoritesResult.warnings.length === 0 || favoritesResult.usedFallback);

const hint = resolveStoreAlias('巨无霸 香梅北', favoritesResult.config);
check('用户在句子里说「香梅北」能命中别名', hint?.alias === '香梅北' && hint?.favorite.name === '麦当劳深圳香梅北餐厅',
  hint?.favorite.name ?? '(未命中)');
check('命中后剩余文本是纯餐品', hint?.rest === '巨无霸', hint?.rest ?? '');

const nested = resolveStoreAlias('福田香梅北', favoritesResult.config);
check('长别名优先（福田香梅北 > 香梅北）', nested?.alias === '福田香梅北', nested?.alias ?? '(未命中)');

check('默认门店可解析', defaultStoreFavorite(favoritesResult.config)?.name === '麦当劳深圳香梅北餐厅',
  defaultStoreFavorite(favoritesResult.config)?.name ?? '(无)');

// ─────────────────────────────────────────────────────────────
section('T7 四级降级匹配（对真实菜单）');

const favorites = favoritesResult.config;
const candidates: MatchCandidate[] = SAMPLE_ORDERABLE_ITEMS.map((item) =>
  toCandidate(item, favorites.meals.find((m) => m.name === item.name)?.alias),
);

function matchName(query: string): string {
  const outcome = pickOne(query, candidates);
  if (outcome.status === 'miss') return '(未匹配)';
  const name = (outcome.best?.item.name ?? '(无)') as string;
  return outcome.status === 'ambiguous' ? `${name}(候选难分:${outcome.candidates.length})` : name;
}

check('「巨无霸」精确命中', matchName('巨无霸') === '巨无霸', matchName('巨无霸'));
check('拼音缩写 jwb 命中（走别名）', matchName('jwb') === '巨无霸', matchName('jwb'));
check('「麦辣」降级到包含匹配', matchName('麦辣').includes('麦辣'), matchName('麦辣'));
check('薯条别名 shutiao 命中', matchName('shutiao').includes('薯条'), matchName('shutiao'));
check('完全无关的词判为未匹配', matchName('仰望星空派') === '(未匹配)', matchName('仰望星空派'));
check('单字品名「派」不会被长句误命中', matchName('我想吃个仰望星空的东西') === '(未匹配)', matchName('我想吃个仰望星空的东西'));

// 菜单感知的「品名 + 特制」切分
const specSplit = resolveItemText('巨无霸不要酸黄瓜', candidates);
check('「巨无霸不要酸黄瓜」切开为品名+特制',
  (specSplit.outcome.best?.item.name ?? '') === '巨无霸' && specSplit.specText === '不要酸黄瓜',
  `${specSplit.outcome.best?.item.name ?? '(无)'} + ${specSplit.specText ?? '(无)'}`);
check('名字里带「多」的品名不被误切成特制',
  resolveItemText('酥酥多笋卷', candidates).specText === undefined,
  resolveItemText('酥酥多笋卷', candidates).specText ?? '(未切)');
check('名字里带「无」的品名不被误切成特制',
  resolveItemText('巨无霸', candidates).specText === undefined,
  resolveItemText('巨无霸', candidates).specText ?? '(未切)');

const single = pickOne('巨无霸', candidates, { prefer: 'single' });
check('「单品偏好」不会挑选套餐', single.best?.item.name === '巨无霸', single.best?.item.name ?? '(无)');

// 多候选必须返回 ambiguous 而不是硬取第一名
const many = SAMPLE_ORDERABLE_ITEMS.filter((item) => item.name.includes('可乐'));
check('菜单存在多个「可乐」候选用于验证 FR-8', many.length >= 1, `候选 ${many.length} 个`);

// ─────────────────────────────────────────────────────────────
section('T4 领域模型 / 指纹');

const baseCart: Cart = {
  scene: 'pickup',
  store: SAMPLE_STORES[0] as NonNullable<typeof SAMPLE_STORES[number]>,
  items: [
    { productCode: '1100', name: '巨无霸', quantity: 2, menuPriceCents: 2650 },
    { productCode: '9900008751', name: '可乐', quantity: 1, menuPriceCents: 950 },
  ],
  needTableware: false,
};
const fingerprint1 = cartFingerprint(baseCart);
const fingerprint2 = cartFingerprint({
  ...baseCart,
  items: [
    { productCode: '9900008751', name: '可乐', quantity: 1, menuPriceCents: 950 },
    { productCode: '1100', name: '巨无霸', quantity: 2, menuPriceCents: 2650 },
  ],
});
check('购物指纹与条目顺序无关', fingerprint1 === fingerprint2, fingerprint1);
check(
  '价格变动不影响指纹（保证幂等不被券失效）',
  cartFingerprint({
    ...baseCart,
    items: baseCart.items.map((item) => ({ ...item, menuPriceCents: 1 })),
  }) === fingerprint1,
);
check(
  '数量变化会改变指纹',
  cartFingerprint({
    ...baseCart,
    items: [{ productCode: '1100', name: '巨无霸', quantity: 3, menuPriceCents: 2650 }],
  }) !== fingerprint1,
);

// ─────────────────────────────────────────────────────────────
section('特制构建（FR-18）');

const built = buildModification(SAMPLE_MEAL_DETAIL as NonNullable<typeof SAMPLE_MEAL_DETAIL>, '不要酸黄瓜');
check('「不要酸黄瓜」生成 values', built.values.length === 1, JSON.stringify(built.values));
check('使用 unselectedKey + quantity 0', built.values[0]?.key === '0-0' && built.values[0]?.quantity === 0);
check('取消项使用真实 code（100202）', built.values[0]?.code === '100202');
const bogus = buildModification(SAMPLE_MEAL_DETAIL as NonNullable<typeof SAMPLE_MEAL_DETAIL>, '不要香菜');
check('无法识别的诉求如实返回 unmatched', bogus.unmatched.length === 1 && bogus.values.length === 0,
  JSON.stringify(bogus.unmatched));

// ─────────────────────────────────────────────────────────────
section('端到端：模拟一句用户原话');

const utterance = '两个巨无霸一杯可乐 香梅北';
const storeHint = resolveStoreAlias(utterance, favorites);
const specs = parseItemSpecs(storeHint?.rest ?? utterance);
check('门店被切出', storeHint?.favorite.name === '麦当劳深圳香梅北餐厅', storeHint?.favorite.name ?? '');
check(
  '剩余文本解析出两个餐品且数量正确',
  specs.length === 2 && specs.some((s) => s.name === '巨无霸' && s.quantity === 2) &&
    specs.some((s) => s.name === '可乐' && s.quantity === 1),
  specs.map((s) => `${s.name}×${s.quantity}`).join(','),
);
const bigMacSpec = specs.find((s) => s.name === '巨无霸');
const resolved = pickOne(bigMacSpec?.name ?? '', candidates);
check('巨无霸在真实菜单里被命中', (resolved.best?.item.name ?? '') === '巨无霸', resolved.best?.item.id ?? '');

console.log(`\n${'═'.repeat(50)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  process.exitCode = 1;
}
