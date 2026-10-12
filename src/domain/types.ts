/**
 * 领域模型。
 *
 * 设计原则：
 * 1. **金额一律用「分」的整数** 承载（`xxxCents`），避免浮点误差。
 *    原因：实测 `query-meals` 返回的是「元」的字符串（`"26.5"`），
 *    而 `calculate-price` 返回的是「分」的整数（`2650`），两个单位混用是本项目最大的金额陷阱。
 * 2. 领域层不认识 MCP、不认识微信 —— 它只表达"麦当劳点单"这件事本身。
 * 3. 每个从 MCP 来的对象都保留 `raw`，便于线上排查时回看原始报文。
 *
 * 字段命名与取值均以 2026-10-10 对 https://mcp.mcd.cn 的实测为准。
 */

// ─────────────────────────────────────────────────────────────
// 场景：orderType × beType 的组合决定整条链路的参数
// ─────────────────────────────────────────────────────────────

/** 业务类型：1-到店取餐，2-麦乐送到家，5-得来速(DT)，6-企业团餐 */
export type BusinessType = 1 | 2 | 5 | 6;

/** 订单类型：1-到店（含到店自提+得来速），2-外送（含麦乐送+企业团餐） */
export type OrderType = 1 | 2;

export type SceneKey = 'pickup' | 'driveThrough' | 'delivery' | 'groupMeal';

export interface Scene {
  readonly key: SceneKey;
  readonly label: string;
  readonly beType: BusinessType;
  readonly orderType: OrderType;
  /** 该场景下 beCode 必传（来自门店查询，到店自提不可传，传了会报错） */
  readonly requiresBeCode: boolean;
  /** 该场景下 create-order 必须传 takeWayCode */
  readonly requiresTakeWayCode: boolean;
  /** 该场景走配送地址体系 */
  readonly requiresAddressId: boolean;
  /** 检索门店使用的工具名 */
  readonly storeTool: 'query-nearby-stores' | 'delivery-query-stores';
}

/**
 * 场景映射表 —— 实测 `tools/list` 的 description 整理而来。
 * 错一个参数，整条链路会以「商品不可售」的形式失败，很难排查。
 */
export const SCENES: Readonly<Record<SceneKey, Scene>> = {
  pickup: {
    key: 'pickup',
    label: '到店自提',
    beType: 1,
    orderType: 1,
    requiresBeCode: false,
    requiresTakeWayCode: true,
    requiresAddressId: false,
    storeTool: 'query-nearby-stores',
  },
  driveThrough: {
    key: 'driveThrough',
    label: '得来速车道取餐',
    beType: 5,
    orderType: 1,
    requiresBeCode: true,
    requiresTakeWayCode: true,
    requiresAddressId: false,
    storeTool: 'query-nearby-stores',
  },
  delivery: {
    key: 'delivery',
    label: '麦乐送到家',
    beType: 2,
    orderType: 2,
    requiresBeCode: true,
    requiresTakeWayCode: false,
    requiresAddressId: true,
    storeTool: 'delivery-query-stores',
  },
  groupMeal: {
    key: 'groupMeal',
    label: '企业团餐',
    beType: 6,
    orderType: 2,
    requiresBeCode: true,
    requiresTakeWayCode: false,
    requiresAddressId: true,
    storeTool: 'delivery-query-stores',
  },
};

export function getScene(key: SceneKey): Scene {
  const scene = SCENES[key];
  if (!scene) throw new Error(`未知场景：${key}`);
  return scene;
}

// ─────────────────────────────────────────────────────────────
// 门店
// ─────────────────────────────────────────────────────────────

export interface Store {
  readonly code: string;
  readonly name: string;
  readonly address?: string;
  /** 距离（米）。实测 `distance` 是数字，单位米 */
  readonly distanceMeters?: number;
  readonly city?: string;
  /** 业务编码：得来速/外送/团餐场景才有，到店自提场景不返回也不能传 */
  readonly beCode?: string;
  readonly open?: boolean;
  readonly businessStartTime?: string;
  readonly businessEndTime?: string;
  readonly supportsReservation?: boolean;
  readonly raw?: unknown;
}

// ─────────────────────────────────────────────────────────────
// 菜单
// ─────────────────────────────────────────────────────────────

export interface MenuCategory {
  readonly name: string;
  /** 该分类下的餐品 code 顺序 */
  readonly codes: readonly string[];
}

export interface MenuItem {
  readonly code: string;
  readonly name: string;
  /** 现价（分） */
  readonly priceCents: number;
  /** 原价（分） */
  readonly originalPriceCents: number;
  readonly imageUrl?: string;
  readonly tags: readonly string[];
  /** 所属分类名列表（同一餐品可能挂在多个分类下） */
  readonly categories: readonly string[];
  /** 是否可作随单购商品 */
  readonly canWithOrder?: boolean;
  readonly raw?: unknown;
}

export interface Menu {
  readonly storeCode: string;
  readonly categories: readonly MenuCategory[];
  readonly items: readonly MenuItem[];
}

