/**
 * 报名文案门禁 —— 校验 docs/REGISTRATION_ISSUE.md 是否符合官方模板。
 *
 * 为什么值得单独做成一个门禁：
 * Issue #361 已因格式问题被官方退回两次（第一次「项目无法访问」，第二次
 * 「【简介标题】和【简介正文】之间不要使用换行符」）。报名截止 10-25，
 * 第三次失败的代价不是重跑一次脚本，而是可能错过整个活动。
 * 人工核对一定会忘，所以交给机器。
 *
 * 校验依据（官方 2026-10-11 00:58 在 Issue #361 给出的标准模板）：
 *   Issue 标题：自定义报名标题
 *   Issue 正文：
 *   【参赛申请】
 *   项目名称：{项目名称}
 *   项目地址：{项目 GitHub 仓库地址}
 *   项目简介：{项目简介}
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = join(ROOT, 'docs', 'REGISTRATION_ISSUE.md');
const FENCE = '```';

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

/** 取 markdown 中某个 `## 标题` 之后的第一个围栏代码块内容 */
function blockAfter(anchor: string): string {
  const lines = readFileSync(DOC, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(anchor));
  if (start < 0) return '';
  const open = lines.findIndex((l, i) => i > start && l.startsWith(FENCE));
  if (open < 0) return '';
  const close = lines.findIndex((l, i) => i > open && l.startsWith(FENCE));
  if (close < 0) return '';
  return lines.slice(open + 1, close).join('\n').trim();
}

console.log('═'.repeat(50));
console.log('报名文案自检（docs/REGISTRATION_ISSUE.md）');
console.log('═'.repeat(50));

section('结构');
const title = blockAfter('## 标题');
const body = blockAfter('## 正文');
check('标题块可提取', title.length > 0, title.slice(0, 40));
check('正文块可提取', body.length > 0);

section('官方模板四要素');
check('正文首行为【参赛申请】', body.startsWith('【参赛申请】'));
check('含「项目名称：」', body.includes('项目名称：'));
check('含「项目地址：」', body.includes('项目地址：'));
check('含「项目简介：」', body.includes('项目简介：'));

section('第二次退回原因：简介换行');
const m = /项目简介[:：]/.exec(body);
if (!m) {
  check('能定位「项目简介」字段', false);
} else {
  check('能定位「项目简介」字段', true);
  check(
    '「项目简介：」后紧跟正文（无换行）',
    body[m.index + m[0].length] !== '\n',
    '官方明示：简介标题与正文之间不要换行',
  );
  const intro = body.slice(m.index + m[0].length);
  check(
    '简介正文为单段（无内部换行）',
    !intro.includes('\n'),
    '单行正则也不会截断，字数 ' + intro.replace(/\s/g, '').length,
  );
  // 两种可能的官方实现都应取到完整简介
  const single = /项目简介[:：](.*)/.exec(body)?.[1] ?? '';
  const multi = /项目简介[:：]([\s\S]*)/.exec(body)?.[1] ?? '';
  check('单行/多行正则取值一致（不会被截断）', single.length === multi.length);
}

section('硬性限制');
const chars = body.replace(/\s/g, '').length;
check('正文不超过 1000 字', chars <= 1000, `实际 ${chars} 字`);
check(
  '不含图片',
  !/!\[|<img|https?:\/\/.*\.(png|jpg|jpeg|gif)/i.test(body),
);

section('与仓库实际情况一致');
const addr = /项目地址[:：]\s*(\S+)/.exec(body)?.[1] ?? '';
check('项目地址是 GitHub 仓库链接', /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(addr), addr);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name?: string };
const repoInUrl = addr.split('/').pop() ?? '';
check(
  '项目地址与 package.json 的 name 一致',
  repoInUrl === pkg.name,
  `URL=${repoInUrl} / package.json=${pkg.name ?? '(无)'}`,
);

console.log(`\n报名文案自检：通过 ${passed} 项，失败 ${failed} 项`);
console.log('═'.repeat(50));

if (failed > 0) process.exitCode = 1;
