/**
 * M3 编排自检 —— 逐条核对 T14~T18 / T19 的验收标准。
 *
 * 用法：node --experimental-strip-types scripts/check-m3.ts
 *
 * 设计要点：
 *  - **没有 Token 也能跑**：此时自动使用离线快照，验证编排逻辑本身。
 *  - **有 Token 时额外验证真实链路**：门店检索 → 菜单 → 详情 → 算价，**全程只读**，
 *    绝不触碰 create-order。`payableCents > 0` 与 `takeWayCode` 非空是关键断言 ——
 *    这两项是 T15 / T16 的硬验收点，也是整条链路最容易悄悄坏掉的地方。
 */

import { loadDotEnv } from '../src/env.ts';
import { createGateway, SampleGateway, RealGateway, GatewayError } from '../src/mcp/gateway.ts';
import { ConversationCore } from '../src/channel/core.ts';
import { loadFavorites, defaultCity } from '../src/domain/favorites.ts';
import { buildPreview, renderPreview } from '../src/domain/orderFlow.ts';
import { getScene, hasPrice, money, type SceneKey } from '../src/domain/types.ts';

loadDotEnv();

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

const HAS_TOKEN = Boolean(process.env.MCD_MCP_TOKEN?.trim());
const favorites = loadFavorites().config;

// ═════════════════════════════════════════════════════════════
section('T14 真实 / Mock 双网关，且不静默降级');

{
  const sampleBundle = createGateway('sample');
  check('--sample 得到示例网关', sampleBundle.gateway instanceof SampleGateway);
  check('示例网关明确标注为演示模式', sampleBundle.gateway.describe().includes('演示'));

  let threw = false;
  try {
    createGateway('real');
  } catch (error) {
    threw = error instanceof GatewayError;
  }

  if (HAS_TOKEN) {
    check('有 Token 时 --real 成功且不降级', !threw);
    check('有 Token 时 auto 走真实网关', createGateway('auto').gateway instanceof RealGateway);
  } else {
    const autoNoToken = createGateway('auto');
    check(
      '无 Token 时 auto 落到演示模式且说明理由（不静默）',
      autoNoToken.gateway.mode === 'sample' && autoNoToken.reason.includes('演示模式'),
      autoNoToken.reason.slice(0, 40),
    );
    check('无 Token 时 --real 明确报错，不悄悄降级', threw);
  }
}

{
  // 演示模式下算价必须给出 takeWay，否则 FR-16 的无 muggle 保护无从谈起
  const gateway = new SampleGateway();
  const price = await gateway.calculatePrice({
    scene: 'pickup',
    store: { code: '1420602', name: '麦当劳深圳香梅北餐厅' },
    items: [{ productCode: '1100', name: '巨无霸', quantity: 1, menuPriceCents: 2650 }],
    needTableware: false,
  });
  check('示例网关产出的算价含取餐方式', price.takeWays.length > 0, price.takeWays[0]?.title ?? '');
}

// ═════════════════════════════════════════════════════════════
section('T15 检索 → 菜单 → 算价：离线编排');

async function previewWith(gateway: ReturnType<typeof createGateway>['gateway'], rawText: string) {
  return buildPreview({
    gateway,
    favorites,
    rawText,
    scene: (favorites.rules.defaultScene ?? 'pickup') as SceneKey,
  });
}

{
  const result = await previewWith(new SampleGateway(), '巨无霸不要酸黄瓜 香梅北');
  if (!result.ok) {
    check('离线编排产出预览', false, `${result.reason}: ${result.message}`);
  } else {
    check('离线编排产出预览', true, `${result.elapsedMs}ms`);
    check('门店按别名命中到了官方名称', result.preview.cart.store.name === '麦当劳深圳香梅北餐厅',
      result.preview.cart.store.name);
    check('餐品命中巨无霸', result.preview.cart.items[0]?.name === '巨无霸');
    check('特制被解析出来', result.preview.cart.items[0]?.specText === '不要酸黄瓜',
      String(result.preview.cart.items[0]?.specText));
    check(
      '产出购物车指纹（幂等的基础），且长度足够抗碰撞',
      result.preview.fingerprint.length >= 12,
      `${result.preview.fingerprint.length} 字符`,
    );
    const again = await previewWith(new SampleGateway(), '巨无霸不要酸黄瓜 香梅北');
    check(
      '同一购物车两次建预览指纹一致（幂等可依赖）',
      again.ok && again.preview.fingerprint === result.preview.fingerprint,
    );
    check('预览卡片可渲染', renderPreview(result.preview, result.notes).includes('应付'));
  }
}

{
  const result = await previewWith(new SampleGateway(), '两个巨无霸一杯可乐 香梅北');
  check(
    '多品与数量解析正确',
    result.ok &&
      result.preview.cart.items.length === 2 &&
      result.preview.cart.items[0]?.quantity === 2 &&
      result.preview.cart.items[1]?.quantity === 1,
    result.ok ? result.preview.cart.items.map((i) => `${i.name}×${i.quantity}`).join(', ') : result.message,
  );
}

{
  const result = await previewWith(new SampleGateway(), '仰望星空派 香梅北');
  check('不存在的餐品给出人话失败而非异常', !result.ok && result.reason === 'item-not-found',
    result.ok ? '' : result.message);
}

{
  const result = await previewWith(new SampleGateway(), '  ');
  check('空输入安全失败', !result.ok);
}

