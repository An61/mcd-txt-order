/**
 * M2 安全与会话自检 —— 逐条核对 T10~T13 的验收标准与 SEC-1~SEC-7。
 *
 * 用法：node --experimental-strip-types scripts/check-m2.ts
 * 全部离线运行，**不发任何网络请求、不触碰 create-order**。
 *
 * 这一份脚本的重点不是"功能对不对"，而是"钱会不会被误花掉"：
 * 凡是涉及重复下单、令牌重放、失败重试的分支，都必须在这里被跑过一遍。
 */

import {
  ConfirmationService,
  DEFAULT_CONFIRMATION_POLICY,
} from '../src/safety/confirmation.ts';
import {
  OrderGuard,
  DEFAULT_GUARD_POLICY,
  type GuardPolicy,
} from '../src/safety/guard.ts';
import {
  SessionStore,
  canPlaceOrder,
  describeState,
  publicizeOrder,
} from '../src/domain/session.ts';
import {
  classifyIntent,
  isStrongConfirmation,
  readPickIndex,
  type IntentContext,
} from '../src/domain/intent.ts';
import { cartFingerprint } from '../src/mcp/normalize.ts';
import { SAMPLE_STORES } from '../src/data/sample.ts';
import type { Cart, OrderPreview, PriceBreakdown, TakeWay } from '../src/domain/types.ts';

let passed = 0;
let failed = 0;