/** `data.meals` 里拿不到时就落到这里，避免下游到处判空 */
export const UNKNOWN_PRICE_CENTS = -1;

export function hasPrice(item: MenuItem): boolean {
  return item.priceCents >= 0;
}

// ─────────────────────────────────────────────────────────────
// 餐品详情与特制
// ─────────────────────────────────────────────────────────────

export interface ModificationOption {
  readonly code: string;
  readonly name: string;
  readonly priceCents: number;
  readonly minQuantity: number;
  readonly maxQuantity: number;
  readonly selectedQuantity: number;
  /** 选中时传给服务端的 key */
  readonly selectedKey: string;
  /** 取消该项时传给服务端的 key */
  readonly unselectedKey: string;
}

export interface ModificationGroup {
  readonly minValues: number;
  readonly maxValues: number;
  readonly options: readonly ModificationOption[];
}

export interface MealDetail {
  readonly code: string;
  readonly name: string;
  readonly imageUrl?: string;
  readonly supportModify: boolean;
  readonly groups: readonly ModificationGroup[];
  /** 套餐轮次（套餐才有，单品为空数组） */
  readonly rounds: readonly unknown[];
  readonly raw?: unknown;
}

/** 发给服务端的「特制」入参形态，必须与 tools/list 的 schema 一致 */
export interface ModificationValue {
  readonly code: string;
  readonly key: string;
  readonly quantity: number;
}

// ─────────────────────────────────────────────────────────────
// 购物车与订单
// ─────────────────────────────────────────────────────────────

export interface CartItem {
  readonly productCode: string;
  readonly name: string;
  /** 数量，必须 ≥ 1 */
  readonly quantity: number;
  /** 菜单快照价（分），仅用于展示，最终以 calculate-price 为准 */
  readonly menuPriceCents: number;
  readonly modifications?: readonly ModificationValue[];
  /** 人类可读的特制说明，如「不要酸黄瓜」 */
  readonly specText?: string;
}

export interface TakeWay {
  readonly code: string;
  readonly title: string;
  readonly subtitle?: string;
}

export interface Cart {
  readonly scene: SceneKey;
  readonly store: Store;
  readonly items: readonly CartItem[];
  /** Provider address reference required by delivery/group-meal scenes. */
  readonly addressId?: string;
  /** Provider take-way code selected from calculate-price. */
  readonly takeWayCode?: string;
  /** 预约时间，格式 `yyyy-MM-dd HH:mm`。一旦设置，全链路必须一致（FR-26） */
  readonly reservationDate?: string;
  readonly needTableware: boolean;
}

export interface PriceLine {
  readonly productCode: string;
  readonly productName: string;
  readonly quantity: number;
  readonly originalSubtotalCents: number;
  readonly subtotalCents: number;
}

export interface PriceBreakdown {
  /** 商品原价合计（分） */
  readonly originalCents: number;
  /** 优惠合计（分） */
  readonly discountCents: number;
  /** 实付（分） */
  readonly payableCents: number;
  readonly lines: readonly PriceLine[];
  /** 取餐方式候选，create-order 的 takeWayCode 只能从这里取 */
  readonly takeWays: readonly TakeWay[];
  readonly raw?: unknown;
}

export interface OrderPreview {
  readonly cart: Cart;
  readonly takeWay: TakeWay;
  readonly price: PriceBreakdown;
  /** 由「用户 + 门店 + 餐品 + 数量 + 特制」算出的指纹，用于幂等与去重 */
  readonly fingerprint: string;
}

export interface OrderResult {
  readonly orderId: string;
  readonly payUrl: string;
  /** 服务端给的过期时间原文（若有） */
  readonly expireText?: string;
  readonly raw?: unknown;
}

// ─────────────────────────────────────────────────────────────
// 营养
// ─────────────────────────────────────────────────────────────

export interface NutritionRecord {
  readonly productName: string;
  /** 实测该字段恒为 null，保留以便未来变化 */
  readonly nutritionDescription: string | null;
  readonly energyKj: number;
  readonly energyKcal: number;
  readonly protein: number;
  readonly fat: number;
  readonly carbohydrate: number;
  readonly sodium: number;
  readonly calcium: number;
}

// ─────────────────────────────────────────────────────────────
// 金额工具
// ─────────────────────────────────────────────────────────────

/** 把「元」的字符串转成「分」的整数。非法输入返回 UNKNOWN_PRICE_CENTS */
export function yuanToCents(value: string | number | undefined | null): number {
  if (value === undefined || value === null) return UNKNOWN_PRICE_CENTS;
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value).trim());
  if (!Number.isFinite(num)) return UNKNOWN_PRICE_CENTS;
  return Math.round(num * 100);
}

/** 「分」转人类可读金额，如 2650 → "26.50" */
export function formatYuan(cents: number): string {
  if (cents < 0) return '—';
  return (cents / 100).toFixed(2);
}

/** 带货币符号的展示形态，如 2650 → "¥26.50" */
export function money(cents: number): string {
  if (cents < 0) return '价格未知';
  return `¥${formatYuan(cents)}`;
}
