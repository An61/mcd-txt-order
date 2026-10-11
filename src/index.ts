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
 *   npm run ip             查询公网出口 IP（填公众号 IP 白名单）
 *   npm run serve          启动公众号 HTTP 服务
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { findProjectRoot, loadDotEnv, mask } from './env.ts';
import { McpStreamableHttpClient } from './mcp/client.ts';
import { createGateway, describeScenes, GatewayError } from './mcp/gateway.ts';
import { ConversationCore } from './channel/core.ts';
import { ChannelServer, type WechatEncryptMode } from './channel/server.ts';
import { loadFavorites, defaultCity } from './domain/favorites.ts';
import { publicErrorMessage } from './safety/publicError.ts';

loadDotEnv();

type Command = 'tools' | 'favorites' | 'doctor' | 'chat' | 'serve' | 'order' | 'ip' | 'help';

function printHelp(): void {
  console.log(`
mcd-txt-order —— 微信里一句话下单麦当劳

  npm run tools        列出 MCP 当前真实提供的全部工具
  npm run favorites    查看已配置的门店/餐品别名
  npm run doctor       环境体检（含公众号配置）
  npm run ip           查询公网出口 IP（填进公众号 IP 白名单）
  npm run chat         交互式对话（--sample 强制离线演示模式）
  npm run demo         离线演示完整流程（含二次确认）
  npm run serve        启动公众号 HTTP 服务

选项：
  --sample, --mock     强制使用离线演示数据，不发起任何真实请求
  --real               强制真实模式（缺 Token 会报错退出）
  --demo               自动播放预设对话，无需人工输入
`);
}

function readEncryptMode(): WechatEncryptMode {
  const raw = (process.env.WECHAT_ENCRYPT_MODE ?? 'plain').trim().toLowerCase();
  return raw === 'encrypt' || raw === 'mixed' ? raw : 'plain';
}

