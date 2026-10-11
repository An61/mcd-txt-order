/**
 * 探针（第三轮）：解决审计 F-07 / T15 的未验证项 ——
 * **门店到底能不能按关键词检索？**
 *
 * 这直接决定 orderFlow 的默认路径：
 *   - 若 `searchType=2 + keyword` 能按名搜 ──► 指定关键词可以用别名直接命中门店
 *   - 若 keyword 无效 ─────────────────────► 只能先取附近门店列表，再在本地做名称/别名匹配
 *
 * 顺带记录每种组合的错误码，用于 SPEC 回填。
 *
 * 全部为只读调用，不会创建订单。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv, findProjectRoot } from '../src/env.ts';
import {
  McpStreamableHttpClient,
  unwrapToolResult,
  type McpCallResult,
} from '../src/mcp/client.ts';

loadDotEnv();

const PROBE_CITY = process.env.PROBE_CITY?.trim() ?? '';
const PROBE_KEYWORD = process.env.PROBE_KEYWORD?.trim() ?? '';
if (!process.env.MCD_MCP_TOKEN || !PROBE_CITY || !PROBE_KEYWORD) {
  console.log('跳过真实门店探针：请显式设置 MCD_MCP_TOKEN、PROBE_CITY、PROBE_KEYWORD；不会使用示例位置调用服务。');
  process.exit(0);
}

const OUT_DIR = resolve(findProjectRoot(), '.cache', 'probe');
mkdirSync(OUT_DIR, { recursive: true });

function save(name: string, value: unknown): void {
  writeFileSync(resolve(OUT_DIR, name), JSON.stringify(value, null, 2), 'utf8');
}

function codeOf(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '(非对象)';
  const rec = payload as Record<string, unknown>;
  return `${String(rec.code ?? '-')} / success=${String(rec.success ?? '-')} / ${String(rec.message ?? rec.msg ?? '')}`.slice(0, 90);
}

function countStores(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const data = (payload as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : -1;
}

function names(payload: unknown, max = 5): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: Array<Record<string, unknown>> }).data;
  if (!Array.isArray(data)) return [];
  return data.slice(0, max).map((s) => `${String(s.storeCode)} ${String(s.storeName)}`);
}

async function probe(
  client: McpStreamableHttpClient,
  label: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<void> {
  let payload: unknown;
  try {
    payload = unwrapToolResult((await client.callTool(tool, args)) as McpCallResult);
  } catch (error) {
    console.log(`\n[${label}] 抛异常：${String(error)}`);
    return;
  }
  save(`stores-${label}.json`, payload);
  console.log(`\n[${label}] ${tool}`);
  console.log('  args :', JSON.stringify(args));
  console.log('  返回 :', codeOf(payload));
  console.log('  门店数:', countStores(payload));
  for (const n of names(payload)) console.log('     ·', n);
}

async function main(): Promise<void> {
  const client = new McpStreamableHttpClient();
  console.log('endpoint:', client.endpoint, '| hasToken:', client.hasToken);

  console.log('\n═══════ A. 收藏餐厅 (searchType=1) ═══════');
  await probe(client, 'A1-fav-only', 'query-nearby-stores', { beType: 1, searchType: 1 });
  await probe(client, 'A2-fav-with-keyword', 'query-nearby-stores', {
    beType: 1,
    searchType: 1,
    keyword: PROBE_KEYWORD,
  });

  console.log('\n═══════ B. 按位置检索 (searchType=2) ═══════');
  await probe(client, 'B1-loc-plain', 'query-nearby-stores', { beType: 1, searchType: 2 });
  await probe(client, 'B2-loc-keyword', 'query-nearby-stores', {
    beType: 1,
    searchType: 2,
    keyword: PROBE_KEYWORD,
  });
  await probe(client, 'B3-loc-city', 'query-nearby-stores', {
    beType: 1,
    searchType: 2,
    city: PROBE_CITY,
  });
  await probe(client, 'B4-loc-city-keyword', 'query-nearby-stores', {
    beType: 1,
    searchType: 2,
    city: PROBE_CITY,
    keyword: PROBE_KEYWORD,
  });

  console.log('\n═══════ C. 不传 searchType 的边界 ═══════');
  await probe(client, 'C1-beType-only', 'query-nearby-stores', { beType: 1 });
  await probe(client, 'C2-keyword-only', 'query-nearby-stores', {
    beType: 1,
    searchType: 2,
    keyword: PROBE_KEYWORD,
    city: PROBE_CITY,
    pageNo: 1,
    pageSize: 5,
  });

  console.log('\n完成。全部为只读调用。');
}

main().catch((error) => {
  console.error('探针失败：', error);
  process.exitCode = 1;
});
