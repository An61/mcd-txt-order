/**
 * 下单编排（T15 / T16 / T18）。
 *
 * 链路顺序是**被服务端锁死的**，不能重排：
 *
 *   query-nearby-stores ──► query-meals ──► [需特制] query-meal-detail
 *          └────────────► calculate-price ──► 预览 + 一次性令牌 ──► [确认] create-order
 *
 * 两个硬约束（SPEC FR-16 / FR-26）：
 *   1. `takeWayCode` **只能**从 `calculate-price` 的返回里取，写死或猜一个都会失败。
 *      取不到就停在这里，绝不往下走 —— 否则会带着错误参数去创建真实订单。
 *   2. 一旦用了 `reservationDate`，后续每一步都必须传同一个值。
 *
 * 所有失败都转成**人话**（FR-19），绝不把 JSON 异常抛给用户。
 */

import type { DataGateway } from '../mcp/gateway.ts';
import { cartFingerprint } from '../mcp/normalize.ts';
import { buildModification, describeModification } from './modification.ts';
import {
  resolveItemText,
  toCandidate,
  type MatchCandidate,
} from './matcher.ts';
import { parseItemSpecs, type RawItemSpec } from './qty.ts';
import { publicErrorMessage } from '../safety/publicError.ts';
import { normalizeCompact, trimPunctuation } from './text.ts';
import {
  defaultCity as resolveDefaultCity,
  resolveStoreAlias,
  type FavoritesConfig,
} from './favorites.ts';
import {
  getScene,
  hasPrice,
  money,
  type Cart,
  type CartItem,
  type Menu,
  type MenuItem,
  type ModificationValue,
  type OrderPreview,
  type SceneKey,
  type Store,
} from './types.ts';

// ─────────────────────────────────────────────────────────────
// 结果类型
// ─────────────────────────────────────────────────────────────

export type FlowFailure =
  | 'need-store'
  | 'store-not-found'
  | 'need-item'
  | 'item-not-found'
  | 'ambiguous-item'
  | 'unsupported-scene'
  | 'gateway';

export interface PreviewResult {
  readonly ok: true;
  readonly preview: OrderPreview;
  /** 供预览卡片展示的补充信息 */
  readonly notes: readonly string[];
  readonly elapsedMs: number;
}

export interface FailureResult {
  readonly ok: false;
  readonly reason: FlowFailure;
  readonly message: string;
  /** 需要用户从候选中选一个时附上，用户可用「1 / 第一个」回答 */
  readonly candidates?: readonly string[];
}

export type FlowResult = PreviewResult | FailureResult;

export interface BuildPreviewInput {
  readonly gateway: DataGateway;
  readonly favorites: FavoritesConfig;
  readonly rawText: string;
  readonly scene?: SceneKey;
  /** 澄清态已选定 / 会话记住的门店，优先于重新解析 */
  readonly pinnedStoreCode?: string;
  /** 用户在候选中选中的官方品名。给了就不再从 rawText 里猜品名 */
  readonly pinnedItemName?: string;
  readonly reservationDate?: string;
  readonly needTableware?: boolean;
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

export async function buildPreview(input: BuildPreviewInput): Promise<FlowResult> {
  const startedAt = Date.now();
  const { gateway, favorites } = input;
  const scene = input.scene ?? favorites.rules.defaultScene ?? 'pickup';
  const notes: string[] = [];

  try {
    getScene(scene);
  } catch {
    return fail('unsupported-scene', `暂不支持的场景：${scene}`);
  }

  // ── ① 门店 ────────────────────────────────────────────────
  const storeStep = await resolveStore(input, scene);
  if (!storeStep.ok) return storeStep.result;
  const store = storeStep.store;
  if (storeStep.note) notes.push(storeStep.note);

  // ── ② 菜单 ────────────────────────────────────────────────
  let menu: Menu;
  try {
    menu = await gateway.getMenu({
      scene,
      storeCode: store.code,
      ...(input.reservationDate ? { reservationDate: input.reservationDate } : {}),
    });
  } catch (error) {
    return failureFrom(error, '拉取菜单失败');
  }

  const orderable = menu.items.filter(hasPrice);
  if (orderable.length === 0) {
    return fail('item-not-found', `「${store.name}」当前没有可点的餐品，可能已打烊。`);
  }

  // ── ③ 品名/数量/特制 ──────────────────────────────────────
  // 用户在候选中选过名字时直接用官方品名，不再从原文里猜 —— 否则"选了 2 又猜回 1"
  const specs = input.pinnedItemName
    ? parseItemSpecs(input.pinnedItemName)
    : stripStoreToken(input.rawText, store.name, favorites);
  if (specs.length === 0) {
    return fail('need-item', '想吃点什么？例如「巨无霸」「两个巨无霸一杯可乐」。');
  }

  const candidates: MatchCandidate[] = orderable.map((item) =>
    toCandidate(item, aliasFor(item, favorites)),
  );
  const itemByCode = new Map(orderable.map((item) => [item.code, item]));

  // ── ④ 逐项匹配 + 处理特制 ─────────────────────────────────
  const items: CartItem[] = [];
  for (const spec of specs) {
    // 切「品名 + 特制」必须用菜单感知的 resolveItemText：
    // 靠关键词猜会误伤「酥酥多笋卷」这类品名（实测教训）
    const resolution = resolveItemText(spec.name, candidates, { limit: 5 });
    const outcome = resolution.outcome;
    const specText = resolution.specText;

    if (outcome.status === 'miss') {
      return fail('item-not-found', `没在「${store.name}」的菜单里找到「${spec.name}」。`);
    }
    if (outcome.status === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous-item',
        message: `「${spec.name}」有几种可能，回复序号选一个：`,
        candidates: outcome.candidates.map((entry) => entry.item.name),
      };
    }

    const best = outcome.best?.item;
    const menuItem = best ? itemByCode.get(best.id) : undefined;
    if (!menuItem) {
      return fail('item-not-found', `「${spec.name}」匹配异常，请换个说法试试。`);
    }

    const modifications = await resolveSpec(input, store, menuItem, specText, scene);
    if (modifications.modNote) notes.push(modifications.modNote);

    items.push({
      productCode: menuItem.code,
      name: menuItem.name,
      quantity: spec.quantity,
      menuPriceCents: menuItem.priceCents,
      ...(modifications.values.length > 0 ? { modifications: modifications.values } : {}),
      ...(specText ? { specText } : {}),
    });
  }

