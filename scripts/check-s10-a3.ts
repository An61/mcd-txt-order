import { strict as assert } from 'node:assert';
import { ConversationCore } from '../src/channel/core.ts';
import { SessionStore } from '../src/domain/session.ts';
import type { FavoritesConfig } from '../src/domain/favorites.ts';
import type {
  Cart,
  Menu,
  OrderResult,
  PriceBreakdown,
  Store,
} from '../src/domain/types.ts';
import type { DataGateway, StoreQuery, MenuQuery, MealDetailQuery, CreateOrderInput } from '../src/mcp/gateway.ts';
import type { ProviderAddress } from '../src/domain/addressBook.ts';

const stores: readonly Store[] = [
  { code: 'synthetic-store-east', name: '示例星河东店', city: '示例市', open: true },
  { code: 'synthetic-store-west', name: '示例星河西店', city: '示例市', open: true },
];

const menu: Menu = {
  storeCode: stores[0]!.code,
  categories: [],
  items: [
    { code: 'meal-big-mac', name: '巨无霸', priceCents: 1800, originalPriceCents: 1800, tags: [], categories: [] },
    { code: 'meal-cola-large', name: '可乐大杯', priceCents: 900, originalPriceCents: 900, tags: [], categories: [] },
    { code: 'meal-cola-medium', name: '可乐中杯', priceCents: 700, originalPriceCents: 700, tags: [], categories: [] },
  ],
};

class CandidateGateway implements DataGateway {
  readonly mode = 'sample' as const;
  createCalls = 0;
  readCalls = 0;

  describe(): string { return 'synthetic S10-A3 gateway'; }

  async listStores(_query: StoreQuery): Promise<Store[]> {
    this.readCalls += 1;
    return [...stores];
  }

  async getMenu(_query: MenuQuery): Promise<Menu> {
    this.readCalls += 1;
    return menu;
  }

  async getMealDetail(_query: MealDetailQuery): Promise<undefined> { return undefined; }

  async calculatePrice(cart: Cart): Promise<PriceBreakdown> {
    this.readCalls += 1;
    const originalCents = cart.items.reduce((sum, item) => sum + item.menuPriceCents * item.quantity, 0);
    return {
      originalCents,
      discountCents: 0,
      payableCents: originalCents,
      lines: cart.items.map((item) => ({
        productCode: item.productCode,
        productName: item.name,
        quantity: item.quantity,
        originalSubtotalCents: item.menuPriceCents * item.quantity,
        subtotalCents: item.menuPriceCents * item.quantity,
      })),
      takeWays: [{ code: 'take-in-store', title: '外带' }],
    };
  }

  async createOrder(_input: CreateOrderInput): Promise<OrderResult> {
    this.createCalls += 1;
    return { orderId: 'synthetic-order', payUrl: 'https://example.invalid/synthetic-pay' };
  }

  async cancelOrder(_orderId: string, _reasonCode: string): Promise<boolean> { return true; }

  async listDeliveryAddresses(): Promise<ProviderAddress[]> { return []; }
}

const favorites: FavoritesConfig = {
  version: 1,
  stores: [{ alias: ['星河'], name: '示例星河餐厅', city: '示例市' }],
  meals: [],
  combos: [],
  rules: { defaultScene: 'pickup', defaultCity: '示例市' },
};

const gateway = new CandidateGateway();
const core = new ConversationCore({ gateway, favorites });

const first = await core.handle('user-a', '可乐 星河');
assert.equal(first.kind, 'clarify');
assert.match(first.text, /1\. 示例星河东店/);
assert.match(first.text, /2\. 示例星河西店/);
assert.equal(gateway.createCalls, 0);

const invalid = await core.handle('user-a', '9');
assert.equal(invalid.kind, 'clarify');
assert.match(invalid.text, /1~2/);
assert.equal(gateway.createCalls, 0);

const crossUser = await core.handle('user-b', '1');
assert.notEqual(crossUser.kind, 'preview');
assert.equal(gateway.createCalls, 0);

const selectedStore = await core.handle('user-a', '1');
assert.equal(selectedStore.kind, 'clarify');
assert.match(selectedStore.text, /可乐大杯/);
assert.match(selectedStore.text, /可乐中杯/);
assert.equal(gateway.createCalls, 0);

const invalidMeal = await core.handle('user-a', '9');
assert.equal(invalidMeal.kind, 'clarify');
assert.match(invalidMeal.text, /1~2/);
assert.equal(gateway.createCalls, 0);

const selectedMeal = await core.handle('user-a', '2');
assert.equal(selectedMeal.kind, 'preview');
assert.match(selectedMeal.text, /示例星河东店/);
assert.match(selectedMeal.text, /可乐中杯/);
assert.equal(gateway.createCalls, 0);

// The first selection was consumed. A repeated digit cannot select again or write an order.
const repeated = await core.handle('user-a', '2');
assert.equal(gateway.createCalls, 0);
assert.notEqual(repeated.kind, 'placed');

let now = 1_000;
const sessions = new SessionStore({ ttlMs: 100, now: () => now });
const clarification = sessions.toClarifying('ttl-user', {
  rawText: '可乐 星河',
  specs: [],
  candidates: [{ label: '门店', value: 'synthetic-store-east' }],
  candidateKind: 'store',
});
assert.equal(clarification.ok, true);
const snapshotId = clarification.ok ? clarification.session.draft?.candidateSnapshotId : undefined;
assert.equal(typeof snapshotId, 'string');
now += 101;
const expired = sessions.consumeCandidate('ttl-user', snapshotId!, 1);
assert.equal(expired.ok, false);
if (!expired.ok) assert.equal(expired.error, 'candidate-expired');
assert.equal(sessions.get('ttl-user').state, 'idle');

const oneShot = new SessionStore();
const oneShotTransition = oneShot.toClarifying('one-shot-user', {
  rawText: '可乐 星河',
  specs: [],
  candidates: [{ label: '门店', value: 'synthetic-store-east' }],
  candidateKind: 'store',
});
assert.equal(oneShotTransition.ok, true);
const oneShotId = oneShotTransition.ok ? oneShotTransition.session.draft?.candidateSnapshotId : undefined;
assert.equal(oneShot.consumeCandidate('one-shot-user', oneShotId!, 1).ok, true);
assert.equal(oneShot.consumeCandidate('one-shot-user', oneShotId!, 1).ok, false);

console.log('S10-A3 PASS');
