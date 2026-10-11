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
import { loadFavorites } from '../src/domain/favorites.ts';
import { buildPreview, renderPreview } from '../src/domain/orderFlow.ts';
import { getScene, hasPrice, money, type SceneKey } from '../src/domain/types.ts';

loadDotEnv();

let passed = 0;
let failed = 0;
/** 环境/时段导致的无法验证。它不是代码缺陷，因此不计入 failed、也不会阻断后续自检 */
let skipped = 0;

function check(title: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${title}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${title}  ${detail}`);
  }
}

/**
 * 记录「被测服务当前状态导致无法验证」的情形。
 *
 * 与 check(false) 的区别很关键：麦当劳菜单是时段性的（早餐时段没有巨无霸），
 * Token 会过期，网络会抖动。这些都不是本仓库的缺陷，若当成失败，
 * 一方面会谎报代码有问题，另一方面会让 `npm run check` 的 && 链断掉，
 * 导致 M4/M8/礼节检查这 147 项根本不执行 —— 那才是真正的风险。
 */
function skip(title: string, reason: string): void {
  skipped += 1;
  console.log(`  ⚠️  ${title}  ${reason}`);
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

/**
 * 判断异常属于「外部服务状态」还是「代码缺陷」。
 *
 * 凭据失效、网络不可达、响应超时都归前者 —— 重试或换时段就能恢复，
 * 记成代码失败只会污染信号并阻断后续自检。其余一律当真问题报红。
 */
function isEnvironmentalError(error: unknown): boolean {
  const candidate = error as {
    readonly httpStatus?: unknown;
    readonly authFailed?: unknown;
    readonly ambiguous?: unknown;
    readonly code?: unknown;
    readonly name?: unknown;
  };
  if (candidate.authFailed === true) return true;
  if (candidate.httpStatus === 401 || candidate.httpStatus === 403 || candidate.httpStatus === 429) return true;
  if (candidate.ambiguous === true) return true;
  const code = String(candidate.code ?? '');
  if (/ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR/.test(code)) return true;
  const name = String(candidate.name ?? '');
  return /TimeoutError|AbortError/.test(name) || /fetch failed/i.test(describeError(error));
}

/** 只取异常名与首行，截断并去掉可能夹带的 URL，避免把凭据或长响应体打进日志 */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw.split('\n')[0]!.replace(/https?:\/\/\S+/g, '<url>').slice(0, 160);
}

const HAS_TOKEN = Boolean(process.env.MCD_MCP_TOKEN?.trim());
const REAL_CITY = process.env.PROBE_CITY?.trim() ?? '';
const REAL_KEYWORD = process.env.PROBE_KEYWORD?.trim() ?? '';
const REAL_READY = HAS_TOKEN && REAL_CITY.length > 0 && REAL_KEYWORD.length > 0;
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
    store: { code: 'DEMO-STORE-001', name: '示例星河餐厅' },
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
  const result = await previewWith(new SampleGateway(), '巨无霸不要酸黄瓜 星河');
  if (!result.ok) {
    check('离线编排产出预览', false, `${result.reason}: ${result.message}`);
  } else {
    check('离线编排产出预览', true, `${result.elapsedMs}ms`);
    check('门店按别名命中到了官方名称', result.preview.cart.store.name === '示例星河餐厅',
      result.preview.cart.store.name);
    check('餐品命中巨无霸', result.preview.cart.items[0]?.name === '巨无霸');
    check('特制被解析出来', result.preview.cart.items[0]?.specText === '不要酸黄瓜',
      String(result.preview.cart.items[0]?.specText));
    check(
      '产出购物车指纹（幂等的基础），且长度足够抗碰撞',
      result.preview.fingerprint.length >= 12,
      `${result.preview.fingerprint.length} 字符`,
    );
    const again = await previewWith(new SampleGateway(), '巨无霸不要酸黄瓜 星河');
    check(
      '同一购物车两次建预览指纹一致（幂等可依赖）',
      again.ok && again.preview.fingerprint === result.preview.fingerprint,
    );
    check('预览卡片可渲染', renderPreview(result.preview, result.notes).includes('应付'));
  }
}

{
  const result = await previewWith(new SampleGateway(), '两个巨无霸一杯可乐 星河');
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
  const result = await previewWith(new SampleGateway(), '仰望星空派 星河');
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

  const first = await core.handle('u1', '巨无霸 星河');
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
  await core.handle('u2', '巨无霸 星河');
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
if (REAL_READY) {
  section('真实链路（只读）：门店 → 菜单 → 详情 → 算价');

  const real = createGateway('real');
  const city = REAL_CITY;
  check('已配置真实探针城市', city.length > 0, city);

  try {
    const stores = await real.gateway.listStores({ scene: 'pickup', city, keyword: REAL_KEYWORD });
    check('真实门店检索有结果', stores.length > 0, `${stores.length} 家`);

    // 实测：keyword 不会真的按名称过滤，本地必须能挑出最像的那家
    const picked = stores[0];
    check('候选池里能找到目标门店', Boolean(picked), picked?.name ?? '未找到');

    if (picked) {
      const menu = await real.gateway.getMenu({ scene: 'pickup', storeCode: picked.code });
      check('真实菜单非空', menu.items.length > 0, `${menu.items.length} 项`);
      check('菜单项带价格', menu.items.filter(hasPrice).length > 0);

      // ── 选品：优先巨无霸，但它不在售时不能让整段断言消失 ──────────
      // 实测教训：麦当劳菜单是**时段性**的。早餐/夜宵时段的菜单里根本没有
      // 巨无霸（正餐品），硬编码它会导致 target 为 undefined，下面三项断言
      // 被静默跳过（36 → 33 项），端到端再挂一项失败。表面看是「代码坏了」，
      // 实际是被测服务此刻的营业状态而已。
      const preferred = menu.items.find((item) => item.name.includes('巨无霸') && item.priceCents > 0);
      const sellable = menu.items.filter(
        (item) => item.priceCents > 0 && !item.name.includes('周边'),
      );
      // 短名更可能是单品而非「XX 套餐/组合」，算价成功率更高
      const byLength = [...sellable].sort((a, b) => a.name.length - b.name.length);
      const ordered = preferred ? [preferred, ...byLength.filter((i) => i !== preferred)] : byLength;

      if (!preferred) {
        skip(
          '巨无霸在当前时段的菜单中缺货',
          `当前菜单 ${menu.items.length} 项为早餐/夜宵品，改用当店在售品验证同一条链路`,
        );
      }

      let chosen: (typeof menu.items)[number] | undefined;
      let chosenPrice: Awaited<ReturnType<typeof real.gateway.calculatePrice>> | undefined;
      const attempted: string[] = [];

      for (const candidate of ordered.slice(0, 6)) {
        attempted.push(candidate.name);
        try {
          const price = await real.gateway.calculatePrice({
            scene: 'pickup',
            store: picked,
            items: [
              {
                productCode: candidate.code,
                name: candidate.name,
                quantity: 1,
                menuPriceCents: candidate.priceCents,
              },
            ],
            needTableware: false,
          });
          if (price.payableCents > 0 && price.takeWays.length > 0 && price.takeWays[0]!.code.length > 0) {
            chosen = candidate;
            chosenPrice = price;
            break;
          }
        } catch {
          // 个别商品在此刻不可售（时段/售罄），换下一个候选继续验证链路结构
        }
      }

      if (chosen && chosenPrice) {
        check(
          '真实算价返回正金额',
          chosenPrice.payableCents > 0,
          `${chosen.name} ${money(chosenPrice.payableCents)}`,
        );
        check(
          'T16：takeWayCode 确实来自算价结果',
          chosenPrice.takeWays.length > 0 && chosenPrice.takeWays[0]!.code.length > 0,
          chosenPrice.takeWays.map((t) => t.code).join(','),
        );

        const detail = await real.gateway.getMealDetail({
          scene: 'pickup',
          storeCode: picked.code,
          code: chosen.code,
        });
        if (detail) {
          check('真实餐品详情可取', true, `${chosen.name}(${chosen.code})`);
        } else if (preferred) {
          // 首选品必须有详情，否则 T18 的特制 code 无从谈起 —— 这是真问题
          check('真实餐品详情可取', false, `${chosen.name}(${chosen.code})`);
        } else {
          skip('回退品没有详情数据', `${chosen.name} 无详情，并非所有在售品都提供详情`);
        }
      } else {
        check(
          '当店在售品能算出正金额与取餐方式',
          false,
          `已试 ${attempted.length} 项：${attempted.slice(0, 3).join('、')}`,
        );
      }

      // 端到端必须用**此刻真实在售**的品名，而不是硬编码品名
      const e2eName = preferred?.name ?? chosen?.name;
      if (e2eName) {
        const realFavorites = {
          ...favorites,
          defaultStore: picked.name,
          stores: [{ alias: [REAL_KEYWORD, picked.name], name: picked.name, city: REAL_CITY }],
          rules: { ...favorites.rules, defaultCity: REAL_CITY },
        };
        const flow = await buildPreview({
          gateway: real.gateway,
          favorites: realFavorites,
          rawText: `${e2eName} ${REAL_KEYWORD}`,
          pinnedStoreCode: picked.code,
          scene: 'pickup',
        });
        check(
          '端到端：真实网关也能产出预览',
          flow.ok && flow.preview.price.payableCents > 0,
          flow.ok ? `${e2eName} ${money(flow.preview.price.payableCents)}` : flow.message,
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
    }

    console.log('\n  ℹ️  create-order **未被调用** —— 真实下单只在用户显式确认且通过守卫后发生。');
  } catch (error) {
    // 网络不通、Token 失效、响应超时都是外部状态，不是本仓库的缺陷。
    // 若一律记为失败，`npm run check` 的 && 链会在 M3 处断掉，
    // M4 / M8 / 礼节检查共 147 项将不再执行 —— 那才是真正的风险。
    if (isEnvironmentalError(error)) {
      skip('真实链路连通', `外部服务状态导致无法验证：${describeError(error)}`);
    } else {
      check('真实链路连通', false, describeError(error));
    }
  }
} else {
  section('真实链路');
  console.log('  ℹ️  未配置 MCD_MCP_TOKEN、PROBE_CITY、PROBE_KEYWORD，跳过真实链路验证（不会把合成门店用于真实服务）。');
}

// ═════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(50)}`);
console.log(
  `M3 自检：通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项${REAL_READY ? '（含真实链路）' : '（离线）'}`,
);
console.log('═'.repeat(50));

if (skipped > 0) {
  console.log(
    `⚠️  跳过 ${skipped} 项来自外部服务状态（时段缺货 / 网络 / 凭据），不是代码缺陷。\n` +
      '    这些断言在正常时段且网络可用时会重新执行，请勿把「跳过」当作「通过」。',
  );
}

// 只有结构性失败才让进程失败 —— 这样 `npm run check` 的 && 链不会因
// 一次网络抖动或早餐时段就中断，M4 / M8 / 礼节检查仍能照常执行。
if (failed > 0) process.exitCode = 1;