function check(title: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${title}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${title}  ${detail}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ─────────────────────────────────────────────────────────────
// 测试夹具
// ─────────────────────────────────────────────────────────────

const STORE = SAMPLE_STORES[0]!;

function makeCart(overrides: Partial<Cart> = {}): Cart {
  return {
    scene: 'pickup',
    store: STORE,
    needTableware: false,
    items: [
      { productCode: '1100', name: '巨无霸', quantity: 2, menuPriceCents: 2650 },
      { productCode: '3301', name: '可乐', quantity: 1, menuPriceCents: 900 },
    ],
    ...overrides,
  };
}

function makePreview(cart: Cart = makeCart(), payableCents = 6200): OrderPreview {
  const takeWay: TakeWay = { code: '1', title: '堂食' };
  const price: PriceBreakdown = {
    originalCents: 6200,
    discountCents: 0,
    payableCents,
    lines: [],
    takeWays: [takeWay],
  };
  return { cart, takeWay, price, fingerprint: cartFingerprint(cart) };
}

const MINUTE = 60 * 1000;

// ═════════════════════════════════════════════════════════════
section('T10 一次性确认令牌（SEC-2 / SEC-5）');

{
  const service = new ConfirmationService({ policy: { ttlMs: 5 * MINUTE, maxPendingPerUser: 3 } });
  const cart = makeCart();
  const fp = cartFingerprint(cart);

  const ticket = service.issue({ userId: 'u1', cart });
  check('签发令牌并绑定购物车指纹', ticket.fingerprint === fp, ticket.token.slice(0, 18) + '…');
  check('令牌带有效期而非永久', ticket.expiresAtMs > ticket.issuedAtMs);

  const first = service.consume(ticket.token, 'u1', fp);
  check('首次确认通过', first.ok === true);

  const second = service.consume(ticket.token, 'u1', fp);
  check(
    '二次确认被拒（一次性，SEC-2）',
    second.ok === false && second.reason === 'consumed',
    second.ok ? '' : second.reason,
  );

  const other = service.issue({ userId: 'u1', cart });
  const crossUser = service.consume(other.token, 'u2', fp);
  check(
    '别人的令牌不能用（SEC-5 只付给本人）',
    crossUser.ok === false && crossUser.reason === 'wrong-user',
    crossUser.ok ? '' : crossUser.reason,
  );
}

{
  let clock = 1_000_000;
  const service = new ConfirmationService({
    policy: { ttlMs: 60_000, maxPendingPerUser: 3 },
    now: () => clock,
  });
  const cart = makeCart();
  const ticket = service.issue({ userId: 'u1', cart });

  clock += 59_000;
  check('TTL 内仍有效', service.peek(ticket.token, 'u1').ok === true);

  clock += 2_000;
  const expired = service.consume(ticket.token, 'u1');
  check(
    '超过 TTL 失效（FR-12 预览卡片超时）',
    expired.ok === false && expired.reason === 'expired',
    expired.ok ? '' : expired.message,
  );
}

{
  const service = new ConfirmationService({ policy: { ttlMs: 5 * MINUTE, maxPendingPerUser: 3 } });
  const cartA = makeCart();
  const ticketA = service.issue({ userId: 'u1', cart: cartA });

  const cartB = makeCart({
    items: [{ productCode: '1100', name: '巨无霸', quantity: 1, menuPriceCents: 2650 }],
  });
  const swapped = service.consume(ticketA.token, 'u1', cartFingerprint(cartB));
  check(
    '换了购物车就不能用旧令牌',
    swapped.ok === false && swapped.reason === 'fingerprint-mismatch',
    swapped.ok ? '' : swapped.reason,
  );

  const tampered = service.issue({ userId: 'u1', cart: cartA });
  const [nonce] = tampered.token.split('.');
  const forged = service.consume(`${nonce}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, 'u1');
  check('签名被篡改时拒绝', forged.ok === false, forged.ok ? '' : forged.reason);
}

{
  const service = new ConfirmationService({ policy: { ttlMs: 5 * MINUTE, maxPendingPerUser: 2 } });
  const cartA = makeCart();
  const cartB = makeCart({
    items: [{ productCode: '3301', name: '可乐', quantity: 1, menuPriceCents: 900 }],
  });

  const ticketA = service.issue({ userId: 'u1', cart: cartA });
  service.issue({ userId: 'u1', cart: cartB });
  check(
    '不同购物车的令牌互不影响',
    service.pendingCount('u1') === 2 &&
      service.peek(ticketA.token, 'u1', cartFingerprint(cartA)).ok === true,
    String(service.pendingCount('u1')),
  );

  // 同一份购物车重复签发 → 只有最新那张还能用
  const again = service.issue({ userId: 'u1', cart: cartA });
  check(
    '重复签发同一份购物作废旧令牌（防按旧记录误付）',
    service.consume(ticketA.token, 'u1', cartFingerprint(cartA)).ok === false &&
      service.consume(again.token, 'u1', cartFingerprint(cartA)).ok === true,
  );

  const revoked = service.revokeUser('u1');
  check('取消时可整批作废', revoked >= 1 && service.pendingCount('u1') === 0, `revoked=${revoked}`);
}

check('默认策略 TTL 为 5 分钟', DEFAULT_CONFIRMATION_POLICY.ttlMs === 5 * MINUTE);

// ═════════════════════════════════════════════════════════════
section('T11 幂等 / 冷却 / 限额（SEC-3 / SEC-4 / SEC-6 / SEC-7）');

function guardWith(policy: Partial<GuardPolicy>, start = 1_000_000): { guard: OrderGuard; cart: Cart } {
  const guard = new OrderGuard({
    policy: { ...DEFAULT_GUARD_POLICY, ...policy },
    now: () => start,
  });
  return { guard, cart: makeCart() };
}

{
  // 微信重发同一条「确认」最多 4 次 —— 只能下一单（FR-24 + SEC-3）
  const { guard, cart } = guardWith({});
  const evaluation = guard.evaluate({ userId: 'u1', cart, payableCents: 6200 });
  check('首次判定通过', evaluation.kind === 'allowed');

  const first = guard.begin({ userId: 'u1', cart, payableCents: 6200 });
  check('第一次抢到执行权', first.acquired === true);

  const second = guard.begin({ userId: 'u1', cart, payableCents: 6200 });
  check(
    '并发重复被拦（幂等）',
    second.acquired === false &&
      second.verdict.kind === 'blocked' &&
      second.verdict.reason === 'duplicate-pending',
    second.verdict.kind === 'blocked' ? second.verdict.reason : '',
  );

  guard.succeed('u1', cart, 'ORD-1', 6200);
  const third = guard.begin({ userId: 'u1', cart, payableCents: 6200 });
  check(
    '成功后重复确认被拦并回带原单号',
    third.acquired === false &&
      third.verdict.kind === 'blocked' &&
      third.verdict.reason === 'duplicate-settled' &&
      third.verdict.existingOrderId === 'ORD-1',
    third.verdict.kind === 'blocked' ? third.verdict.existingOrderId ?? third.verdict.reason : '',
  );
}

{
  // SEC-6：失败不允许自动重试
  const { guard, cart } = guardWith({});
  guard.begin({ userId: 'u1', cart, payableCents: 6200 });
  guard.fail('u1', cart);

  const retry = guard.evaluate({ userId: 'u1', cart, payableCents: 6200 });
  check(
    '失败后不允许重试（SEC-6）',
    retry.kind === 'blocked' && retry.reason === 'duplicate-settled',
    retry.kind === 'blocked' ? retry.message : '',
  );
}

{
  // 冷却
  let clock = 1_000_000;
  const guard = new OrderGuard({ policy: { ...DEFAULT_GUARD_POLICY, cooldownMs: 60_000 }, now: () => clock });
  const cartA = makeCart();
  guard.begin({ userId: 'u1', cart: cartA, payableCents: 6200 });
  guard.succeed('u1', cartA, 'ORD-1', 6200);

  clock += 10_000;
  const cartB = makeCart({
    items: [{ productCode: '3301', name: '可乐', quantity: 1, menuPriceCents: 900 }],
  });
  const tooSoon = guard.evaluate({ userId: 'u1', cart: cartB, payableCents: 900 });
  check(
    '冷却期内拒绝（防手滑连发）',
    tooSoon.kind === 'blocked' && tooSoon.reason === 'cooldown',
    tooSoon.kind === 'blocked' ? `还需 ${Math.ceil((tooSoon.retryAfterMs ?? 0) / 1000)}s` : '',
  );

  clock += 60_000;
  const later = guard.evaluate({ userId: 'u1', cart: cartB, payableCents: 900 });
  check('冷却结束后放行', later.kind === 'allowed');

  const other = guard.evaluate({ userId: 'u2', cart: cartB, payableCents: 900 });
  check('冷却按用户隔离', other.kind === 'allowed');
}

{
  // 单笔金额上限
  const { guard, cart } = guardWith({ maxCentsPerOrder: 20_000 });
  const tooBig = guard.evaluate({ userId: 'u1', cart, payableCents: 25_000 });
  check(
    '超过单笔上限被拦（SEC-4）',
    tooBig.kind === 'blocked' && tooBig.reason === 'order-amount-limit',
    tooBig.kind === 'blocked' ? tooBig.message : '',
  );
}

{
  // FR-15：区间内的较大金额要求强化二次确认，但不直接拦截
  const { guard, cart } = guardWith({ strongConfirmAboveCents: 10_000, strongConfirmed: false });
  const needs = guard.evaluate({ userId: 'u1', cart, payableCents: 12_000 });
  check(
    '超阈值要求强化确认（FR-15）',
    needs.kind === 'needs-strong-confirm',
    needs.kind === 'needs-strong-confirm' ? needs.message : '',
  );

  const reaffirmed = guard.evaluate({
    userId: 'u1',
    cart,
    payableCents: 12_000,
    strongConfirmed: true,
  });
  check('强化确认后放行', reaffirmed.kind === 'allowed');

  const small = guard.evaluate({ userId: 'u2', cart, payableCents: 5_000 });
  check('小额不需要强化确认', small.kind === 'allowed');
}

{
  // 每小时次数上限
  let clock = 1_000_000;
  const policy: GuardPolicy = { ...DEFAULT_GUARD_POLICY, maxPerHour: 2, cooldownMs: 0 };
  const guard = new OrderGuard({ policy, now: () => clock });

  for (let i = 1; i <= 2; i += 1) {
    const cart = makeCart({
      items: [
        { productCode: '3301', name: '可乐', quantity: i, menuPriceCents: 900 },
      ],
    });
    guard.begin({ userId: 'u1', cart, payableCents: 900 * i });
    guard.succeed('u1', cart, `ORD-${i}`, 900 * i);
  }

  const cartC = makeCart({
    items: [{ productCode: '3301', name: '可乐', quantity: 3, menuPriceCents: 900 }],
  });
  const limited = guard.evaluate({ userId: 'u1', cart: cartC, payableCents: 2700 });
  check(
    '每小时次数超限时被拦',
    limited.kind === 'blocked' && limited.reason === 'hourly-limit',
    limited.kind === 'blocked' ? limited.message : '',
  );

  clock += 61 * MINUTE;
  const nextHour = guard.evaluate({ userId: 'u1', cart: cartC, payableCents: 2700 });
  check('跨小时后恢复', nextHour.kind === 'allowed');
}

{
  // 每天累计金额上限
  const { guard, cart } = guardWith({ maxCentsPerDay: 10_000, cooldownMs: 0 });
  const first = makeCart({
    items: [{ productCode: '3301', name: '可乐', quantity: 1, menuPriceCents: 900 }],
  });
  guard.begin({ userId: 'u1', cart: first, payableCents: 9_000 });
  guard.succeed('u1', first, 'ORD-1', 9_000);

  const second = makeCart({
    items: [{ productCode: '3301', name: '可乐', quantity: 2, menuPriceCents: 900 }],
  });
  const overDaily = guard.evaluate({ userId: 'u1', cart: second, payableCents: 3_000 });
  check(
    '每天累计金额超限时被拦',
    overDaily.kind === 'blocked' && overDaily.reason === 'daily-amount-limit',
    overDaily.kind === 'blocked' ? overDaily.message : '',
  );
}

{
  // SEC-7：401 立刻冻结
  const { guard, cart } = guardWith({});
  const before = guard.evaluate({ userId: 'u1', cart, payableCents: 6200 });
  check('冻结前可下单', before.kind === 'allowed');

  guard.markAuthFailed('u1');
  const after = guard.evaluate({ userId: 'u1', cart, payableCents: 6200 });
  check(
    '401 后立刻停止一切写操作（SEC-7）',
    after.kind === 'blocked' && after.reason === 'auth-failed',
    after.kind === 'blocked' ? after.message : '',
  );

  const untouched = guard.evaluate({ userId: 'u2', cart, payableCents: 6200 });
  check('冻结按用户隔离', untouched.kind === 'allowed');

  guard.clearAuthFailed('u1');
  const recovered = guard.evaluate({ userId: 'u1', cart, payableCents: 6200 });
  check('重新拿到 Token 后解冻', recovered.kind === 'allowed');
}

// ═════════════════════════════════════════════════════════════
section('T12 会话状态机（FR-17 / FR-18）');

{
  const store = new SessionStore({ ttlMs: 10 * MINUTE, previewTtlMs: 5 * MINUTE });
  const preview = makePreview();

  const idle = store.get('u1');
  check('新会话是空闲态', idle.state === 'idle');
  check('空闲态不允许下单', canPlaceOrder(idle) === false);

  const toClarifying = store.toClarifying('u1', { rawText: '麦辣', specs: [] });
  check('进入待澄清', toClarifying.ok === true && toClarifying.session.state === 'clarifying');
  check('澄清态不允许下单', canPlaceOrder(store.get('u1')) === false);

  const illegalPlace = store.toPlaced('u1', 'ORD-1');
  check(
    '待澄清不能直接跳到已下单（SEC-1 机器级保证）',
    illegalPlace.ok === false && illegalPlace.error === 'illegal-transition',
    illegalPlace.ok ? '' : illegalPlace.message,
  );

  const toConfirming = store.toConfirming('u1', preview);
  check('进入待确认', toConfirming.ok === true && toConfirming.session.state === 'confirming');
  check('待确认且带预览才允许下单', canPlaceOrder(store.get('u1')) === true);

  const confirmingTtl = store.get('u1').expiresAtMs - store.get('u1').updatedAtMs;
  check('待确认态用更短的 TTL（预览超时）', confirmingTtl === 5 * MINUTE);

  const toPlaced = store.toPlaced('u1', 'ORD-1', STORE.code);
  check('确认后进入已下单', toPlaced.ok === true && toPlaced.session.state === 'placed');
  check('已下单后购物车被清空，无法再次确认', canPlaceOrder(store.get('u1')) === false);
  check('记住上次门店，方便“再来一份”', store.get('u1').lastStoreCode === STORE.code);

  const backToIdle = store.toIdle('u1');
  check('可回到空闲态', backToIdle.ok === true && backToIdle.session.state === 'idle');
}

{
  let clock = 1_000_000;
  const store = new SessionStore({ ttlMs: 10 * MINUTE, previewTtlMs: 5 * MINUTE, now: () => clock });
  const preview = makePreview();

  store.toConfirming('u1', preview);
  check('下单前预览在', store.get('u1').preview !== undefined);

  clock += 6 * MINUTE;
  const expired = store.get('u1');
  check('预览超时后自动回到空闲（FR-12 / FR-18）', expired.state === 'idle');
  check('超时后购物车被丢弃', expired.preview === undefined && expired.cart === undefined);
  check('超时后不可能再下出单', canPlaceOrder(expired) === false);
}

{
  const store = new SessionStore({ ttlMs: 10 * MINUTE, previewTtlMs: 5 * MINUTE });
  store.patch('u1', { draft: { rawText: '巨无霸', specs: [] } });
  const touched = store.touch('u1');
  check('发言可续期', touched.expiresAtMs > touched.updatedAtMs);
  store.reset('u1');
  check('重置后清空草稿', store.get('u1').draft === undefined && store.get('u1').state === 'idle');
  check('状态中文名可读', describeState('confirming') === '待确认');
}

check(
  '订单结果脱敏后才落盘/进日志（SEC-5）',
  (() => {
    const view = publicizeOrder({
      orderId: 'ORD-1',
      payUrl: 'https://pay.example/real-url',
    });
    return view.orderId === 'ORD-1' && view.hasPayUrl === true && !('payUrl' in view);
  })(),
);

// ═════════════════════════════════════════════════════════════
section('T13 意图识别（FR-2 / FR-4）');

function kindOf(text: string, ctx: Partial<IntentContext> = {}): string {
  return classifyIntent(text, { state: 'idle', ...ctx }).kind;
}

check('「巨无霸 香梅北」识别为下单', kindOf('巨无霸 香梅北') === 'order');
check('「两个巨无霸一杯可乐」识别为下单', kindOf('两个巨无霸一杯可乐') === 'order');
check(
  '「巨无霸不要酸黄瓜」识别为下单而非取消',
  kindOf('巨无霸不要酸黄瓜') === 'order',
  classifyIntent('巨无霸不要酸黄瓜', { state: 'idle' }).matchedRule,
);
check('「不要酸黄瓜」也不是取消', kindOf('不要酸黄瓜') === 'order');
check('「少冰多酱」不是取消', kindOf('少冰多酱') === 'order');

check('「算了」是取消', kindOf('算了', { state: 'confirming' }) === 'cancel');
check('「取消订单」是取消', kindOf('取消订单') === 'cancel');
check('「不要了」是取消', kindOf('不要了', { state: 'clarifying' }) === 'cancel');
check('「取消我刚才那个巨无霸」是取消', kindOf('取消我刚才那个巨无霸') === 'cancel');

check('待确认态的「确认」是确认', kindOf('确认', { state: 'confirming' }) === 'confirm');
check('待确认态的「OK」是确认', kindOf('ok', { state: 'confirming' }) === 'confirm');
check(
  '待确认态重复原话视为确认',
  kindOf('巨无霸 香梅北', { state: 'confirming', draftRawText: '巨无霸 香梅北' }) === 'confirm',
);
const strayConfirm = classifyIntent('好的', { state: 'idle' });
check(
  '空闲态的「好的」虽判为确认但不指向任何订单',
  strayConfirm.kind === 'confirm' && canPlaceOrder({ userId: 'u', state: 'idle', updatedAtMs: 0, expiresAtMs: 0, turnCount: 0 }) === false,
  strayConfirm.matchedRule,
);

check('澄清态的「1」是选候选', kindOf('1', { state: 'clarifying', candidateCount: 3 }) === 'pickCandidate');
check(
  '「第一个」取到下标 1',
  (() => {
    const intent = classifyIntent('第一个', { state: 'clarifying' });
    return intent.kind === 'pickCandidate' && intent.pickIndex === 1;
  })(),
);
check('「第二个」取到下标 2', readPickIndex('第二个', '第二个') === 2);
check('非澄清态的「1」不当候选', kindOf('1') === 'order');
check('「1份巨无霸」不会被当成选候选', kindOf('1份巨无霸') === 'order');

check('「默认门店改成香梅北」是改配置', kindOf('默认门店改成香梅北') === 'config');
check('「切换门店」是改配置', kindOf('切换门店') === 'config');

check('「附近门店」是查询', kindOf('附近门店') === 'query');
check('「巨无霸多少钱」是查询', kindOf('巨无霸多少钱') === 'query');
check('「有哪些优惠券」是查询', kindOf('有哪些优惠券') === 'query');
check('「我的订单」是查询', kindOf('我的订单') === 'query');

check('「帮助」是帮助', kindOf('帮助') === 'help');
check('「怎么用」是帮助', kindOf('怎么用') === 'help');
check('空消息是帮助', kindOf('   ') === 'help');

const unparsable = classifyIntent('asdfghjkl', { state: 'idle' });
check(
  '认不出来时默认走下单但不写操作（FR-4）',
  unparsable.kind === 'order' && unparsable.confidence < 0.7,
  `confidence=${unparsable.confidence}`,
);

check('强化确认词「确认」通过', isStrongConfirmation('确认') === true);
check('强化确认词「我确认」通过', isStrongConfirmation('我确认') === true);
check('普通答复「好的」不通过强化确认', isStrongConfirmation('好的') === false);

// ═════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`M2 自检：通过 ${passed} 项，失败 ${failed} 项`);
console.log('═'.repeat(50));

if (failed > 0) process.exitCode = 1;