  const cart: Cart = {
    scene,
    store,
    items,
    needTableware: input.needTableware ?? false,
    ...(input.reservationDate ? { reservationDate: input.reservationDate } : {}),
  };

  // ── ⑤ 算价（takeWayCode 的唯一来源）──────────────────────
  let price;
  try {
    price = await gateway.calculatePrice(cart);
  } catch (error) {
    return failureFrom(error, '算价失败，未继续下单');
  }

  const takeWay = price.takeWays[0];
  if (getScene(scene).requiresTakeWayCode && !takeWay) {
    // 拿不到取餐方式就停在这里 —— 拿猜的值去创建真实订单是拿资金冒险
    return fail('gateway', '没能取到取餐方式，已停止下单。请稍后重试。');
  }

  if (price.discountCents > 0) {
    notes.push(`已自动抵扣 ${money(price.discountCents)}`);
  }

  return {
    ok: true,
    preview: {
      cart,
      takeWay: takeWay ?? { code: '', title: '默认' },
      price,
      fingerprint: cartFingerprint(cart),
    },
    notes,
    elapsedMs: Date.now() - startedAt,
  };
}

// ─────────────────────────────────────────────────────────────
// 门店解析
// ─────────────────────────────────────────────────────────────

interface StoreStepOk {
  readonly ok: true;
  readonly store: Store;
  readonly note?: string;
}
interface StoreStepBad {
  readonly ok: false;
  readonly result: FailureResult;
}

async function resolveStore(
  input: BuildPreviewInput,
  scene: SceneKey,
): Promise<StoreStepOk | StoreStepBad> {
  const { gateway, favorites } = input;
  const hint = resolveStoreAlias(input.rawText, favorites);
  // StoreHint 把名称挂在 favorite 上（hint.favorite.name），不是 hint.name
  const city = hint?.favorite.city ?? resolveDefaultCity(favorites);
  const keyword = hint?.favorite.name ?? detectKeyword(input.rawText, favorites);

  if (!city) {
    return {
      ok: false,
      result: fail(
        'need-store',
        '还不知道你在哪个城市。请在 config/favorites.json 里配 rules.defaultCity，' +
          '或在指令里带上城市（例如「深圳 香梅北 巨无霸」）。',
      ),
    };
  }
  if (!keyword) {
    return { ok: false, result: fail('need-store', '请问是哪家门店？可以说店名，例如「香梅北」。') };
  }

  let stores: Store[];
  try {
    stores = await gateway.listStores({ scene, city, keyword });
  } catch (error) {
    return { ok: false, result: failureFrom(error, '检索门店失败') };
  }
  if (stores.length === 0) {
    return { ok: false, result: fail('store-not-found', `在 ${city} 没找到「${keyword}」附近的门店。`) };
  }

  // 实测：keyword **不会真的按名称过滤**（搜「香梅北」会返回周边一堆店），
  // 所以必须本地再匹配一次再取最像的那家。「别名的归别名，名单的归名单」。
  const wanted = hint?.favorite.name ?? keyword;
  const best =
    (input.pinnedStoreCode ? stores.find((s) => s.code === input.pinnedStoreCode) : undefined) ??
    bestStore(stores, wanted) ??
    stores[0]!;

  const note = input.pinnedStoreCode === best.code ? `已沿用上次门店：${best.name}` : undefined;
  return note ? { ok: true, store: best, note } : { ok: true, store: best };
}

