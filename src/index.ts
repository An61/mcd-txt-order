/**
 * CLI 入口。
 *
 * 这个文件的存在本身就是为了兑现 package.json 里的每个 script ——
 * **凡是写进 scripts 的命令，都必须真的能跑**。否则新来的人 clone 下来第一件事就是踩坑。
 *
 * 用法：
 *   npm run tools          列出 MCP 当前真实提供的全部工具
 *   npm run favorites      查看已配置的门店/餐品别名
 *   npm run doctor         环境体检（Token、城市、目录、场景）
 *   npm run chat           交互式对话（默认接真实 MCP，无 Token 自动演示模式）
 *   npm run demo           离线演示：自动播一遍完整流程，含二次确认
 *   npm run serve          启动公众号 HTTP 服务（尚未实现，会明确说明）
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { findProjectRoot, loadDotEnv, mask } from './env.ts';
import { McpStreamableHttpClient } from './mcp/client.ts';
import { createGateway, describeScenes, GatewayError } from './mcp/gateway.ts';
import { ConversationCore } from './channel/core.ts';
import { ChannelServer } from './channel/server.ts';
import { loadFavorites, defaultCity } from './domain/favorites.ts';

loadDotEnv();

type Command = 'tools' | 'favorites' | 'doctor' | 'chat' | 'serve' | 'order' | 'help';

function printHelp(): void {
  console.log(`
mcd-txt-order —— 微信里一句话下单麦当劳

  npm run tools        列出 MCP 当前真实提供的全部工具
  npm run favorites    查看已配置的门店/餐品别名
  npm run doctor       环境体检
  npm run chat         交互式对话（--sample 强制离线演示模式）
  npm run demo         离线演示完整流程（含二次确认）
  npm run serve        启动公众号 HTTP 服务

选项：
  --sample, --mock     强制使用离线演示数据，不发起任何真实请求
  --real               强制真实模式（缺 Token 会报错退出）
  --demo               自动播放预设对话，无需人工输入
`);
}

// ─────────────────────────────────────────────────────────────
// tools
// ─────────────────────────────────────────────────────────────

async function cmdTools(): Promise<void> {
  const token = process.env.MCD_MCP_TOKEN?.trim();
  if (!token) {
    console.log('未检测到 MCD_MCP_TOKEN，无法列出真实工具列表。');
    console.log('先到 https://open.mcd.cn/mcp 获取并填入 .env。');
    return;
  }

  const client = new McpStreamableHttpClient();
  const tools = await client.listTools();
  console.log(`共 ${tools.length} 个工具（实时取自 tools/list）：\n`);

  const groups = new Map<string, typeof tools>();
  for (const tool of tools) {
    const first = (tool.description ?? '').trim().split(/\s|\n/)[0] ?? '未分类';
    const key = first.length > 12 ? '未分类' : first;
    const list = groups.get(key) ?? [];
    list.push(tool);
    groups.set(key, list);
  }

  for (const tool of tools) {
    const required = (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [];
    const summary = (tool.description ?? '').replace(/^Description:\s*/i, '').replace(/\s+/g, ' ').trim();
    const shown = summary.length > 70 ? `${summary.slice(0, 70)}…` : summary;
    console.log(`· ${tool.name}`);
    if (required.length > 0) console.log(`    必填: ${required.join(', ')}`);
    if (shown) console.log(`    ${shown}`);
  }
}

// ─────────────────────────────────────────────────────────────
// favorites
// ─────────────────────────────────────────────────────────────

function cmdFavorites(): void {
  const result = loadFavorites();
  console.log(`配置文件：${result.sourcePath}${result.usedFallback ? '（示例配置）' : ''}`);
  for (const warning of result.warnings) console.log(`⚠️  ${warning}`);
  console.log('');

  console.log(`喜爱门店（${result.config.stores.length}）：`);
  for (const store of result.config.stores) {
    const alias = store.alias.length > 0 ? `别名 ${store.alias.join('/')}` : '无别名';
    console.log(`  · ${store.name}  ${store.city ?? '(无城市)'}  ${alias}`);
  }

  console.log(`\n喜爱餐品（${result.config.meals.length}）：`);
  for (const meal of result.config.meals) {
    const extras = [
      meal.alias.length > 0 ? `别名 ${meal.alias.join('/')}` : '',
      meal.qty ? `默认 ${meal.qty} 份` : '',
      meal.spec ? `默认特制「${meal.spec}」` : '',
    ].filter(Boolean);
    console.log(`  · ${meal.name}  ${extras.join('  ')}`);
  }

  const city = defaultCity(result.config);
  console.log(`\n兜底城市：${city ?? '⚠️ 未配置（门店检索会失败，请在 rules.defaultCity 里补上）'}`);
}

