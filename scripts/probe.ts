/**
 * 只读探针：验证 Token 可用性，并抓取真实返回结构用于修正字段解析。
 *
 * 刻意**不调用** create-order 等任何会产生真实订单或扣款的写操作。
 */

import { loadDotEnv, describeSecrets } from '../src/env.ts';
import {
  McpStreamableHttpClient,
  unwrapToolResult,
  toolResultText,
  type McpToolDef,
} from '../src/mcp/client.ts';

const outDir = new URL('../.cache/probe/', import.meta.url);
const { mkdirSync, writeFileSync } = await import('node:fs');
const { resolve: resolvePath } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const cacheDir = fileURLToPath(outDir);
mkdirSync(cacheDir, { recursive: true });

const env = loadDotEnv();
console.log('加载 .env:', env.existed ? env.path : '(未找到 .env)');
console.log('注入变量:', env.loadedKeys.join(', ') || '(无)');
console.log('凭据:', describeSecrets().join('  '));

const client = new McpStreamableHttpClient();
console.log('\n端点:', client.endpoint);

function shape(value: unknown, depth = 0): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${shape(value[0], depth + 1)}] (len=${value.length})`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (depth >= 2) return `{${entries.map(([k]) => k).join(', ')}}`;
    return `{ ${entries.map(([k, v]) => `${k}: ${shape(v, depth + 1)}`).join(', ')} }`;
  }
  return typeof value;
}

const tools: McpToolDef[] = await client.listTools();
console.log(`\n✅ 握手成功，共 ${tools.length} 个工具：`);
for (const tool of tools) {
  const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties ? Object.keys(schema.properties) : [];
  const req = schema?.required ?? [];
  console.log(
    `  - ${tool.name.padEnd(26)} ${props.length ? `params=[${props.join(', ')}]${req.length ? ` 必填=[${req.join(', ')}]` : ''}` : '(无参数)'}`,
  );
}
writeFileSync(resolvePath(cacheDir, 'tools.json'), JSON.stringify(tools, null, 2), 'utf8');

const readOnlyProbes: { name: string; args: Record<string, unknown> }[] = [
  { name: 'now-time-info', args: {} },
  { name: 'query-my-account', args: {} },
  { name: 'query-my-coupons', args: {} },
  { name: 'available-coupons', args: {} },
  { name: 'campaign-calendar', args: {} },
  { name: 'list-nutrition-foods', args: {} },
];

console.log('\n── 只读工具实测 ──');
for (const probe of readOnlyProbes) {
  const def = tools.find((t) => t.name === probe.name);
  if (!def) {
    console.log(`\n[${probe.name}] 服务端未提供，跳过`);
    continue;
  }
  try {
    const result = await client.callTool(probe.name, probe.args);
    const data = unwrapToolResult(result);
    console.log(`\n[${probe.name}]`);
    console.log('  顶层结构:', shape(data));
    const text = toolResultText(result);
    if (text) console.log('  原文预览:', text.slice(0, 220).replace(/\s+/g, ' '));
    writeFileSync(
      resolvePath(cacheDir, `${probe.name}.json`),
      JSON.stringify(data, null, 2),
      'utf8',
    );
  } catch (error) {
    console.log(`\n[${probe.name}] ❌ ${String(error)}`);
  }
}

console.log('\n缓存目录:', cacheDir);
console.log('注意：探针未调用任何写操作，不会创建订单或扣款。');
