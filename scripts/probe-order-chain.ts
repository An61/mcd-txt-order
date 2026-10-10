/**
 * 只读探针：跑通「门店 → 菜单 → 详情 → 算价」全链路，抓取真实字段结构。
 *
 * 全程只调用只读工具，不触达 create-order / cancel-order / auto-bind-coupons。
 * 产出快照写入 .cache/probe/chain-*.json（该目录已 gitignore）。
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

function save(name: string, value: unknown): void {
  const file = resolve(OUT_DIR, name);
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  → 已保存 ${name}（${text.length} 字符）`);
}

function preview(value: unknown, limit = 700): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)} …(截断)` : text;
}

async function callRead(
  client: McpStreamableHttpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool(tool, args) as McpCallResult;
  return unwrapToolResult(result);
}

/** 探针专用：在 data.meals 字典里找出名称包含关键词的条目 */
function pickNamed(value: unknown, keywords: string[]): { code: unknown; name: unknown } | undefined {
  const dict = (value as { data?: { meals?: Record<string, { name?: string }> } } | undefined)
    ?.data?.meals;
  if (!dict) return undefined;
  for (const keyword of keywords) {
    for (const [code, item] of Object.entries(dict)) {
      if (item?.name && item.name.includes(keyword)) return { code, name: item.name };
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const client = new McpStreamableHttpClient();
  if (!client.hasToken) throw new Error('缺少 MCD_MCP_TOKEN');

  console.log('1) query-nearby-stores  searchType=1（官方收藏餐厅）');
  const favoritesProbe = await callRead(client, 'query-nearby-stores', {
    beType: 1,
    searchType: 1,
  });
  save('chain-stores-favorite.json', favoritesProbe);
  console.log(preview(favoritesProbe, 900));

  console.log('\n2) query-nearby-stores  searchType=1 + keyword=香梅北（审计 F-07 待验证组合）');
  const keywordFavorite = await callRead(client, 'query-nearby-stores', {
    beType: 1,
    searchType: 1,
    keyword: '香梅北',
  });
  save('chain-stores-keyword-favorite.json', keywordFavorite);
  console.log(preview(keywordFavorite, 700));

  console.log('\n3) query-nearby-stores  searchType=2 + city=深圳 + keyword=香梅北');
  const keywordLocation = await callRead(client, 'query-nearby-stores', {
    beType: 1,
    searchType: 2,
    city: '深圳',
    keyword: '香梅北',
  });
  save('chain-stores-keyword-location.json', keywordLocation);
  console.log(preview(keywordLocation, 900));

  // 取第一个可用门店继续
  const store = pickFirstStore(favoritesProbe) ?? pickFirstStore(keywordLocation);
  if (!store) {
    console.log('\n没有取到任何门店，后续步骤跳过');
    return;
  }
  const storeCode = String(store.code);
  const storeName = String(store.name);
  console.log(`\n选定门店：${storeName}（${storeCode}）`);

  console.log('\n4a) query-meals（当前时段）');
  const meals = await callRead(client, 'query-meals', {
    storeCode,
    orderType: 1,
    beType: 1,
  });
  save('chain-meals.json', meals);
  console.log(preview(meals, 600));

  console.log('\n4b) query-meals（reservationDate=今天 12:00，验证能否取到午餐菜单）');
  const today = new Date();
  const stamp = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');
  const lunchMeals = await callRead(client, 'query-meals', {
    storeCode,
    orderType: 1,
    beType: 1,
    reservationDate: `${stamp} 12:00`,
  });
  save('chain-meals-lunch.json', lunchMeals);
  console.log(preview(lunchMeals, 600));

  const meal = pickFirstMeal(meals) ?? pickFirstMeal(lunchMeals);
  const target = pickNamed(lunchMeals, ['巨无霸', '麦辣鸡腿堡']) ?? meal;
  if (!target) {
    console.log('\n菜单为空，后续跳过');
    return;
  }
  console.log(`\n选定餐品：${String(target.name)}（${String(target.code)}）`);

  console.log('\n5) query-meal-detail');
  const detail = await callRead(client, 'query-meal-detail', {
    storeCode,
    orderType: 1,
    beType: 1,
    code: String(target.code),
  });
  save('chain-meal-detail.json', detail);
  console.log(preview(detail, 1600));

  console.log('\n6) calculate-price（验证 takeWayList 与实付价字段）');
  const price = await callRead(client, 'calculate-price', {
    storeCode,
    orderType: 1,
    beType: 1,
    items: [{ productCode: String(target.code), quantity: 1 }],
    needTableware: false,
  });
  save('chain-price.json', price);
  console.log(preview(price, 2000));

  console.log('\n完成。以上均为只读调用，未创建任何订单。');
}

/** 探针专用：宽容地猜一个 storeCode，只求跑通，不代表正式实现的解析方式 */
function pickFirstStore(value: unknown): { code: unknown; name: unknown } | undefined {
  const queue: unknown[] = [value];
  let guard = 0;
  while (queue.length && guard < 5000) {
    guard += 1;
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      queue.push(...cur.slice(0, 50));
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (obj.storeCode !== undefined && obj.storeName !== undefined) {
      return { code: obj.storeCode, name: obj.storeName };
    }
    if (obj.storeCode !== undefined && obj.name !== undefined) {
      return { code: obj.storeCode, name: obj.name };
    }
    queue.push(...Object.values(obj).slice(0, 50));
  }
  return undefined;
}

function pickFirstMeal(value: unknown): { code: unknown; name: unknown } | undefined {
  const queue: unknown[] = [value];
  let guard = 0;
  while (queue.length && guard < 20000) {
    guard += 1;
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      queue.push(...cur.slice(0, 80));
      continue;
    }
    const obj = cur as Record<string, unknown>;
    const code = obj.code ?? obj.productCode ?? obj.mealCode;
    const name = obj.name ?? obj.productName ?? obj.mealName;
    if (code !== undefined && name !== undefined && typeof name === 'string') {
      return { code, name };
    }
    queue.push(...Object.values(obj).slice(0, 80));
  }
  return undefined;
}

main().catch((error: unknown) => {
  console.error('探针失败：', error);
  process.exitCode = 1;
});