// ─────────────────────────────────────────────────────────────
// doctor
// ─────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const token = process.env.MCD_MCP_TOKEN?.trim();
  const favorites = loadFavorites();
  const city = defaultCity(favorites.config);

  console.log('── 环境体检 ──\n');
  console.log(`Node            ${process.version}`);
  console.log(`项目根目录      ${findProjectRoot()}`);
  console.log(`MCP Token       ${mask(token)}`);
  console.log(`MCP 地址        ${process.env.MCD_MCP_URL ?? 'https://mcp.mcd.cn'}`);
  console.log(`兜底城市        ${city ?? '⚠️ 未配置'}`);
  console.log(`收藏配置        ${favorites.sourcePath}${favorites.usedFallback ? '（示例）' : ''}`);
  console.log(`门店/餐品       ${favorites.config.stores.length} / ${favorites.config.meals.length}`);
  console.log(`支持场景        ${describeScenes()}`);

  if (!token) {
    console.log('\n⚠️  没有 Token，将运行在演示模式（离线快照，不会真的下单）。');
    return;
  }

  console.log('\n正在连接 MCP …');
  try {
    const client = new McpStreamableHttpClient();
    const tools = await client.listTools();
    console.log(`✅ 连接成功，服务端提供 ${tools.length} 个工具。`);
    const needed = [
      'query-nearby-stores',
      'query-meals',
      'query-meal-detail',
      'calculate-price',
      'create-order',
    ];
    for (const name of needed) {
      console.log(`   ${tools.some((t) => t.name === name) ? '✅' : '❌'} ${name}`);
    }
  } catch (error) {
    console.log(`❌ 连接失败：${String(error instanceof Error ? error.message : error)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// chat / demo
// ─────────────────────────────────────────────────────────────

function pickGatewayMode(argv: readonly string[]): 'real' | 'sample' | 'auto' {
  if (argv.includes('--sample') || argv.includes('--mock')) return 'sample';
  if (argv.includes('--real')) return 'real';
  return 'auto';
}

async function cmdChat(argv: readonly string[]): Promise<void> {
  const isDemo = argv.includes('--demo');
  let mode = pickGatewayMode(argv);

  // SEC-1 兜底：演示脚本里必定包含「确认」，若走真实网关就会真的下一单。
  // 因此 demo 默认强制离线；只有显式写 --real 才放开（那时每一步都会真的花钱）。
  if (isDemo && mode !== 'real') {
    mode = 'sample';
    console.log('演示模式强制使用离线快照，避免自动脚本触发真实下单。');
    console.log('如需真实演练，请显式加 --real（会真的创建订单）。\n');
  }

  let core: ConversationCore;

  try {
    core = new ConversationCore({ bundle: createGateway(mode) });
  } catch (error) {
    console.log(`启动失败：${String(error instanceof Error ? error.message : error)}`);
    return;
  }

  console.log(`── ${core.gateway.describe()} ──`);
  console.log('输入「帮助」看用法，Ctrl+C 退出。\n');

  // demo 脚本只播到预览为止，不自动确认 —— 真实模式下尤其不能替用户按下那个按钮
  if (argv.includes('--demo')) {
    await playDemoScript(core);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  await conversationLoop(core, rl);
  rl.close();
}

async function conversationLoop(core: ConversationCore, rl: ReadlineInterface): Promise<void> {
  for (;;) {
    const line = await new Promise<string>((resolveLine) => {
      rl.question('你  ', (answer) => resolveLine(answer));
    });
    const text = line.trim();
    if (!text) continue;
    if (text === 'exit' || text === 'quit') break;

    const reply = await core.handle('cli-user', text);
    console.log(`助手  ${reply.text.replace(/\n/g, '\n      ')}`);
    if (reply.kind === 'placed') {
      if (reply.payUrl) console.log(`      (支付链接：${reply.payUrl})`);
    }
    console.log('');
  }
}

/**
 * 自动播放一遍流程：别名找店 → 菜单匹配 → 真实价格 → 预览卡片。
 *
 * **刻意停在预览这一步，不自动确认。**最后那一下按下的是真金白银，
 * 任何脚本都无权替用户按——哪怕只是个 demo。
 */
async function playDemoScript(core: ConversationCore): Promise<void> {
  for (const line of ['巨无霸不要酸黄瓜 香梅北', '两个巨无霸一杯可乐 香梅北']) {
    console.log(`你    ${line}`);
    const reply = await core.handle('demo-user', line);
    console.log(`${reply.text.split('\n').map((l) => `      ${l}`).join('\n')}`);
    console.log('');
    await sleep(120);
  }
  console.log('（演示到此为止：下单需要真人回复「确认」）');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// serve / order
// ─────────────────────────────────────────────────────────────

async function cmdServe(argv: readonly string[]): Promise<void> {
  const mode = pickGatewayMode(argv);
  const bundle = createGateway(mode);
  const core = new ConversationCore({ bundle });
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);

  const server = new ChannelServer({
    core,
    port: Number.isFinite(port) ? port : 8787,
    token: process.env.WECHAT_TOKEN?.trim() ?? '',
    appId: process.env.WECHAT_APP_ID?.trim() ?? '',
    appSecret: process.env.WECHAT_APP_SECRET?.trim() ?? '',
    modeLabel: bundle.gateway.describe(),
  });

  const instance = await server.listen();
  console.log(`🚀 服务已启动：http://localhost:${port}`);
  console.log(`   网页模拟器  http://localhost:${port}/`);
  console.log(`   健康检查    http://localhost:${port}/healthz`);
  console.log(`   公众号回调  http://localhost:${port}/wechat`);
  console.log('');
  console.log(`   数据模式    ${bundle.gateway.describe()}`);
  console.log(`   异步推送    ${server.canPushAsync ? '已启用（客服消息接口）' : '未启用，超时结果将在用户下次发言时回补'}`);
  console.log('');
  console.log('没有公网地址？用内网穿透把 80/443 映射到本机，微信只回调这两个端口：');
  console.log(`   ngrok http ${port}      # 或 cpolar / natapp`);
  console.log('');
  console.log('按 Ctrl+C 停止。');

  const shutdown = (): void => {
    instance.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 手动下单 —— **会产生真实订单**。
 * 必须显式传 `--i-know-this-creates-a-real-order`，且严格按顺序执行下面每一步检查。
 */
async function cmdOrder(argv: readonly string[]): Promise<void> {
  const acknowledged = argv.includes('--i-know-this-creates-a-real-order');
  if (!acknowledged) {
    console.log('⛔ 拒绝执行：这个命令会产生**真实订单**并需要付款。');
    console.log('   请改用 npm run chat 走完整的「预览 → 确认」流程，或显式加上旗标：');
    console.log('   --i-know-this-creates-a-real-order');
    return;
  }

  const storeArg = readOption(argv, '--store');
  const itemArg = readOption(argv, '--item');
  if (!storeArg || !itemArg) {
    console.log('用法：--store <门店关键词> --item <餐品> [--i-know-this-creates-a-real-order]');
    return;
  }

  const core = new ConversationCore({ bundle: createGateway('real') });
  if (core.gateway.mode !== 'real') {
    console.log('⛔ 当前不是真实模式，已中止。');
    return;
  }

  console.log(`真实下单模式。门店=${storeArg} 餐品=${itemArg}`);
  console.log('第一步：生成预览（只读）…\n');

  const preview = await core.handle('cli-order', `${itemArg} ${storeArg}`);
  console.log(preview.text);
  if (preview.kind !== 'preview') {
    console.log('\n预览未生成，已中止。');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const answer = await new Promise<string>((resolveAnswer) => {
    rl.question('\n确认要真实下单吗？输入 yes 继续，其它任意键取消：', (a) => resolveAnswer(a));
  });
  rl.close();

  if (answer.trim().toLowerCase() !== 'yes') {
    console.log('已取消，未创建订单。');
    return;
  }

  const placed = await core.handle('cli-order', '确认');
  console.log(`\n${placed.text}`);
  if (placed.payUrl) console.log(`支付链接：${placed.payUrl}`);
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = (argv.find((a) => !a.startsWith('-')) ?? 'help') as Command;

  switch (command) {
    case 'tools':
      await cmdTools();
      break;
    case 'favorites':
      cmdFavorites();
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    case 'chat':
      await cmdChat(argv);
      break;
    case 'serve':
      await cmdServe(argv);
      break;
    case 'order':
      await cmdOrder(argv);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

main().catch((error) => {
  if (error instanceof GatewayError) {
    console.error(`\n网关错误：${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.error('\n执行失败：', error);
  process.exitCode = 1;
});

// 注意：这里刻意不做 re-export。`DataGateway` / `OrderPreview` 都是类型，
// Node 原生类型剥离会把它们擦除，当值导出会直接报 "Export not defined"。
