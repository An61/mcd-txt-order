/**
 * 收藏与别名管理（用户心愿単的配置中心）。
 *
 * 分工原则：**别名在本地，名单在云端。**
 * - 本地 `config/favorites.json` 只存「香梅北 → 深圳福田香梅北店」这类**叫法映射**；
 * - 真实门店清单以官方 `query-nearby-stores` 为准，避免本地写死名单过期失效。
 *   （实测本账号收藏列表为空会返回 code 600050，因此南侧必须能随时回退到关键词检索。）
 *
 * 文件缺失时自动回退到 `favorites.example.json` 并给出提示，不阻断运行。
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findProjectRoot } from '../env.ts';
import { foldWidth, normalizeCompact, trimPunctuation } from './text.ts';

// ─────────────────────────────────────────────────────────────
// 配置模型
// ─────────────────────────────────────────────────────────────

export interface StoreFavorite {
  readonly alias: readonly string[];
  readonly name: string;
  readonly city?: string;
  readonly note?: string;
}

export interface MealFavorite {
  readonly alias: readonly string[];
  readonly name: string;
  readonly qty?: number;
  readonly spec?: string;
  readonly note?: string;
}

export interface ComboFavoriteItem {
  readonly name: string;
  readonly qty?: number;
}

export interface ComboFavorite {
  readonly alias: readonly string[];
  readonly items: readonly ComboFavoriteItem[];
  readonly note?: string;
}

export interface FavoriteRules {
  readonly defaultScene?: 'pickup' | 'driveThrough' | 'delivery';
  readonly autoUseCoupons?: boolean;
  readonly requireConfirm?: boolean;
  /**
   * 兜底城市。**门店检索强制要求 `city + keyword` 同时给出**（实测 `600058 城市名或者关键词不能为空`），
   * 因此当用户输入里没带城市时必须有一个退路，否则无法发起任何检索。
   */
  readonly defaultCity?: string;
}

export interface FavoritesConfig {
  readonly version: number;
  readonly defaultStore?: string;
  readonly stores: readonly StoreFavorite[];
  readonly meals: readonly MealFavorite[];
  readonly combos: readonly ComboFavorite[];
  readonly rules: FavoriteRules;
}

export interface LoadResult {
  readonly config: FavoritesConfig;
  readonly sourcePath: string;
  /** 用了 example 文件兜底 */
  readonly usedFallback: boolean;
  readonly warnings: readonly string[];
}

const EMPTY_CONFIG: FavoritesConfig = {
  version: 1,
  stores: [],
  meals: [],
  combos: [],
  rules: {},
};

// ─────────────────────────────────────────────────────────────
// 加载
// ─────────────────────────────────────────────────────────────

/**
 * 读取收藏配置。优先级：`config/favorites.json` → `config/favorites.example.json`。
 * 解析失败不抛异常，而是退化成空配置 + 一条警告（NF-19：不能把 JSON 异常抛给用户）。
 */
export function loadFavorites(root?: string): LoadResult {
  const projectRoot = root ?? findProjectRoot();
  const primary = resolve(projectRoot, 'config', 'favorites.json');
  const fallback = resolve(projectRoot, 'config', 'favorites.example.json');

  if (existsSync(primary)) {
    try {
      const parsed = JSON.parse(readFileSync(primary, 'utf8')) as unknown;
      return { config: normalizeConfig(parsed), sourcePath: primary, usedFallback: false, warnings: [] };
    } catch (error) {
      return {
        config: readFallback(fallback, primary).config,
        sourcePath: primary,
        usedFallback: true,
        warnings: [`收藏配置文件解析失败（${String(error)}），已回退到示例配置`],
      };
    }
  }

  const fallbackResult = readFallback(fallback, primary);
  return {
    config: fallbackResult.config,
    // 回退时必须回报**真正读到的那个文件**，否则排查时会以为读了不存在的 favorites.json
    sourcePath: fallbackResult.path,
    usedFallback: true,
    warnings: [
      `未找到 config/favorites.json，已使用示例配置。复制 favorites.example.json 为 favorites.json 即可自定义别名。`,
      ...fallbackResult.warnings,
    ],
  };
}

