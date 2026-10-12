import { strict as assert } from 'node:assert';
import { ConversationCore } from '../src/channel/core.ts';
import type { FavoritesConfig } from '../src/domain/favorites.ts';
import type { ProviderAddress } from '../src/domain/addressBook.ts';
import type { Cart, MealDetail, Menu, OrderResult, PriceBreakdown, Store } from '../src/domain/types.ts';
import type { CreateOrderInput, DataGateway, MealDetailQuery, MenuQuery, StoreQuery } from '../src/mcp/gateway.ts';
import { cartFingerprint } from '../src/mcp/normalize.ts';

const store: Store = { code: 'synthetic-a5-store', name: '示例星河餐厅', city: '示例市', open: true };
const menu: Menu = {
  storeCode: store.code,
  categories: [],
  items: [{ code: 'synthetic-big-mac', name: '巨无霸', priceCents: 1800, originalPriceCents: 1800, tags: [], categories: [] }],
};

class A5Gateway implements DataGateway {
  readonly mode = 'sample' as const;
  priceCalls = 0;
  createCalls = 0;
  describe(): string { return 'synthetic S10-A5 gateway'; }
  async listStores(_query: StoreQuery): Promise<Store[]> { return [store]; }
  async getMenu(_query: MenuQuery): Promise<Menu> { return menu; }
  async getMealDetail(_query: MealDetailQuery): Promise<MealDetail | undefined> { return undefined; }
  async calculatePrice(cart: Cart): Promise<PriceBreakdown> {
    this.priceCalls += 1;
    const cents = this.priceCalls === 1 ? 1800 : 2000;
    const item = cart.items[0]!;
    return {
      originalCents: cents,
      discountCents: 0,
      payableCents: cents,
      lines: [{ productCode: item.productCode, productName: item.name, quantity: item.quantity, originalSubtotalCents: cents, subtotalCents: cents }],
      takeWays: [{ code: 'take-in-store', title: '外带' }],
    };
  }
  async createOrder(_input: CreateOrderInput): Promise<OrderResult> {
    this.createCalls += 1;
    return { orderId: 'synthetic-a5-order', payUrl: 'https://example.invalid/synthetic-a5-pay' };
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

const gateway = new A5Gateway();
const core = new ConversationCore({ gateway, favorites });
const preview = await core.handle('user-a', '巨无霸 星河');
assert.equal(preview.kind, 'preview');
assert.equal(gateway.createCalls, 0);

const refreshed = await core.handle('user-a', '确认');
assert.equal(refreshed.kind, 'preview');
assert.match(refreshed.text, /价格或取餐方式有变化/);
assert.equal(gateway.createCalls, 0);

const placed = await core.handle('user-a', '确认');
assert.equal(placed.kind, 'placed');
assert.equal(gateway.createCalls, 1);

const cart: Cart = {
  scene: 'delivery',
  store,
  addressId: 'address-a',
  takeWayCode: 'delivery',
  items: [{ productCode: 'synthetic-big-mac', name: '巨无霸', quantity: 1, menuPriceCents: 1800 }],
  needTableware: false,
};
assert.notEqual(cartFingerprint(cart), cartFingerprint({ ...cart, addressId: 'address-b' }));
assert.notEqual(cartFingerprint(cart), cartFingerprint({ ...cart, takeWayCode: 'delivery-other' }));

console.log('S10-A5 PASS');
