/**
 * 数据网关 —— 把「数据从哪来」隔离成一个接口（T14）。
 *
 * 两个实现：
 *   - `createRealGateway()`：走 `https://mcp.mcd.cn` 真实调用
 *   - `createSampleGateway()`：走 `src/data/sample.ts` 的菜单价格快照与合成门店，**完全离线**
 *
 * ### 为什么 Mock 数据用真实快照而不是编的
 * 审查者 clone 下来没有 Token 时，跑示例请求命中的是合成门店与历史菜单价格示例。
 * 编造的假数据会让演示变成自娱自乐，真实快照才能让"它能用"这件事有说服力。
 *
 * ### 关于静默降级（SEC / T14 的红线）
 * **真实模式失败时绝不自动切到 Mock。** 一次网络抖动就把用户的真实下单请求
 * 喂给示例数据，是最危险的一种"贴心"：用户会以为订单下了，钱却没付成。
 * 所以降级只允许在**明确模式切换**时发生，且 Mock 模式下每条回复都会挂上演示模式标识。
 */

import { McpStreamableHttpClient, unwrapToolResult, type McpCallResult } from './client.ts';
import {
  cartMenuTotalCents,
  humanizeMcpFailure,
  parseMealDetail,
  parseMenu,
  parseOrderResult,
  parsePrice,
  parseStores,
  readEnvelope,
} from './normalize.ts';
import {
  SAMPLE_DEFAULT_STORE_CODE,
  SAMPLE_MENU,
  SAMPLE_STORES,
  SAMPLE_TAKE_WAYS,
  SAMPLE_MEAL_DETAIL,
} from '../data/sample.ts';
import {
  getScene,
  SCENES,
  type Cart,
  type Menu,
  type MealDetail,
  type SceneKey,
  type Store,
  type OrderResult,
  type PriceBreakdown,
} from '../domain/types.ts';
import { normalizeProviderAddressForQuery, type AddressBinding, type ProviderAddress } from '../domain/addressBook.ts';

// ─────────────────────────────────────────────────────────────
// 接口
// ─────────────────────────────────────────────────────────────

export interface StoreQuery {
  readonly scene: SceneKey;
  /** 城市。**实测强制要求与 keyword 同时给出**，缺一报 600058 */
  readonly city?: string;
  /** 门店关键词（别名解析后的官方名称优先） */
  readonly keyword?: string;
  /** Delivery address id returned by delivery-query-addresses. Never read from process.env. */
  readonly addressId?: string;
}

export interface MenuQuery {
  readonly scene: SceneKey;
  readonly storeCode: string;
  /** 预约时间；一旦设置，后续算价与下单必须传同一个值（FR-26） */
  readonly reservationDate?: string;
}

export interface MealDetailQuery extends MenuQuery {
  readonly code: string;
}

export interface CreateOrderInput {
  readonly cart: Cart;
  /** **只能**取自 calculate-price 返回的 takeWayList（FR-16 / T16） */
  readonly takeWayCode: string;
}

export interface DataGateway {
  readonly mode: 'real' | 'sample';
  /** 每次对话都要带上的模式说明，防止用户误以为在真实下单 */
  describe(): string;
  listStores(query: StoreQuery): Promise<Store[]>;
  getMenu(query: MenuQuery): Promise<Menu>;
  getMealDetail(query: MealDetailQuery): Promise<MealDetail | undefined>;
  /** 只读：算出真实应付价。同时也是 takeWayCode 的唯一来源 */
  calculatePrice(cart: Cart): Promise<PriceBreakdown>;
  /** **写操作**：产生真实订单 */
  createOrder(input: CreateOrderInput): Promise<OrderResult>;
  /** **写操作**：取消订单 */
  cancelOrder(orderId: string, reasonCode: string): Promise<boolean>;
  listDeliveryAddresses(): Promise<ProviderAddress[]>;
}

export class GatewayError extends Error {
  readonly code?: string | number;
  /** 401 时上层要冻结一切写操作（SEC-7） */
  readonly authFailed: boolean;
  readonly ambiguous: boolean;

  constructor(message: string, options: { code?: string | number; authFailed?: boolean; ambiguous?: boolean } = {}) {
    super(message);
    this.name = 'GatewayError';
    if (options.code !== undefined) this.code = options.code;
    this.authFailed = options.authFailed ?? false;
    this.ambiguous = options.ambiguous ?? false;
  }
}