function readExposeMock(): boolean | undefined {
  const raw = process.env.EXPOSE_MOCK?.trim();
  if (raw === undefined || raw === '') return undefined;
  return raw === 'true' || raw === '1';
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
  console.log(`MCP 地址        ${safeEndpointForLog(process.env.MCD_MCP_URL ?? 'https://mcp.mcd.cn')}`);
  console.log(`兜底城市        ${city ?? '⚠️ 未配置'}`);
  console.log(`收藏配置        ${favorites.sourcePath}${favorites.usedFallback ? '（示例）' : ''}`);
  console.log(`门店/餐品       ${favorites.config.stores.length} / ${favorites.config.meals.length}`);
  console.log(`支持场景        ${describeScenes()}`);

  console.log('\n── 公众号配置 ──\n');
  const mode = readEncryptMode();
  console.log(`WECHAT_TOKEN    ${mask(process.env.WECHAT_TOKEN)}`);
  console.log(`AppID/Secret    ${mask(process.env.WECHAT_APP_ID)} / ${mask(process.env.WECHAT_APP_SECRET)}`);
  console.log(`加解密方式      ${mode}`);
  console.log(`EncodingAESKey  ${mask(process.env.WECHAT_ENCODING_AES_KEY)}`);
  console.log(`监听 HOST:PORT  ${(process.env.HOST ?? '127.0.0.1')}:${process.env.PORT ?? '8787'}`);

  const problems: string[] = [];
  if (!process.env.WECHAT_TOKEN?.trim()) problems.push('缺 WECHAT_TOKEN：公众号服务器配置校验过不了');
  if (!process.env.WECHAT_APP_ID?.trim() || !process.env.WECHAT_APP_SECRET?.trim()) {
    problems.push('缺 AppID/AppSecret：无法调用客服消息接口，超时结果只能等用户下次发言补发');
  }
  if (mode !== 'plain') {
    const aesKey = process.env.WECHAT_ENCODING_AES_KEY?.trim() ?? '';
    if (aesKey.length !== 43) {
      problems.push(`加解密方式为 ${mode}，但 EncodingAESKey 是 ${aesKey.length} 位（应为 43 位）`);
    }
  }
  if (readEncryptMode() !== 'plain' && !process.env.WECHAT_APP_ID?.trim()) {
    problems.push('非明文模式需要 AppID 才能校验密文尾部的 AppID');
  }

  if (problems.length === 0) {
    console.log('\n✅ 公众号侧配置完备。');
  } else {
    for (const p of problems) console.log(`⚠️  ${p}`);
  }

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
    console.log(`❌ 连接失败：${publicErrorMessage(error)}`);
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
    console.log(`启动失败：${publicErrorMessage(error)}`);
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
  for (const line of ['巨无霸不要酸黄瓜 星河', '两个巨无霸一杯可乐 星河']) {
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

  const portRaw = Number.parseInt(process.env.PORT ?? '8787', 10);
  const port = Number.isFinite(portRaw) ? portRaw : 8787;
  const host = (process.env.HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const encryptMode = readEncryptMode();

  let server: ChannelServer;
  try {
    server = new ChannelServer({
      core,
      port,
      host,
      token: process.env.WECHAT_TOKEN?.trim() ?? '',
      appId: process.env.WECHAT_APP_ID?.trim() ?? '',
      appSecret: process.env.WECHAT_APP_SECRET?.trim() ?? '',
      encodingAesKey: process.env.WECHAT_ENCODING_AES_KEY?.trim() ?? '',
      encryptMode,
      exposeMock: readExposeMock(),
      modeLabel: bundle.gateway.describe(),
    });
  } catch (error) {
    console.error(`\n⛔ 启动失败：${publicErrorMessage(error)}`);
    process.exitCode = 1;
    return;
  }

  const cfg = server.config;
  const instance = await server.listen();

  console.log(`🚀 服务已启动：http://${cfg.host}:${cfg.port}`);
  console.log(`   监听地址    ${cfg.host}${cfg.host === '127.0.0.1' ? '（仅本机）' : '（对外）'}`);
  console.log(`   健康检查    http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}/healthz`);
  console.log(`   公众号回调  http://<你的域名>/wechat`);
  console.log('');
  console.log(`   数据模式    ${bundle.gateway.describe()}`);
  console.log(`   加解密方式  ${cfg.encryptMode}${cfg.cryptoReady ? '（加解密器已就绪）' : '（未配置密钥）'}`);
  console.log(`   异步推送    ${server.canPushAsync ? '已启用（客服消息接口）' : '未启用，超时结果将在用户下次发言时回补'}`);
  console.log(`   调试入口    ${cfg.exposeMock ? '已开启（/ 与 /api/chat 可访问）' : '已关闭（对外监听时的默认行为）'}`);
  console.log('');

  if (!cfg.wechatReady) {
    console.log('⚠️  未配置 WECHAT_TOKEN，公众号回调会拒绝请求。');
    console.log('   在 .env 里填好 WECHAT_TOKEN / WECHAT_APP_ID / WECHAT_APP_SECRET 再启动。');
  }
  if (cfg.host === '127.0.0.1') {
    console.log('没有公网地址？两条路：');
    console.log(`   · 临时调试：ngrok http ${cfg.port}（或 cpolar / natapp）`);
    console.log('   · 正式上线：见 docs/WECHAT_PRODUCTION.md（域名 + HTTPS + 反代）');
  }
  console.log('');
  console.log('按 Ctrl+C 停止。');

  const shutdown = (): void => {
    instance.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * 查询公网出口 IP。
 *
 * 存在的理由：调用 access_token / 客服消息接口前，必须把服务器出口 IP
 * 填进公众号后台的「IP 白名单」，否则一律报 40164。
 * 这条命令就是为了省掉「打开浏览器搜一下我的 IP」这一步。
 */
async function cmdIp(): Promise<void> {
  const endpoints = ['https://api.ipify.org?format=json', 'https://myip.ipip.net/json'];
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const text = await response.text();
      const ip = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(text)?.[1];
      if (ip) {
        console.log(`公网出口 IP：${ip}`);
        console.log('把它填进公众号后台 → 开发 → 基本配置 → IP 白名单。');
        return;
      }
    } catch {
      // 换下一个源
    }
  }
  console.log('查询失败，可手动访问 https://api.ipify.org 查看。');
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
    case 'ip':
      await cmdIp();
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
    console.error(`\n网关错误：${publicErrorMessage(error)}`);
    process.exitCode = 1;
    return;
  }
  console.error('\n执行失败：', publicErrorMessage(error));
  process.exitCode = 1;
});

function safeEndpointForLog(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(配置无效)';
  }
}

// 注意：这里刻意不做 re-export。`DataGateway` / `OrderPreview` 都是类型，
// Node 原生类型剥离会把它们擦除，当值导出会直接报 "Export not defined"。
