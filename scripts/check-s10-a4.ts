import { strict as assert } from 'node:assert';
import { ConversationCore } from '../src/channel/core.ts';
import { buildPreview } from '../src/domain/orderFlow.ts';
import type { FavoritesConfig } from '../src/domain/favorites.ts';
import type { ProviderAddress } from '../src/domain/addressBook.ts';
import type { Cart, MealDetail, Menu, OrderResult, PriceBreakdown, Store } from '../src/domain/types.ts';
import type { CreateOrderInput, DataGateway, MealDetailQuery, MenuQuery, StoreQuery } from '../src/mcp/gateway.ts';

const store: Store = {
  code: 'synthetic-a4-store',
  name: '示例星河餐厅',
  city: '示例市',
  beCode: 'synthetic-be',
  open: true,
};
const menu: Menu = {
  storeCode: store.code,
  categories: [],
  items: [{ code: 'synthetic-big-mac', name: '巨无霸', priceCents: 1800, originalPriceCents: 1800, tags: [], categories: [] }],
};

class A4Gateway implements DataGateway {
  readonly mode = 'sample' as const;
  readonly storeQueries: StoreQuery[] = [];
  readonly carts: Cart[] = [];
  createCalls = 0;

  describe(): string { return 'synthetic S10-A4 gateway'; }
  async listStores(query: StoreQuery): Promise<Store[]> {
    this.storeQueries.push(query);
    if (query.scene === 'delivery' && query.addressId !== 'synthetic-address') throw new Error('missing delivery address');
    return [store];
  }
  async getMenu(_query: MenuQuery): Promise<Menu> { return menu; }
  async getMealDetail(_query: MealDetailQuery): Promise<MealDetail | undefined> { return undefined; }
  async calculatePrice(cart: Cart): Promise<PriceBreakdown> {
    this.carts.push(cart);
    const line = cart.items[0]!;
    return {
      originalCents: line.menuPriceCents * line.quantity,
      discountCents: 0,
      payableCents: line.menuPriceCents * line.quantity,
      lines: [{
        productCode: line.productCode,
        productName: line.name,
        quantity: line.quantity,
        originalSubtotalCents: line.menuPriceCents * line.quantity,
        subtotalCents: line.menuPriceCents * line.quantity,
      }],
      takeWays: [
        { code: 'eat-in', title: '堂食' },
        { code: 'take-in-store', title: '外带' },
      ],
    };
  }
  async createOrder(_input: CreateOrderInput): Promise<OrderResult> {
    this.createCalls += 1;
    throw new Error('S10-A4 must not call create-order');
  }
  async cancelOrder(_orderId: string, _reasonCode: string): Promise<boolean> { return true; }
  async listDeliveryAddresses(): Promise<ProviderAddress[]> { return []; }
}

const favorites: FavoritesConfig = {
  version: 1,
  stores: [{ alias: ['星河'], name: store.name, city: '示例市' }],
  meals: [],
  combos: [],
  rules: { defaultCity: '示例市', defaultScene: 'pickup' },
};

const gateway = new A4Gateway();
const delivery = await buildPreview({
  gateway,
  favorites,
  rawText: '公司 外卖 巨无霸',
  scene: 'delivery',
  addressId: 'synthetic-address',
  mealQuery: '巨无霸',
});
assert.equal(delivery.ok, true);
assert.equal(delivery.ok && delivery.preview.cart.addressId, 'synthetic-address');
assert.equal(gateway.storeQueries.at(-1)?.addressId, 'synthetic-address');

const missingAddress = await buildPreview({
  gateway,
  favorites,
  rawText: '外卖 巨无霸',
  scene: 'delivery',
  mealQuery: '巨无霸',
});
assert.equal(missingAddress.ok, false);
if (!missingAddress.ok) assert.equal(missingAddress.reason, 'need-address');

const dineIn = await buildPreview({
  gateway,
  favorites,
  rawText: '餐品:巨无霸 餐厅:星河餐厅 堂食',
  scene: 'pickup',
  storeQuery: store.name,
  mealQuery: '巨无霸',
  preferredTakeWayCode: 'eat-in',
});
assert.equal(dineIn.ok, true);
assert.equal(dineIn.ok && dineIn.preview.takeWay.code, 'eat-in');

const core = new ConversationCore({
  gateway,
  favorites,
  deliveryAddressResolver: async ({ reference }) => reference === '家' ? { addressId: 'synthetic-address', alias: '家' } : undefined,
});
const coreDineIn = await core.handle('user-a', '餐品:巨无霸 餐厅:星河餐厅 堂食');
assert.equal(coreDineIn.kind, 'preview');
assert.match(coreDineIn.text, /堂食/);
const coreDelivery = await core.handle('user-b', '家 外卖 巨无霸');
assert.equal(coreDelivery.kind, 'preview');
assert.equal(gateway.carts.at(-1)?.addressId, 'synthetic-address');
assert.equal(gateway.createCalls, 0);

console.log('S10-A4 PASS');