function bestStore(stores: readonly Store[], wanted: string): Store | undefined {
  const needle = normalizeCompact(wanted);
  if (!needle) return undefined;
  let best: Store | undefined;
  let bestScore = 0;
  for (const store of stores) {
    const score = scoreStore(normalizeCompact(store.name), needle);
    if (score > bestScore) {
      bestScore = score;
      best = store;
    }
  }
  return bestScore > 0 ? best : undefined;
}

function scoreStore(name: string, needle: string): number {
  if (!needle) return 0;
  if (name === needle) return 3;
  if (name.includes(needle)) return 2 + Math.min(needle.length / name.length, 1);
  return 0;
}

function detectKeyword(rawText: string, favorites: FavoritesConfig): string | undefined {
  const match = rawText.match(/^([一-龥]{2,6})/);
  void favorites;
  return match?.[1];
}

/**
 * 从原文里剔掉门店部分，剩下的才是餐品。
 * `resolveStoreAlias` 已经算好了 `rest`，优先用它 —— 比自己再做一次替换准。
 */
function stripStoreToken(rawText: string, storeName: string, favorites: FavoritesConfig): RawItemSpec[] {
  const hint = resolveStoreAlias(rawText, favorites);
  let text = hint?.rest ?? rawText;

  for (const token of [storeName, storeName.replace(/^麦当劳/, '')]) {
    const needle = trimPunctuation(token);
    if (!needle) continue;
    text = text.replace(new RegExp(escapeRegExp(needle), 'gi'), ' ');
  }
  return parseItemSpecs(trimPunctuation(text));
}

function aliasFor(item: MenuItem, favorites: FavoritesConfig): readonly string[] | undefined {
  return favorites.meals.find((meal) => meal.name === item.name)?.alias;
}

// ─────────────────────────────────────────────────────────────
// 特制（T18）
// ─────────────────────────────────────────────────────────────

interface SpecOutcome {
  readonly values: readonly ModificationValue[];
  readonly modNote?: string;
}

async function resolveSpec(
  input: BuildPreviewInput,
  store: Store,
  item: MenuItem,
  specText: string | undefined,
  scene: SceneKey,
): Promise<SpecOutcome> {
  if (!specText) return { values: [] };

  // FR-18：特制 code 只能从 query-meal-detail 取，禁止凭空构造
  let detail;
  try {
    detail = await input.gateway.getMealDetail({
      scene,
      storeCode: store.code,
      code: item.code,
      ...(input.reservationDate ? { reservationDate: input.reservationDate } : {}),
    });
  } catch {
    detail = undefined;
  }

  if (!detail) {
    return {
      values: [],
      modNote: `⚠️「${item.name}」查不到可选特制，「${specText}」未生效，将以默认做法出餐。`,
    };
  }

  const built = buildModification(detail, specText);
  const summary = describeModification(built.applied, built.unmatched);
  return {
    values: built.values,
    ...(summary !== '无' ? { modNote: `${item.name}：${summary}` } : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────

function fail(reason: FlowFailure, message: string): FailureResult {
  return { ok: false, reason, message };
}

function failureFrom(error: unknown, prefix: string): FailureResult {
  return { ok: false, reason: 'gateway', message: `${prefix}：${publicErrorMessage(error)}` };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 预览卡片文本 —— 渠道无关，微信与终端共用同一份渲染 */
export function renderPreview(preview: OrderPreview, notes: readonly string[]): string {
  const lines: string[] = [];
  const { cart, price } = preview;
  const scene = getScene(cart.scene);

  lines.push(`📍 ${cart.store.name}`);
  if (cart.store.distanceMeters !== undefined) {
    lines.push(`   距离约 ${cart.store.distanceMeters}m`);
  }
  lines.push('');

  for (const item of cart.items) {
    const per = item.menuPriceCents >= 0 ? `  ${money(item.menuPriceCents)}` : '';
    lines.push(`· ${item.name} ×${item.quantity}${per}`);
    if (item.specText) lines.push(`    特制：${item.specText}`);
  }

  lines.push('');
  lines.push(`商品合计  ${money(price.originalCents)}`);
  if (price.discountCents > 0) lines.push(`优惠      -${money(price.discountCents)}`);
  lines.push(`应付      ${money(price.payableCents)}`);
  lines.push('');
  lines.push(`取餐方式  ${preview.takeWay.title || scene.label}`);

  for (const note of notes) lines.push(note);

  lines.push('');
  lines.push('回复「确认」下单，回复「取消」放弃。');
  return lines.join('\n');
}