// ─────────────────────────────────────────────────────────────
// 真实网关
// ─────────────────────────────────────────────────────────────

function buildItems(cart: Cart): Array<Record<string, unknown>> {
  return cart.items.map((item) => {
    const hasMods = item.modifications && item.modifications.length > 0;
    return {
      productCode: item.productCode,
      quantity: item.quantity,
      // 实测：items[].modification 是一个**对象** `{ values: [...] }`，不是数组本身
      ...(hasMods ? { modification: { values: [...item.modifications!] } } : {}),
    };
  });
}

/** 按场景补齐 beCode：得来速/外送/团餐必传，到店自取**传了反而报错** */
function sceneExtras(sceneKey: SceneKey, store: Store): Record<string, unknown> {
  const scene = getScene(sceneKey);
  return scene.requiresBeCode && store.beCode ? { beCode: store.beCode } : {};
}

export class RealGateway implements DataGateway {
  readonly mode = 'real' as const;
  readonly addressBinding?: AddressBinding;

  private readonly client: McpStreamableHttpClient;

  constructor(client?: McpStreamableHttpClient, addressBinding?: AddressBinding) {
    this.client = client ?? new McpStreamableHttpClient();
    this.addressBinding = addressBinding;
  }

  describe(): string {
    return '真实模式：正在调用麦当劳官方 MCP';
  }