// ═════════════════════════════════════════════════════════════
section('T19 会话核心闭环（预览 → 确认 → 下单）');

{
  const core = new ConversationCore({ bundle: createGateway('sample') });

  const first = await core.handle('u1', '巨无霸 香梅北');
  check('首次发言产出预览卡片', first.kind === 'preview', first.kind);
  check('预览带演示模式标识（不误导用户）', first.text.includes('演示模式'));

  const second = await core.handle('u1', '确认');
  check('确认后下单成功', second.kind === 'placed' && Boolean(second.orderId), second.orderId ?? second.text);
  check('支付链接只在回复里给出', Boolean(second.payUrl) && second.text.includes('请勿转发'));

  // SEC-6/SEC-3：再确认一次不应产生第二单
  const third = await core.handle('u1', '确认');
  check(
    '重复确认不再下第二单（幂等）',
    third.kind !== 'placed',
    third.kind,
  );
}

{
  const core = new ConversationCore({ bundle: createGateway('sample') });
  await core.handle('u2', '巨无霸 香梅北');
  const cancelled = await core.handle('u2', '算了');
  check('取消走取消分支', cancelled.kind === 'cancelled', cancelled.text);

  const after = await core.handle('u2', '确认');
  check('取消后再确认不会下单', after.kind !== 'placed', after.text);
}

{
  const core = new ConversationCore({ bundle: createGateway('sample') });
  const idle = await core.handle('u3', '确认');
  check('空闲态下误按确认不会下单', idle.kind !== 'placed', idle.text);

  const help = await core.handle('u3', '帮助');
  check('帮助意图返回帮助', help.kind === 'help');
}

// ═════════════════════════════════════════════════════════════
section('T16 / T18 takeWayCode 与特制');

{
  check(
    '到店场景必须要求 takeWayCode',
    getScene('pickup').requiresTakeWayCode === true,
    '若此项为 false，create-order 会以缺参失败',
  );
  check('到店自提不传 beCode（传了反而报错）', getScene('pickup').requiresBeCode === false);
  check('得来速场景要求 beCode', getScene('driveThrough').requiresBeCode === true);
}

// ═════════════════════════════════════════════════════════════
if (HAS_TOKEN) {
  section('真实链路（只读）：门店 → 菜单 → 详情 → 算价');

  const real = createGateway('real');
  const city = defaultCity(favorites);
  check('已配置兜底城市', Boolean(city), city ?? '');

  try {
    const stores = await real.gateway.listStores({ scene: 'pickup', city, keyword: '香梅北' });
    check('真实门店检索有结果', stores.length > 0, `${stores.length} 家`);

    // 实测：keyword 不会真的按名称过滤，本地必须能挑出最像的那家
    const picked = stores.find((s) => s.name.includes('香梅北'));
    check('候选池里能找到目标门店', Boolean(picked), picked?.name ?? '未找到');

    if (picked) {
      const menu = await real.gateway.getMenu({ scene: 'pickup', storeCode: picked.code });
      check('真实菜单非空', menu.items.length > 0, `${menu.items.length} 项`);
      check('菜单项带价格', menu.items.filter(hasPrice).length > 0);

      const target = menu.items.find((item) => item.name.includes('巨无霸'));
      if (target) {
        const detail = await real.gateway.getMealDetail({
          scene: 'pickup',
          storeCode: picked.code,
          code: target.code,
        });
        check('真实餐品详情可取', Boolean(detail), `${target.name}(${target.code})`);

        const price = await real.gateway.calculatePrice({
          scene: 'pickup',
          store: picked,
          items: [
            { productCode: target.code, name: target.name, quantity: 1, menuPriceCents: target.priceCents },
          ],
          needTableware: false,
        });
        check('真实算价返回正金额', price.payableCents > 0, money(price.payableCents));
        check(
          'T16：takeWayCode 确实来自算价结果',
          price.takeWays.length > 0 && price.takeWays[0]!.code.length > 0,
          price.takeWays.map((t) => t.code).join(','),
        );
      }

      const flow = await previewWith(real.gateway, '巨无霸 香梅北');
      check(
        '端到端：真实网关也能产出预览',
        flow.ok && flow.preview.price.payableCents > 0,
        flow.ok ? money(flow.preview.price.payableCents) : flow.message,
      );
      if (flow.ok && flow.preview.cart.items[0]?.modifications?.length) {
        const modes = flow.preview.cart.items[0].modifications;
        check(
          'T18：特制 code 取自真实 query-meal-detail',
          modes.every((mod) => mod.code.length > 0 && mod.key.length > 0),
          JSON.stringify(modes[0]),
        );
      }
    }

    console.log('\n  ℹ️  create-order **未被调用** —— 真实下单只在用户显式确认且通过守卫后发生。');
  } catch (error) {
    check('真实链路连通', false, String(error instanceof Error ? error.message : error).slice(0, 160));
  }
} else {
  section('真实链路');
  console.log('  ℹ️  未检测到 MCD_MCP_TOKEN，跳过真实链路验证（离线断言已全部覆盖编排逻辑）。');
}

// ═════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(`M3 自检：通过 ${passed} 项，失败 ${failed} 项${HAS_TOKEN ? '（含真实链路）' : '（离线）'}`);
console.log('═'.repeat(50));

if (failed > 0) process.exitCode = 1;