function normalizeRules(raw: Record<string, unknown>): FavoriteRules {
  const source = (typeof raw.rules === 'object' && raw.rules ? raw.rules : raw) as Record<string, unknown>;
  const rawDefaultCity = source.defaultCity;
  return {
    // 顶层与 rules 内部都接受 defaultCity，写哪儿都算
    ...(typeof rawDefaultCity === 'string' && rawDefaultCity.trim()
      ? { defaultCity: rawDefaultCity.trim() }
      : {}),
    ...(typeof raw.defaultScene === 'string' ? { defaultScene: raw.defaultScene as FavoriteRules['defaultScene'] } : {}),
    ...(typeof raw.autoUseCoupons === 'boolean' ? { autoUseCoupons: raw.autoUseCoupons } : {}),
    ...(typeof raw.requireConfirm === 'boolean' ? { requireConfirm: raw.requireConfirm } : {}),
  };
}

/**
 * 取兜底城市。优先级：环境变量 > 收藏配置 > undefined。
 * **没有兜底城市时，带门店关键词的检索会直接失败** —— 调用方据此向用户追问城市。
 */
export function defaultCity(config: FavoritesConfig): string | undefined {
  const fromEnv = process.env.MCD_DEFAULT_CITY?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = config.rules.defaultCity ?? config.stores.find((s) => s.city)?.city;
  return fromConfig?.trim() || undefined;
}

function readFallback(fallbackPath: string, _primaryPath: string): { config: FavoritesConfig; path: string; warnings: string[] } {
  if (!existsSync(fallbackPath)) {
    return { config: EMPTY_CONFIG, path: fallbackPath, warnings: ['示例配置文件也不存在，将完全依赖用户输入'] };
  }
  try {
    const parsed = JSON.parse(readFileSync(fallbackPath, 'utf8')) as unknown;
    return { config: normalizeConfig(parsed), path: fallbackPath, warnings: [] };
  } catch (error) {
    return { config: EMPTY_CONFIG, path: fallbackPath, warnings: [`示例配置文件解析失败：${String(error)}`] };
  }
}

/** 宽松地把任意 JSON 收敛成配置结构，缺字段补默认值 */
export function normalizeConfig(input: unknown): FavoritesConfig {
  if (!input || typeof input !== 'object') return EMPTY_CONFIG;
  const raw = input as Record<string, unknown>;

  return {
    version: typeof raw.version === 'number' ? raw.version : 1,
    defaultStore: typeof raw.defaultStore === 'string' ? raw.defaultStore : undefined,
    stores: normalizeStores(raw.stores),
    meals: normalizeMeals(raw.meals),
    combos: normalizeCombos(raw.combos),
    rules: normalizeRules(raw),
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function normalizeStores(value: unknown): StoreFavorite[] {
  if (!Array.isArray(value)) return [];
  const out: StoreFavorite[] = [];
  for (const node of value) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (!name) continue;
    out.push({
      alias: toStringArray(record.alias),
      name,
      city: typeof record.city === 'string' ? record.city : undefined,
      note: typeof record.note === 'string' ? record.note : undefined,
    });
  }
  return out;
}

function normalizeMeals(value: unknown): MealFavorite[] {
  if (!Array.isArray(value)) return [];
  const out: MealFavorite[] = [];
  for (const node of value) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (!name) continue;
    out.push({
      alias: toStringArray(record.alias),
      name,
      qty: typeof record.qty === 'number' ? record.qty : undefined,
      spec: typeof record.spec === 'string' && record.spec ? record.spec : undefined,
      note: typeof record.note === 'string' ? record.note : undefined,
    });
  }
  return out;
}