  async listDeliveryAddresses(): Promise<ProviderAddress[]> {
    const payload = await this.call('delivery-query-addresses', {});
    const view = readEnvelope(payload);
    const data = view.data;
    const body = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : undefined;
    const value = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined;
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.addresses)
          ? body.addresses
          : Array.isArray(value?.addresses)
            ? value.addresses
            : [];
    return rows.map(normalizeProviderAddressForQuery);
  }

  async listStores(query: StoreQuery): Promise<Store[]> {
    const scene = getScene(query.scene);
    // 第三条路径：麦乐送/团餐走配送地址体系，与到店完全不同
    if (scene.storeTool === 'delivery-query-stores') {
      const addressId = query.addressId?.trim();
      if (!addressId) {
        throw new GatewayError('外送场景需要先完成地址查询并提供 addressId。');
      }
      const payload = await this.call('delivery-query-stores', {
        beType: scene.beType,
        addressId,
      });
      return parseStores(payload, query.city);
    }

    // 收藏餐厅优先。实测：列表为空时报 600050，且**此时传 keyword 也会被忽略**，
    // 因此只能「空即回退」，不存在"收藏 + 关键词过滤"这种组合。
    try {
      const favorites = await this.call('query-nearby-stores', {
        beType: scene.beType,
        searchType: 1,
      });
      const parsed = parseStores(favorites, query.city);
      if (parsed.length > 0) return parsed;
    } catch {
      // 收藏为空属于正常情况，落到下面的关键词检索
    }

    if (!query.city || !query.keyword) {
      throw new GatewayError(
        '门店检索需要同时提供城市与关键词（服务端要求 city + keyword 缺一不可）。' +
          '请在 config/favorites.json 里配置 defaultCity，或在指令里带上城市。',
        { code: 600058 },
      );
    }

    const payload = await this.call('query-nearby-stores', {
      beType: scene.beType,
      searchType: 2,
      city: query.city,
      keyword: query.keyword,
    });
    // 实测：keyword **并不真的按名称过滤**（指定关键词会返回周边一堆店），
    // 所以这里返回候选池，由上层用 matcher 做名称/别名匹配，不能直接用第一条。
    return parseStores(payload, query.city);
  }

  async getMenu(query: MenuQuery): Promise<Menu> {
    const scene = getScene(query.scene);
    const payload = await this.call('query-meals', {
      storeCode: query.storeCode,
      orderType: scene.orderType,
      beType: scene.beType,
      ...(query.reservationDate ? { reservationDate: query.reservationDate } : {}),
    });
    return parseMenu(payload, query.storeCode);
  }

  async getMealDetail(query: MealDetailQuery): Promise<MealDetail | undefined> {
    const scene = getScene(query.scene);
    const payload = await this.call('query-meal-detail', {
      storeCode: query.storeCode,
      orderType: scene.orderType,
      beType: scene.beType,
      code: query.code,
      ...(query.reservationDate ? { reservationDate: query.reservationDate } : {}),
    });
    return parseMealDetail(payload);
  }

  async calculatePrice(cart: Cart): Promise<PriceBreakdown> {
    const scene = getScene(cart.scene);
    if (scene.requiresAddressId && !cart.addressId?.trim()) {
      throw new GatewayError('外送场景缺少已确认的 addressId，已停止算价。');
    }
    const payload = await this.call('calculate-price', {
      storeCode: cart.store.code,
      orderType: scene.orderType,
      beType: scene.beType,
      items: buildItems(cart),
      needTableware: cart.needTableware,
      ...(scene.requiresAddressId ? { addressId: cart.addressId } : {}),
      ...sceneExtras(cart.scene, cart.store),
      // FR-26：预约时间必须全链路一致
      ...(cart.reservationDate ? { reservationDate: cart.reservationDate } : {}),
    });

    const price = parsePrice(payload);
    if (!price) {
      throw new GatewayError('算价结果解析失败，未继续下单。');
    }
    return price;
  }

  async createOrder(input: CreateOrderInput): Promise<OrderResult> {
    const { cart, takeWayCode } = input;
    const scene = getScene(cart.scene);

    if (scene.requiresTakeWayCode && !takeWayCode) {
      throw new GatewayError('到店/得来速场景缺少 takeWayCode，且该值只能从算价结果取得，已中止下单。');
    }
    if (scene.requiresAddressId && !cart.addressId?.trim()) {
      throw new GatewayError('外送场景缺少已确认的 addressId，已中止下单。');
    }

    const payload = await this.call('create-order', {
      storeCode: cart.store.code,
      orderType: scene.orderType,
      beType: scene.beType,
      items: buildItems(cart),
      needTableware: cart.needTableware,
      ...(scene.requiresAddressId ? { addressId: cart.addressId } : {}),
      ...(scene.requiresTakeWayCode ? { takeWayCode } : {}),
      ...sceneExtras(cart.scene, cart.store),
      ...(cart.reservationDate ? { reservationDate: cart.reservationDate } : {}),
    });

    const result = parseOrderResult(payload);
    if (!result) {
      throw new GatewayError('下单响应解析失败，订单状态未知，请到官方渠道核对后再操作。', {
        ambiguous: true,
      });
    }
    return { ...result, raw: payload };
  }

  async cancelOrder(orderId: string, reasonCode: string): Promise<boolean> {
    await this.call('cancel-order', { orderId, cancelReasonCode: reasonCode });
    return true;
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    let payload: unknown;
    const isCreateOrder = tool === 'create-order';
    try {
      payload = unwrapToolResult((await this.client.callTool(tool, args)) as McpCallResult);
    } catch (error) {
      const candidate = error as {
        readonly ambiguous?: unknown;
        readonly authFailed?: unknown;
        readonly httpStatus?: unknown;
      };
      // 401/403 必须让上层知道，用于 SEC-7 冻结
      if (candidate.authFailed === true || candidate.httpStatus === 401 || candidate.httpStatus === 403) {
        throw new GatewayError('MCP 认证失败。', {
          authFailed: true,
          ambiguous: candidate.ambiguous === true || isCreateOrder,
        });
      }
      if (candidate.ambiguous === true) {
        throw new GatewayError('MCP 请求超时或连接中断。', { ambiguous: true });
      }
      // A write may have reached the provider before the client observed an
      // error. Never turn that uncertainty into a retryable failed state.
      throw new GatewayError('MCP 服务暂时不可用。', { ambiguous: isCreateOrder });
    }

    const view = readEnvelope(payload);
    if (!view.success) {
      const human = humanizeMcpFailure(view);
      throw new GatewayError(human || `${tool} 调用失败`, { code: view.code });
    }
    return payload;
  }
}

// ─────────────────────────────────────────────────────────────
// 示例网关（离线）
// ─────────────────────────────────────────────────────────────

export class SampleGateway implements DataGateway {
  readonly mode = 'sample' as const;
  readonly addressBinding?: AddressBinding;

  private placedOrderId: string | undefined;

  constructor(addressBinding?: AddressBinding) {
    this.addressBinding = addressBinding;
  }

  describe(): string {
    return '⚠️ 演示模式：使用离线快照数据，**不会真的下单**';
  }

