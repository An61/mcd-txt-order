/**
 * 容忍式字段归一 —— 把 MCP 返回的原始报文转成领域对象。
 *
 * 为什么需要"容忍"：麦当劳 MCP 仍在迭代（README 写 28 个工具，实测 35 个），
 * 字段命名存在同义写法（storeCode / storeNo / code），且同一工具在不同场景
 * 返回形态不同（有时是数组、有时包在 data.list 里）。
 *
 * 设计约定：**解析失败不抛异常，而是降级返回少量信息**，把是否够用交给上层判断。
 * 只有"完全拿不到必需字段"时才返回空数组/空对象，让调用方按空结果处理。
 */

import {
  UNKNOWN_PRICE_CENTS,
  type Cart,
  type CartItem,
  type MealDetail,
  type Menu,
  type MenuCategory,
  type MenuItem,
  type ModificationGroup,
  type ModificationOption,
  type PriceBreakdown,
  type PriceLine,
  type Store,
  type TakeWay,
} from '../domain/types.ts';

// ─────────────────────────────────────────────────────────────
// 通用取值工具
// ─────────────────────────────────────────────────────────────

type Unknown = unknown;

function isRecord(value: Unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 按候选 key 顺序取字符串。
 * 同时兼容一层浅查找 —— 服务端偶尔会把字段塞进 data / result 子对象里。
 */
export function pickString(source: Unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function pickNumber(source: Unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function pickBoolean(source: Unknown, keys: readonly string[]): boolean | undefined {
  if (!isRecord(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

/** 数组取值：支持直接是数组，或藏在 data.list / data.items / data.records 里 */
export function pickArray(source: Unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(source)) return source;
  if (!isRecord(source)) return [];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** 沿着候选路径向下取值，如 `data.categories` */
export function pickPath(source: Unknown, path: string): Unknown {
  let current: Unknown = source;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

// ─────────────────────────────────────────────────────────────
// 响应信封
// ─────────────────────────────────────────────────────────────

export interface EnvelopeView {
  readonly success: boolean;
  readonly code: number | string | undefined;
  readonly message: string;
  readonly data: Unknown;
}

/** 实测信封：`{ success, code, message, datetime, traceId, data }` */
export function readEnvelope(payload: Unknown): EnvelopeView {
  if (!isRecord(payload)) {
    return { success: false, code: undefined, message: '响应不是对象', data: undefined };
  }

  // 有的工具会多包一层：`{ success, code, data: { success, code, data: <真数据> } }`。
  // 判定条件是「内层 data 自己也带 success」，不能写成 'success' in payload，
  // 否则会把正常的单层信封剥掉一层，导致 data 取到 undefined（本项目踩过这个坑）。
  const inner = payload.data;
  const body = isRecord(inner) && 'success' in inner ? inner : payload;

  const successRaw = isRecord(body) ? body.success : undefined;
  const success = successRaw === true || successRaw === 'true';
  const message = pickString(body, ['message', 'msg', 'errorMessage']) ?? '';
  const code = pickNumber(body, ['code', 'errcode']) ?? pickString(body, ['code', 'errcode']);
  return { success, code, message, data: isRecord(body) ? body.data : undefined };
}

/**
 * 把 MCP 的业务错误码翻译成人话 —— NF-19 要求：绝不把 JSON 异常抛给用户。
 *
 * 这些文案是实测踩出来的（`code=600050 / 60001 / 60006`），每个都对应一次真实失败。
 */
export function humanizeMcpFailure(view: EnvelopeView): string {
  switch (String(view.code)) {
    case '600050':
      return '官方收藏餐厅列表为空，已改用城市+关键词检索。若想启用收藏优先，请先在麦当劳 App 里收藏几家门店。';
    case '60001':
      return '餐品与当前门店不匹配（可能是预约时间与当前时段不一致），请重试一次。';
    case '60006':
      return '该商品当前不可售或已售罄。若在预约时段下单，请确认整条链路用了同一个预约时间。';
    case '401':
      return 'MCP Token 已失效，请到 https://open.mcd.cn/mcp 重新申请。';
    default:
      break;
  }
  return '麦当劳服务返回了未知错误，请稍后再试。';
}

// ─────────────────────────────────────────────────────────────
// 金额单位的两种来源（FR-27）
// ─────────────────────────────────────────────────────────────

/**
 * 菜单侧：`currentPrice` / `originalPrice` 是「元」的**字符串**，如 `"26.5"`。
 * 实测样例：巨无霸 `"currentPrice":"26.5"`（午餐菜单）。
 */
export function centsFromYuanString(value: Unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d.-]/g, '');
    const parsed = Number.parseFloat(cleaned);
    if (Number.isFinite(parsed)) return Math.round(parsed * 100);
  }
  return UNKNOWN_PRICE_CENTS;
}

/**
 * 算价侧：`price / subtotal / discount / productOriginalPrice` 是「分」的**整数**。
 * 实测样例：巨无霸 `price=2650`。
 */
export function centsFromCentsInt(value: Unknown): number {
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(num)) return UNKNOWN_PRICE_CENTS;
  return Math.round(num);
}

// ─────────────────────────────────────────────────────────────
// 门店
// ─────────────────────────────────────────────────────────────

/**
 * 门店解析。
 * 实测形态：`data` 直接是数组，每项含
 * `storeCode / storeName / address / distance / businessStatus / businessStartTime / businessEndTime / reservation / reservationTimeOptions`。
 */
export function parseStores(payload: Unknown, fallbackCity?: string): Store[] {
  const view = readEnvelope(payload);
  const list = pickArray(view.data, ['stores', 'list', 'records', 'items', 'content']);
  const stores: Store[] = [];

  for (const entry of list) {
    const code = pickString(entry, ['storeCode', 'storeNo', 'code', 'storeId']);
    const name = pickString(entry, ['storeName', 'name', 'store']);
    if (!code || !name) continue;

    const raw = entry;
    stores.push({
      code,
      name,
      address: pickString(entry, ['address', 'storeAddress', 'detailAddress']),
      distanceMeters: pickNumber(entry, ['distance', 'distanceMeters', 'dist']),
      city: pickString(entry, ['city', 'cityName']) ?? fallbackCity,
      beCode: pickString(entry, ['beCode', 'businessCode', 'bizCode']),
      open: pickBoolean(entry, ['businessStatus', 'open', 'isOpen']),
      businessStartTime: pickString(entry, ['businessStartTime', 'startTime', 'openTime']),
      businessEndTime: pickString(entry, ['businessEndTime', 'endTime', 'closeTime']),
      supportsReservation: pickBoolean(entry, ['reservation', 'supportReservation']),
      raw,
    });
  }

  return stores;
}

// ─────────────────────────────────────────────────────────────
// 菜单（结构陷阱最大的一个）
// ─────────────────────────────────────────────────────────────

/**
 * 菜单解析。
 *
 * 实测 `query-meals` 返回**两份数据**：
 * - `data.categories[] = { name, meals: [{ code, tags }] }` —— **分类里有 code 但没有名称与价格**
 * - `data.meals`  —— **以 code 为 key 的字典**：`{ name, image, currentPrice, originalPrice, canWithOrder }`
 *
 * 因此必须先用字典补全，再按分类顺序产出。只遍历 categories 会得到一堆没有名字的 code。
 */
export function parseMenu(payload: Unknown, storeCode: string): Menu {
  const view = readEnvelope(payload);
  const data = view.data;
  const dict = isRecord(data) && isRecord(data.meals) ? data.meals : {};

  const categoryBuckets = new Map<string, string[]>();
  const taggedCodes = new Map<string, Set<string>>();

  const rawCategories = pickArray(pickPath(data, 'categories'), ['categories']);
  for (const bucket of rawCategories) {
    const categoryName = pickString(bucket, ['name', 'categoryName', 'title']) ?? '未分类';
    const codes: string[] = [];
    for (const entry of pickArray(bucket, ['meals', 'items', 'products'])) {
      const code = pickString(entry, ['code', 'productCode', 'mealCode']);
      if (!code) continue;
      codes.push(code);
      const tagsNode = entry;
      const tags = pickArray(tagsNode, ['tags', 'labels']);
      const set = taggedCodes.get(code) ?? new Set<string>();
      for (const tag of tags) if (typeof tag === 'string' && tag.trim()) set.add(tag.trim());
      taggedCodes.set(code, set);
    }
    if (codes.length === 0) continue;
    const existing = categoryBuckets.get(categoryName) ?? [];
    // 同一分类可能在报文里分多段出现，去重后合并
    for (const code of codes) if (!existing.includes(code)) existing.push(code);
    categoryBuckets.set(categoryName, existing);
  }

  const itemMap = new Map<string, MenuItem>();
  const order: string[] = [];

  const register = (code: string, categories: string[], tags: string[]): void => {
    const entry = dict[code];
    const raw = entry;
    const existing = itemMap.get(code);
    if (existing) {
      const mergedCategories = [...new Set([...existing.categories, ...categories])];
      const mergedTags = [...new Set([...existing.tags, ...tags])];
      itemMap.set(code, { ...existing, categories: mergedCategories, tags: mergedTags });
      return;
    }
    itemMap.set(code, {
      code,
      name: pickString(entry, ['name', 'productName', 'mealName']) ?? `未知商品(${code})`,
      priceCents: centsFromYuanString(isRecord(entry) ? entry.currentPrice : undefined),
      originalPriceCents: centsFromYuanString(isRecord(entry) ? entry.originalPrice : undefined),
      imageUrl: pickString(entry, ['image', 'imageUrl', 'picture']),
      tags,
      categories,
      canWithOrder: pickBoolean(entry, ['canWithOrder', 'supportWithOrder']),
      raw,
    });
    order.push(code);
  };

  for (const [categoryName, codes] of categoryBuckets) {
    for (const code of codes) {
      register(code, [categoryName], [...(taggedCodes.get(code) ?? [])]);
    }
  }

  // 字典里存在但没挂在任何分类下的品，也要收进来，否则匹配会漏
  for (const code of Object.keys(dict)) {
    if (!itemMap.has(code)) register(code, [], [...(taggedCodes.get(code) ?? [])]);
  }

  const categories: MenuCategory[] = [...categoryBuckets.entries()].map(([name, codes]) => ({
    name,
    codes,
  }));

  return { storeCode, categories, items: order.map((code) => itemMap.get(code) as MenuItem) };
}

// ─────────────────────────────────────────────────────────────
// 餐品详情与特制
// ─────────────────────────────────────────────────────────────

/**
 * 餐品详情解析。
 * 实测 `data = { code, name, rounds, image, supportModify, modification: { items: [...] } }`，
 * 其中每个 item 是 `{ maxValues, minValues, values: [{ code, price, name, maxQuantity, minQuantity, selectedQuantity, selectedKey, unselectedKey }] }`。
 *
 * 注意 `price` 是「元」的数字（实测 0），因此走 strings-元 的换算分支。
 */
export function parseMealDetail(payload: Unknown): MealDetail | undefined {
  const view = readEnvelope(payload);
  const data = view.data;
  if (!isRecord(data)) return undefined;

  const code = pickString(data, ['code', 'productCode']);
  if (!code) return undefined;

  const modificationNode = pickPath(data, 'modification');
  const groupNodes = pickArray(modificationNode, ['items', 'groups', 'values']);
  const groups: ModificationGroup[] = [];

  for (const groupNode of groupNodes) {
    const valueNodes = pickArray(groupNode, ['values', 'options']);
    const options: ModificationOption[] = [];
    for (const node of valueNodes) {
      const optionCode = pickString(node, ['code', 'id']);
      const optionName = pickString(node, ['name', 'title']);
      if (!optionCode || !optionName) continue;
      options.push({
        code: optionCode,
        name: optionName,
        // modification 的 price 实测为「元」且在 preview 阶段恒为 0，仍需按元换算
        priceCents: centsFromYuanString(isRecord(node) ? node.price : undefined),
        minQuantity: pickNumber(node, ['minQuantity', 'min']) ?? 0,
        maxQuantity: pickNumber(node, ['maxQuantity', 'max']) ?? 1,
        selectedQuantity: pickNumber(node, ['selectedQuantity', 'quantity']) ?? 0,
        selectedKey: pickString(node, ['selectedKey']) ?? '',
        unselectedKey: pickString(node, ['unselectedKey']) ?? '',
      });
    }
    if (options.length === 0) continue;
    groups.push({
      minValues: pickNumber(groupNode, ['minValues']) ?? 0,
      maxValues: pickNumber(groupNode, ['maxValues']) ?? options.length,
      options,
    });
  }

  return {
    code,
    name: pickString(data, ['name', 'productName']) ?? code,
    imageUrl: pickString(data, ['image', 'imageUrl']),
    supportModify: pickBoolean(data, ['supportModify', 'canModify']) ?? groups.length > 0,
    groups,
    rounds: pickArray(data, ['rounds']),
    raw: data,
  };
}

// ─────────────────────────────────────────────────────────────
// 价格
// ─────────────────────────────────────────────────────────────

/**
 * 算价结果解析。
 * 实测 `data = { productOriginalPrice, productPrice, originalPrice, discount, price,
 *                productList: [{ productCode, productName, quantity, originalSubtotal, subtotal }],
 *                takeWayList: [{ code, title, subtitle }] }`
 * **全部单位为「分」的整数**。
 */
export function parsePrice(payload: Unknown): PriceBreakdown | undefined {
  const view = readEnvelope(payload);
  const data = view.data;
  if (!isRecord(data)) return undefined;

  const lines: PriceLine[] = [];
  for (const node of pickArray(data, ['productList', 'items', 'details'])) {
    const productCode = pickString(node, ['productCode', 'code']);
    const productName = pickString(node, ['productName', 'name']);
    if (!productCode) continue;
    lines.push({
      productCode,
      productName: productName ?? productCode,
      quantity: pickNumber(node, ['quantity', 'qty']) ?? 1,
      originalSubtotalCents: centsFromCentsInt(
        isRecord(node) ? node.originalSubtotal : undefined,
      ),
      subtotalCents: centsFromCentsInt(isRecord(node) ? node.subtotal : undefined),
    });
  }

  const takeWays: TakeWay[] = [];
  for (const node of pickArray(data, ['takeWayList', 'takeWay', 'takeWays'])) {
    const code = pickString(node, ['code', 'takeWayCode']);
    const title = pickString(node, ['title', 'name']);
    if (!code) continue;
    takeWays.push({ code, title: title ?? code, subtitle: pickString(node, ['subtitle', 'desc']) });
  }

  return {
    originalCents: centsFromCentsInt(isRecord(data) ? data.productOriginalPrice : undefined),
    discountCents: centsFromCentsInt(isRecord(data) ? data.discount : undefined),
    payableCents: centsFromCentsInt(isRecord(data) ? data.price : undefined),
    lines,
    takeWays,
    raw: data,
  };
}

/**
 * 订单创建结果解析。
 * `create-order` 是真实网关的写操作；解析层只放行经过协议和域名校验的支付链接。
 */
export function parseOrderResult(payload: Unknown): { orderId: string; payUrl: string; raw: unknown } | undefined {
  const view = readEnvelope(payload);
  const data = view.data;
  if (!isRecord(data)) return undefined;
  const orderId = pickString(data, ['orderId', 'orderNo', 'orderCode']);
  const candidateUrl = pickString(data, ['payUrl', 'payLink', 'paymentUrl', 'cashierUrl', 'url']);
  if (!orderId) return undefined;
  return { orderId, payUrl: isSafePaymentUrl(candidateUrl) ? candidateUrl! : '', raw: data };
}

const DEFAULT_PAYMENT_HOSTS = ['example.invalid', 'mcd.cn', 'mcd.com.cn', 'mcdonalds.com.cn'];

/**
 * Payment links are never accepted from arbitrary protocols or hosts. The
 * allowlist is configurable because the provider may change its cashier host.
 */
export function isSafePaymentUrl(value: string | undefined): value is string {
  if (!value || value.length > 2_048 || value.trim() !== value) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return false;

  const configured = process.env.MCD_PAYMENT_HOSTS?.split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const allowed = configured && configured.length > 0 ? configured : DEFAULT_PAYMENT_HOSTS;
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return allowed.some((host) => {
    const normalized = host.replace(/^\*\./, '').replace(/\.$/, '');
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

// ─────────────────────────────────────────────────────────────
// 购物车指纹
// ─────────────────────────────────────────────────────────────

/**
 * 计算购物车指纹（用于幂等去重）。
 * 组成要素：**门店 + 场景 + 每个餐品的 code×数量×特制 + 预约时间**。
 *
 * 刻意**不包含**价格：价格会随券与时点变动，若纳入指纹会导致同一份方案的
 * 幂等失效（用户确认第二次时因为券变了被判成新订单）。
 */
export function cartFingerprint(cart: Cart): string {
  const parts: string[] = [
    `scene:${cart.scene}`,
    `store:${cart.store.code}`,
    `resv:${cart.reservationDate ?? ''}`,
  ];

  const sorted = [...cart.items].sort((a, b) => a.productCode.localeCompare(b.productCode));
  for (const item of sorted) {
    const mods = (item.modifications ?? [])
      .map((m) => `${m.code}:${m.quantity}`)
      .sort()
      .join('|');
    parts.push(`item:${item.productCode}x${item.quantity}[${mods}]`);
  }

  // 用 strongHash 而非 simpleHash：这是守卫判定"是不是同一笔单"的唯一依据
  return strongHash(parts.join('&'));
}

/** FNV-1a，够用且零依赖。仅用于本地幂等，不承担安全用途 */
export function simpleHash(input: string): string {
  return fnv1a(input, 0x811c9dc5, 0x01000193);
}

/** 单车道 FNV-1a，32 位 —— 够做去重，不够做"会不会多扣一笔钱"的判定 */
function fnv1a(input: string, offset: number, prime: number): string {
  let hash = offset;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 双车道哈希，约 64 位。
 *
 * 为什么 cartFingerprint 不能只用 simpleHash：**守卫是靠指纹判定幂等的**，
 * 一旦两笔不同的订单算出同一个指纹，用户就会被拒绝下单（或更糟的情况）。
 * 32 位在生日攻击下 6 万笔就接近 1% 碰撞率 —— 对一个"防止多扣一笔钱"的
 * 系统来说，这个风险不该留。两条不同参数的车道拼接后可到 ~64 位。
 *
 * 不使用 crypto：这里要的是**稳定与确定性**（进程重启后同一购物车必须算出同样的值），
 * 而非抗篡改 —— 抗篡改由确认令牌那层的 HMAC-SHA256 负责。
 */
export function strongHash(input: string): string {
  const laneA = fnv1a(input, 0x811c9dc5, 0x01000193);
  const laneB = fnv1a(input, 0x01000193, 0x85ebca6b);
  return `${laneA}${laneB}`;
}

/** 购物车总价快照（仅用于预览展示，最终以 calculate-price 为准） */
export function cartMenuTotalCents(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => {
    if (item.menuPriceCents < 0) return sum;
    return sum + item.menuPriceCents * item.quantity;
  }, 0);
}
