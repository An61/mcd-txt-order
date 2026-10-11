import assert from 'node:assert/strict';
import {
  parseSearchOrder,
  type NamedSearchOrderInput,
} from '../src/domain/searchOrder.ts';

function named(input: string): NamedSearchOrderInput {
  const parsed = parseSearchOrder(input);
  assert.equal(parsed.kind, 'named', `expected named input: ${input}`);
  return parsed;
}

const first = named('巨无霸套餐 堂食 星河餐厅');
assert.equal(first.status, 'ready');
assert.equal(first.mode, 'dineIn');
assert.equal(first.mealQuery, '巨无霸套餐');
assert.equal(first.storeQuery, '星河餐厅');

const reversed = named('星河餐厅 得来速 巨无霸套餐');
assert.equal(reversed.status, 'ready');
assert.equal(reversed.mode, 'driveThrough');
assert.equal(reversed.mealQuery, '巨无霸套餐');
assert.equal(reversed.storeQuery, '星河餐厅');

const delivery = named('公司 外卖 巨无霸不要酸黄瓜');
assert.equal(delivery.status, 'ready');
assert.equal(delivery.mode, 'delivery');
assert.equal(delivery.mealQuery, '巨无霸');
assert.equal(delivery.addressReference, '公司');
assert.equal(delivery.modifierText, '不要酸黄瓜');

const explicit = named('餐厅:星河餐厅 堂食 餐品:巨无霸');
assert.equal(explicit.status, 'ready');
assert.equal(explicit.storeQuery, '星河餐厅');
assert.equal(explicit.mealQuery, '巨无霸');

const labeledExtra = named('餐品:巨无霸 餐厅:星河餐厅 其他 堂食');
assert.equal(labeledExtra.status, 'needs-resolution');
assert.equal(labeledExtra.storeQuery, '星河餐厅');
assert.deepEqual(labeledExtra.unresolvedParts, ['其他']);

const legacy = parseSearchOrder('2堂食b');
assert.equal(legacy.kind, 'legacy');
if (legacy.kind === 'legacy') {
  assert.equal(legacy.mealSlot, '2');
  assert.equal(legacy.placeSlot, 'b');
}

const missingMode = named('巨无霸 星河餐厅');
assert.equal(missingMode.status, 'needs-input');
assert.deepEqual(missingMode.missingFields, ['mode']);

const ambiguous = named('汉堡 甜筒 堂食');
assert.equal(ambiguous.status, 'needs-resolution');
assert.ok(ambiguous.unresolvedParts.length > 0);
assert.equal(ambiguous.mealQuery, undefined);
assert.equal(ambiguous.storeQuery, undefined);

const empty = parseSearchOrder('   ');
assert.equal(empty.kind, 'invalid');
assert.equal(empty.status, 'invalid');

console.log('S10-A1 PASS: named input, order-insensitive mode, modifiers, legacy slots, and safe ambiguity states');