function normalizeCombos(value: unknown): ComboFavorite[] {
  if (!Array.isArray(value)) return [];
  const out: ComboFavorite[] = [];
  for (const node of value) {
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const itemsRaw = Array.isArray(record.items) ? record.items : [];
    const items: ComboFavoriteItem[] = [];
    for (const item of itemsRaw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.name !== 'string') continue;
      items.push({
        name: entry.name,
        qty: typeof entry.qty === 'number' ? entry.qty : undefined,
      });
    }
    if (items.length === 0) continue;
    out.push({ alias: toStringArray(record.alias), items, note: typeof record.note === 'string' ? record.note : undefined });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 门店别名
// ─────────────────────────────────────────────────────────────

export interface StoreHint {
  /** 命中的别名原文，如「香梅北」 */
  readonly alias: string;
  readonly favorite: StoreFavorite;
  /** 去掉别名词后的剩余文本，交给数量/餐品解析继续处理 */
  readonly rest: string;
}

/** 低于这个长度的别名不参与自由文本匹配，避免误伤（如单字「北」） */
const MIN_ALIAS_LENGTH = 2;

/**
 * 从用户输入里识别门店别名，并把这部分从文本中摘掉。
 *
 * 为什么在这里摘：用户说「巨无霸 香梅北」，若不先把「香梅北」切出去，
 * 后续会被当成餐品片段产生误导候选。
 *
 * 匹配策略：**取最长命中**。因为别名可能互相包含（「香梅北」是「福田香梅北」的子串），
 * 长命中更能代表用户意图。
 */
export function resolveStoreAlias(text: string, config: FavoritesConfig): StoreHint | undefined {
  const prepared = foldWidth(text);
  const lower = prepared.toLowerCase();

  let best: { alias: string; favorite: StoreFavorite; start: number } | undefined;

  for (const favorite of config.stores) {
    for (const alias of favorite.alias) {
      const folded = foldWidth(alias).toLowerCase();
      if (folded.length < MIN_ALIAS_LENGTH) continue;
      const start = lower.indexOf(folded);
      if (start < 0) continue;
      if (!best || folded.length > foldWidth(best.alias).length) {
        best = { alias, favorite, start };
      }
    }
  }

  if (!best) return undefined;

  const foldedAlias = foldWidth(best.alias);
  const rest = (prepared.slice(0, best.start) + prepared.slice(best.start + foldedAlias.length))
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

  return { alias: best.alias, favorite: best.favorite, rest: trimPunctuation(rest) };
}

/** 默认门店：优先配置里的 defaultStore 别名，其次第一个收藏项 */
export function defaultStoreFavorite(config: FavoritesConfig): StoreFavorite | undefined {
  if (config.defaultStore) {
    const target = normalizeCompact(config.defaultStore);
    for (const favorite of config.stores) {
      if (favorite.alias.some((alias) => normalizeCompact(alias) === target)) return favorite;
      if (normalizeCompact(favorite.name) === target) return favorite;
    }
  }
  return config.stores[0];
}

// ─────────────────────────────────────────────────────────────
// 餐品别名
// ─────────────────────────────────────────────────────────────

/** 找出某个品名在配置里登记的所有别名（含自身） */
export function aliasesForMeal(mealName: string, config: FavoritesConfig): string[] {
  const key = normalizeCompact(mealName);
  for (const favorite of config.meals) {
    if (normalizeCompact(favorite.name) !== key) continue;
    return [...favorite.alias, favorite.name];
  }
  return [mealName];
}

/** 按名称或别名反查收藏项 */
export function findMealFavorite(nameOrAlias: string, config: FavoritesConfig): MealFavorite | undefined {
  const key = normalizeCompact(nameOrAlias);
  if (!key) return undefined;
  for (const favorite of config.meals) {
    if (normalizeCompact(favorite.name) === key) return favorite;
    if (favorite.alias.some((alias) => normalizeCompact(alias) === key)) return favorite;
  }
  return undefined;
}

/**
 * 把收藏里的**默认数量**兜进来。
 * 用户没说几份、但收藏里配了 qty 时用它；用户显式说了数量则以用户说的为准。
 */
export function defaultQtyFor(mealName: string, config: FavoritesConfig): number {
  return findMealFavorite(mealName, config)?.qty ?? 1;
}

/** 收藏里预置的「默认口味」（如巨无霸不要酸黄瓜） */
export function defaultSpecFor(mealName: string, config: FavoritesConfig): string | undefined {
  return findMealFavorite(mealName, config)?.spec;
}

/** 按别名找组合套餐（如「麦辣套餐」→ 堡+薯条+可乐） */
export function findComboFavorite(nameOrAlias: string, config: FavoritesConfig): ComboFavorite | undefined {
  const key = normalizeCompact(nameOrAlias);
  if (!key) return undefined;
  for (const combo of config.combos) {
    if (combo.alias.some((alias) => normalizeCompact(alias) === key)) return combo;
  }
  return undefined;
}