  async listDeliveryAddresses(): Promise<ProviderAddress[]> {
    return [normalizeProviderAddressForQuery({ addressId: 'sample-address-1', contactName: '示例用户', phone: 'phone-a', fullAddress: '示例市示例区示例路1号' })];
  }

  async listStores(query: StoreQuery): Promise<Store[]> {
    const wanted = query.keyword?.trim();
    if (getScene(query.scene).requiresAddressId && !query.addressId?.trim()) {
      throw new GatewayError('外送场景需要先确认配送地址。');
    }
    if (!wanted) return [...SAMPLE_STORES];
    // 快照模式也走真实的名称包含匹配，保持与真实网关一致的语义
    const hit = SAMPLE_STORES.filter((store) => store.name.includes(wanted));
    return hit.length > 0 ? hit : [...SAMPLE_STORES];
  }

  async getMenu(query: MenuQuery): Promise<Menu> {
    void query.scene;
    if (query.storeCode !== SAMPLE_DEFAULT_STORE_CODE) {
      return { storeCode: query.storeCode, categories: [], items: [] };
    }
    return SAMPLE_MENU;
  }

  async getMealDetail(query: MealDetailQuery): Promise<MealDetail | undefined> {
    const detail = SAMPLE_MEAL_DETAIL;
    if (!detail || query.code !== detail.code) return undefined;
    return detail;
  }

  async calculatePrice(cart: Cart): Promise<PriceBreakdown> {
    if (getScene(cart.scene).requiresAddressId && !cart.addressId?.trim()) {
      throw new GatewayError('外送场景缺少已确认的 addressId，已停止算价。');
    }
    const original = cartMenuTotalCents(cart.items);
    const discount = Math.round(original * 0.1);
    const lines = cart.items.map((item) => ({
      productCode: item.productCode,
      productName: item.name,
      quantity: item.quantity,
      originalSubtotalCents: item.menuPriceCents * item.quantity,
      subtotalCents: item.menuPriceCents * item.quantity,
    }));

    return {
      originalCents: original,
      discountCents: discount,
      payableCents: original - discount,
      lines,
      takeWays: SAMPLE_TAKE_WAYS,
    };
  }

  async createOrder(input: CreateOrderInput): Promise<OrderResult> {
    void input;
    this.placedOrderId = `DEMO-${Date.now()}`;
    return {
      orderId: this.placedOrderId,
      payUrl: 'https://example.invalid/mock-pay/' + this.placedOrderId,
      expireText: '演示订单，请勿真的付款',
    };
  }

  async cancelOrder(orderId: string, _reasonCode: string): Promise<boolean> {
    void orderId;
    return true;
  }
}

// ─────────────────────────────────────────────────────────────
// 工厂（模式切换在此显式发生，不在调用链中途发生）
// ─────────────────────────────────────────────────────────────

export type GatewayMode = 'real' | 'sample' | 'auto';

export interface GatewayBundle {
  readonly gateway: DataGateway;
  /** 为什么选了这个模式 —— 会展示给使用者 */
  readonly reason: string;
}

export function createGateway(mode: GatewayMode = 'auto'): GatewayBundle {
  const token = process.env.MCD_MCP_TOKEN?.trim();

  if (mode === 'sample') {
    return { gateway: new SampleGateway(), reason: '按 --sample 指定为演示模式' };
  }

  if (mode === 'real') {
    if (!token) {
      throw new GatewayError(
        '指定了真实模式但缺少 MCD_MCP_TOKEN。请在 .env 中填写 Token，或改用演示模式。',
      );
    }
    return { gateway: new RealGateway(), reason: '按参数指定为真实模式' };
  }

  // auto：没有 Token 才走演示模式，并且**明确告知**；有 Token 时任何故障都直接抛错，不降级
  if (!token) {
    return {
      gateway: new SampleGateway(),
      reason: '未检测到 MCD_MCP_TOKEN，已进入演示模式（合成门店与历史菜单价格，不会真的下单）',
    };
  }
  return { gateway: new RealGateway(), reason: '检测到 Token，使用真实 MCP' };
}

/** 给 doctor 命令用：列出各场景的参数要求 */
export function describeScenes(): string {
  return Object.values(SCENES)
    .map((scene) => `${scene.label}(beType=${scene.beType}, orderType=${scene.orderType})`)
    .join('  ');
}
