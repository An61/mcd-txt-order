import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const fixturePath = join(root, 'fixtures', 's10-scenarios.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  readonly version: number;
  readonly evidenceCeiling: string;
  readonly stores: readonly { readonly code: string; readonly name: string; readonly city: string }[];
  readonly addresses: readonly { readonly addressId: string; readonly alias: string; readonly providerScope: string }[];
  readonly cases: readonly string[];
};

assert.equal(fixture.version, 1);
assert.equal(fixture.evidenceCeiling, 'local-synthetic-only');
assert.ok(fixture.stores.length >= 2);
assert.ok(fixture.addresses.length >= 2);
assert.ok(fixture.cases.includes('delivery-address-required'));
assert.ok(fixture.cases.includes('price-change-reconfirmation'));
assert.ok(fixture.cases.includes('candidate-expiry'));
assert.ok(fixture.addresses.every((address) => /^synthetic-/.test(address.addressId)));
assert.ok(fixture.stores.every((store) => /^synthetic-/.test(store.code)));
assert.equal(JSON.stringify(fixture).includes('MCD_MCP_TOKEN'), false);
assert.equal(JSON.stringify(fixture).includes('pay.mcd.cn'), false);

const packageText = readFileSync(join(root, 'package.json'), 'utf8');
for (const script of ['check:s10:a3', 'check:s10:a4', 'check:s10:a5', 'check:s10:a6']) {
  assert.match(packageText, new RegExp(`\\"${script}\\"`));
}

const readme = readFileSync(join(root, 'README.md'), 'utf8');
assert.match(readme, /餐厅:星河餐厅/);
assert.match(readme, /外卖/);
assert.match(readme, /addressId/);

console.log('S10-A6 PASS');
