import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';
import {
  AddressBookError, AddressBookService, normalizeProviderAddressForQuery,
  type AddressBinding, type DeliveryAddressGateway, type ProviderAddress,
} from '../src/domain/addressBook.ts';
import { SqliteAddressBookStore } from '../src/safety/addressBookStore.ts';
import { RealGateway, SampleGateway } from '../src/mcp/gateway.ts';

const binding: AddressBinding = { userId: 'user-a', providerScope: 'mcd-account-a' };
const rows: ProviderAddress[] = [
  normalizeProviderAddressForQuery({ addressId: 'synthetic-1', contactName: '示例用户', phone: 'phone-a', fullAddress: '示例市示例区示例路1号' }),
  normalizeProviderAddressForQuery({ addressId: 'synthetic-2', contactName: '另一位用户', phone: 'phone-b', fullAddress: '示例市示例区示例路2号' }),
];
let currentRows = rows;
const gateway: DeliveryAddressGateway = {
  addressBinding: binding,
  async listDeliveryAddresses() { return currentRows; },
};
const root = mkdtempSync(join(tmpdir(), 'mcd-s10-a2-'));
const dbPath = join(root, 'addresses.db');
let clock = 1_000;
const store = new SqliteAddressBookStore(dbPath);
const service = new AddressBookService(store, binding, gateway, { ttlMs: 100, now: () => clock });
try {
  assert.throws(() => new AddressBookService(store, { userId: 'user-a', providerScope: 'other-provider' }, gateway), (error: unknown) => error instanceof AddressBookError && error.code === 'ADDRESS_SCOPE_MISMATCH');
  await assert.rejects(() => service.query(''), (error: unknown) => error instanceof AddressBookError && error.code === 'ADDRESS_QUERY_NEEDS_NARROWING');
  const result = await service.query('示例路1号');
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].label.includes('phone-a'), false);
  assert.equal(result.options[0].label.includes('示例用户'), false);
  assert.equal(result.options[0].label.includes('示例路1号'), false);
  const snapshotOptions = result.options as any;
  try { snapshotOptions[0].label = 'tampered'; } catch { /* frozen */ }
  assert.notEqual(result.options[0].label, 'tampered');
  const narrowed = await service.query('示例路1号');
  assert.equal(narrowed.options.length, 1);
  assert.match(narrowed.options[0].label, /示例市示例区示例路附近/);
  const saved = await service.selectAndSave(narrowed.snapshotId, 1, '家', true);
  assert.equal(saved.isDefault, true);
  const second = await service.query('示例路2号');
  await service.selectAndSave(second.snapshotId, 1, '公司', true);
  assert.equal(service.list().filter((entry) => entry.isDefault).length, 1);
  assert.equal(service.list().find((entry) => entry.alias === '公司')?.isDefault, true);
  assert.equal(service.list().find((entry) => entry.alias === '家')?.isDefault, false);
  assert.throws(() => store.setDefault(binding, 'missing'), (error: unknown) => error instanceof AddressBookError && error.code === 'ADDRESS_NOT_FOUND');
  assert.equal(service.list().find((entry) => entry.alias === '公司')?.isDefault, true);
  assert.equal(service.delete('synthetic-2'), true);
  assert.equal(service.list().length, 1);
  assert.equal(service.delete('synthetic-2'), false);
  const otherBinding = { userId: 'user-b', providerScope: 'mcd-account-a' };
  store.add({ ...otherBinding, addressId: 'synthetic-1', alias: '他人', makeDefault: true });
  assert.equal(store.list(otherBinding).length, 1);
  assert.equal(service.list().some((entry) => entry.userId === otherBinding.userId), false);
  store.close();
  const restarted = new SqliteAddressBookStore(dbPath);
  assert.equal(restarted.list(binding).length, 1);
  assert.equal(restarted.list(otherBinding).length, 1);
  restarted.close();
  const staleStore = new SqliteAddressBookStore(':memory:');
  const staleService = new AddressBookService(staleStore, binding, gateway, { ttlMs: 100, now: () => clock });
  const stale = await staleService.query('示例路1号');
  currentRows = [rows[1]];
  await assert.rejects(() => staleService.selectAndSave(stale.snapshotId, 1, '过期'), (error: unknown) => error instanceof AddressBookError && error.code === 'ADDRESS_PROVIDER_REFERENCE_STALE');
  currentRows = rows;
  const expiring = await staleService.query('示例路1号');
  clock = 2_000;
  await assert.rejects(() => staleService.selectAndSave(expiring.snapshotId, 1, '过期'), (error: unknown) => error instanceof AddressBookError && error.code === 'ADDRESS_SELECTION_EXPIRED');
  staleStore.close();
  const bytes = readFileSync(dbPath);
  assert.equal(bytes.includes(Buffer.from('phone-a')), false);
  assert.equal(bytes.includes(Buffer.from('示例市示例区示例路')), false);
  const sample = new SampleGateway(binding);
  assert.deepEqual((await sample.listDeliveryAddresses())[0].addressId, 'sample-address-1');
  assert.deepEqual(sample.addressBinding, binding);

  const chineseGateway: DeliveryAddressGateway = {
    addressBinding: binding,
    async listDeliveryAddresses() {
      return [normalizeProviderAddressForQuery({
        addressId: 'synthetic-chinese-number',
        contactName: '示例用户',
        phone: 'phone-c',
        fullAddress: '示例市示例区示例路一号',
      })];
    },
  };
  const chineseStore = new SqliteAddressBookStore(':memory:');
  const chineseService = new AddressBookService(chineseStore, binding, chineseGateway);
  const chineseResult = await chineseService.query('');
  assert.equal(chineseResult.options.length, 1);
  assert.equal(chineseResult.options[0].label.includes('示例路一号'), false);
  chineseStore.close();

  const nestedClient = {
    async callTool() {
      return {
        structuredContent: {
          success: true,
          data: {
            success: true,
            data: [{ addressId: 'synthetic-nested', contactName: '示例用户', phone: 'phone-d', fullAddress: '示例市示例区示例路2号' }],
          },
        },
      };
    },
  };
  const nestedGateway = new RealGateway(nestedClient as never, binding);
  const nestedAddresses = await nestedGateway.listDeliveryAddresses();
  assert.equal(nestedAddresses.length, 1);
  assert.equal(nestedAddresses[0].addressId, 'synthetic-nested');
  console.log('S10-A2 PASS');
} finally {
  try { store.close(); } catch { /* already closed */ }
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
}
