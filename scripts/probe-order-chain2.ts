/**
 * 只读探针（第二轮）：验证 reservationDate 一致性假设。
 *
 * 假设：若 query-meals 带了 reservationDate，则 query-meal-detail /
 *      calculate-price / create-order 必须传同一个值，否则商品判定为不可售。
 *
 * 同时对比「不预约」路径（用当前时段可售的商品）能否跑通同一链路。
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

const OUT_DIR = resolve(findProjectRoot(), '.cache', 'probe');
mkdirSync(OUT_DIR, { recursive: true });

const STORE_CODE = process.env.PROBE_STORE_CODE || '1420602';

function save(name: string, value: unknown): void {
  writeFileSync(resolve(OUT_DIR, name), JSON.stringify(value, null, 2), 'utf8');
}

function brief(value: unknown, limit = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)} …(截断，全长 ${text.length})` : text;
}

async function callRead(
  client: McpStreamableHttpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool(tool, args)) as McpCallResult;
  return unwrapToolResult(result);
}

function today(at: string): string {
  const now = new Date();
  const d = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `${d} ${at}`;
}

function dictOf(value: unknown): Record<string, { name?: string; currentPrice?: string }> {
  const data = (value as { data?: { meals?: Record<string, never> } } | undefined)?.data;
  return (data?.meals ?? {}) as Record<string, { name?: string; currentPrice?: string }>;
}

async function tryChain(
  client: McpStreamableHttpClient,
  label: string,
  reservationDate: string | undefined,
  wantKeywords: string[],
): Promise<void> {
  console.log(`\n========== ${label} ==========`);
  console.log('reservationDate =', reservationDate ?? '(不传，即时单)');

  const mealsArgs: Record<string, unknown> = {
    storeCode: STORE_CODE,
    orderType: 1,
    beType: 1,
  };
  if (reservationDate) mealsArgs.reservationDate = reservationDate;

  const meals = await callRead(client, 'query-meals', mealsArgs);
  const dict = dictOf(meals);
  console.log(`菜单条目数：${Object.keys(dict).length}`);

  let code: string | undefined;
  let name: string | undefined;
  for (const keyword of wantKeywords) {
    for (const [c, item] of Object.entries(dict)) {
      if (item?.name && item.name.includes(keyword)) {
        code = c;
        name = item.name;
        break;
      }
    }
    if (code) break;
  }
  if (!code) {
    const first = Object.entries(dict)[0];
    code = first?.[0];
    name = first?.[1]?.name;
  }
  if (!code) {
    console.log('菜单为空，跳过');
    return;
  }
  console.log(`测试餐品：${name}（code=${code}）`);
  save(`chain2-meals-${label}.json`, meals);

  const baseArgs: Record<string, unknown> = {
    storeCode: STORE_CODE,
    orderType: 1,
    beType: 1,
  };
  if (reservationDate) baseArgs.reservationDate = reservationDate;

  console.log('-- query-meal-detail --');
  const detail = await callRead(client, 'query-meal-detail', { ...baseArgs, code });
  save(`chain2-detail-${label}.json`, detail);
  console.log(brief(detail, 900));

  console.log('-- calculate-price --');
  const price = await callRead(client, 'calculate-price', {
    ...baseArgs,
    items: [{ productCode: code, quantity: 1 }],
    needTableware: false,
  });
  save(`chain2-price-${label}.json`, price);
  console.log(brief(price, 1400));
}

async function main(): Promise<void> {
  const client = new McpStreamableHttpClient();
  if (!client.hasToken) throw new Error('缺少 MCD_MCP_TOKEN');

  console.log('门店 storeCode =', STORE_CODE);

  // A：预约午餐，全链路都带 reservationDate
  await tryChain(client, 'reserved-lunch', today('12:00'), ['巨无霸', '麦辣鸡腿堡']);

  // B：不预约，用当前时段可售商品
  await tryChain(client, 'now', undefined, ['巨无霸', '麦满分', '咖啡', '豆浆']);

  console.log('\n完成。全程只读，未创建任何订单。');
}

main().catch((error: unknown) => {
  console.error('探针失败：', error);
  process.exitCode = 1;
});
