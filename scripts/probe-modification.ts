/**
 * 只读探针（第三轮）：验证「特制」如何传递 —— 以「巨无霸不要酸黄瓜」为例。
 *
 * 已知：query-meal-detail 返回 modification.items[].values[]，
 *      每项含 code / name / selectedKey / unselectedKey / selectedQuantity。
 * 待验证：calculate-price 的 items[].modification.values[] 该传什么组合。
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
const MEAL_CODE = '1100'; // 巨无霸（午餐菜单）

async function callRead(
  client: McpStreamableHttpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = (await client.callTool(tool, args)) as McpCallResult;
  return unwrapToolResult(result);
}

async function main(): Promise<void> {
  const client = new McpStreamableHttpClient();
  if (!client.hasToken) throw new Error('缺少 MCD_MCP_TOKEN');

  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const reservationDate = `${date} 12:00`;

  const variants: { label: string; modification: unknown }[] = [
    {
      label: 'A_默认不选_key0-0_qty0',
      modification: { values: [{ code: '100202', key: '0-0', quantity: 0 }] },
    },
    {
      label: 'B_选中key_0-1_qty0',
      modification: { values: [{ code: '100202', key: '0-1', quantity: 0 }] },
    },
    {
      label: 'C_仅code_qty0',
      modification: { values: [{ code: '100202', quantity: 0 }] },
    },
    {
      label: 'D_unselectedKey_qty1',
      modification: { values: [{ code: '100202', key: '0-0', quantity: 1 }] },
    },
  ];

  for (const variant of variants) {
    console.log(`\n===== ${variant.label} =====`);
    const price = await callRead(client, 'calculate-price', {
      storeCode: STORE_CODE,
      orderType: 1,
      beType: 1,
      reservationDate,
      needTableware: false,
      items: [
        {
          productCode: MEAL_CODE,
          quantity: 1,
          modification: variant.modification,
        },
      ],
    });
    writeFileSync(resolve(OUT_DIR, `chain3-mod-${variant.label}.json`), JSON.stringify(price, null, 2), 'utf8');
    const text = JSON.stringify(price);
    console.log(text.length > 700 ? `${text.slice(0, 700)} …` : text);
  }

  console.log('\n完成。全程只读，未创建任何订单。');
}

main().catch((error: unknown) => {
  console.error('探针失败：', error);
  process.exitCode = 1;
});
