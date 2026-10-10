/**
 * 推送前礼节检查（T35）。
 *
 * 为什么要有这个脚本：T35 的原始要求是「截图/动图里不得出现真实 Token 与支付链接」。
 * 但**人工检查一定会忘**，而且它只在 push 前那一刻有意义。所以做成一个可重复跑的门禁：
 * 扫所有**即将进入仓库**的文件，命中即失败。
 *
 * 设计取舍：
 * 1. 以 `git ls-files` 为准（那就是真正会被推送的集合），拿不到 git 时退回目录遍历。
 * 2. 二进制（png/jpg/gif/mp4）**读不出内容**，脚本不假装能扫 —— 只列清单要求人工确认。
 *    宁可明说「这里需要人看一眼」，也不要给出虚假的安全感。
 * 3. 每条规则都配了元测试（脚本末尾），确保检查器本身没坏。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须用 fileURLToPath：直接取 `new URL().pathname` 会得到百分号编码的路径，
// 中文用户名（C:\Users\安）下会变成 %E5%AE%89，随后 scandir 直接 ENOENT。
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
  '.mp4', '.mov', '.webm', '.mp3',
  '.woff', '.woff2', '.ttf', '.otf',
  '.zip', '.gz', '.pdf', '.db', '.sqlite',
]);

/** 这些文件一旦出现在待推送集合里，说明有人用了 `git add -f` 或规则被绕过 */
const FORBIDDEN_TRACKED: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\.(?!example$)/,
  /^config\/favorites\.json$/,
  /^\.cache\//,
  /^\.codegraph\//,
  /^data\/live\//,
  /^state\//,
  /\.session\.json$/,
];

interface Rule {
  readonly id: string;
  readonly label: string;
  /** 命中后是否要跳过（用于排除代码引用、URL 等误报） */
  readonly skip?: (match: string, line: string) => boolean;
  readonly pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    id: 'R1',
    label: '凭据被赋了真实值',
    // 行首的 KEY=值。注意 .env.example 里 `MCD_MCP_TOKEN=` 后面是空的，不会命中。
    pattern: /(?:^|\n)\s*(MCD_MCP_TOKEN|WECHAT_APP_SECRET|WECHAT_APP_ID|CONFIRM_SECRET|WECHAT_TOKEN)\s*=\s*(\S+)/g,
    skip: (_m, line) =>
      // 代码里的正则字面量（如 `/^MCD_MCP_TOKEN=.*$/m`）不是赋值
      line.includes('/^') ||
      line.includes('.*$') ||
      // 环境变量引用与占位符
      /\$\{|process\.env|<|\.\.\.|your_|xxx|TODO/i.test(line),
  },
  {
    id: 'R2',
    label: 'Authorization 头带了真实 Token',
    // `Bearer <token>` 这类占位符长度不够，不会被误伤
    pattern: /Bearer\s+[A-Za-z0-9_\-.=+/]{16,}/g,
  },
  {
    id: 'R3',
    label: '出现疑似真实手机号',
    // 必须带数字边界：否则菜单图片 URL 里的 13 位时间戳会被当成手机号
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  },
  {
    id: 'R4',
    label: '出现支付 / 收银台链接',
    pattern: /https?:\/\/[^\s"'<>]*(?:\/pay|payment|cashier|pay\/)[^\s"'<>]*/gi,
    skip: (_m, line) => /example|\$\{|xxx|<|\.\.\./i.test(line),
  },
  {
    id: 'R5',
    label: '出现 32 位以上高强度密串',
    pattern: /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{32,}={0,2}(?![A-Za-z0-9+/=])/g,
    skip: (match, line) =>
      // URL 路径会被 `/` 连成一长串（pcm/prod/menu/20250611/...），不算密串
      line.includes('http') ||
      match.includes('.') ||
      /^[0-9]+$/.test(match) ||
      // 单个字符重复到底的填充串（测试里伪造签名常用），不是真密钥
      /^(.)\1+$/.test(match) ||
      // 不在凭据上下文里的长串一律放过：否则 tsconfig 的
      // forceConsistentCasingInFileNames 这类合法标识符会被误判
      !/(token|secret|key|password|passwd|auth|credential|bearer|sign)/i.test(line),
  },
];

/**
 * 本文件**刻意**内置了假 Token / 假手机号来给检查器自己做元测试，
 * 所以扫描待推送文件时跳过它 —— 否则检查器会把自己告了。
 */
const SCAN_EXEMPT = new Set(['scripts/check-release.ts']);

interface Finding {
  readonly rule: string;
  readonly label: string;
  readonly line: number;
  readonly hit: string;
}

function mask(hit: string): string {
  const s = hit.trim().replace(/\s+/g, ' ');
  if (s.length <= 10) return s.slice(0, 2) + '***';
  return `${s.slice(0, 4)}…(${s.length})…${s.slice(-4)}`;
}

/** 纯函数，便于脚本末尾做元测试 */
function scanText(text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const re = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (!rule.skip?.(m[0], line)) {
          out.push({ rule: rule.id, label: rule.label, line: i + 1, hit: mask(m[0]) });
        }
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }
  }
  return out;
}

/** 把 .gitignore 的一行转成正则（支持 `*` `?` `**`、目录尾斜杠、行内取反 `!`） */
function gitignoreToRegex(pattern: string): { re: RegExp; negate: boolean } | null {
  let p = pattern.trim();
  if (!p || p.startsWith('#')) return null;
  const negate = p.startsWith('!');
  if (negate) p = p.slice(1);
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!p) return null;

  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  // 含 `/` 的模式相对仓库根匹配；否则匹配任意层级的同名项
  const body = anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`;
  return { re: new RegExp(body), negate };
}

function loadIgnoreRules(): Array<{ re: RegExp; negate: boolean }> {
  const rules: Array<{ re: RegExp; negate: boolean }> = [];
  for (const file of ['.gitignore']) {
    let text = '';
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const r = gitignoreToRegex(line);
      if (r) rules.push(r);
    }
  }
  return rules;
}

function isIgnored(relPath: string, rules: Array<{ re: RegExp; negate: boolean }>): boolean {
  // 取反规则（!.env.example）优先级最高
  for (const r of rules) if (r.negate && r.re.test(relPath)) return false;
  for (const r of rules) if (!r.negate && r.re.test(relPath)) return true;
  return false;
}

/**
 * 列出「真正会被推送」的文件。
 *
 * 优先用 `git ls-files`（那就是权威集合）；但 Node 子进程常常找不到 git
 * （Git Bash 的 PATH 是 POSIX 风格，Windows 版 Node 解析不了），
 * 所以兜底路径**必须自己读 .gitignore** —— 否则 `.env` 会被当成待推送文件，
 * 检查器会误报「凭据泄露」。这一点是实测踩出来的。
 */
function listFiles(): string[] {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT });
  if (git.status === 0 && git.stdout && git.stdout.length > 0) {
    return git.stdout.toString('utf8').split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/'));
  }

  const rules = loadIgnoreRules();
  const out: string[] = [];
  const alwaysSkip = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
  (function walk(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = relative(ROOT, join(dir, e.name)).replace(/\\/g, '/');
      if (alwaysSkip.has(e.name) || isIgnored(rel, rules)) continue;
      if (e.isDirectory()) walk(join(dir, e.name));
      else out.push(rel);
    }
  })(ROOT);
  return out;
}

let passed = 0;
let failed = 0;

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
}

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? `  → ${detail}` : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\n推送前礼节检查（T35）');

const files = listFiles();

section('待推送文件集合');
check('拿到待推送清单', files.length > 0, `files=${files.length}`);
console.log(`  ℹ️  共 ${files.length} 个文件将进入仓库`);

section('不该被追踪的文件');
const forbidden = files.filter((f) => FORBIDDEN_TRACKED.some((re) => re.test(f)));
check('.env / .cache / favorites.json / .codegraph 均未入库', forbidden.length === 0, forbidden.join(', '));

section('文本内容扫描');
const textFindings: Array<{ file: string } & Finding> = [];
const media: string[] = [];
const oversize: string[] = [];

for (const file of files) {
  if (SCAN_EXEMPT.has(file)) continue;
  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  let size = 0;
  try {
    size = statSync(join(ROOT, file)).size;
  } catch {
    continue;
  }
  if (size > 512 * 1024) oversize.push(`${file} (${Math.round(size / 1024)}KB)`);

  if (BINARY_EXT.has(ext)) {
    media.push(`${file} (${Math.round(size / 1024)}KB)`);
    continue;
  }
  let text: string;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    media.push(`${file} (无法按文本读取)`);
    continue;
  }
  if (text.includes('\0')) {
    media.push(`${file} (二进制)`);
    continue;
  }
  for (const f of scanText(text)) textFindings.push({ file, ...f });
}

for (const rule of RULES) {
  const hits = textFindings.filter((f) => f.rule === rule.id);
  check(`${rule.id} ${rule.label}`, hits.length === 0, hits.map((h) => `${h.file}:${h.line} ${h.hit}`).join(' | '));
}

section('需要人工确认的部分');
if (media.length > 0) {
  console.log('  ⚠️  以下内容脚本读不出，推送前请人工过一眼（确认无真实 Token / 支付链接）：');
  for (const m of media) console.log(`      · ${m}`);
} else {
  console.log('  ℹ️  仓库内没有二进制图片/动图，无需人工核对');
}
check('无超过 512KB 的文件', oversize.length === 0, oversize.join(', '));

// ─────────────────────────────────────────────────────────────
// 元测试：检查器本身必须能抓到东西，否则这个门禁就是摆设
section('检查器自检（确保规则没失效）');

const FAKE_TOKEN = 'CX5EBVMtNGrbDfCKwubvZyRqOeK3mXHS';

function hitsRuleOn(text: string, id: string): boolean {
  return scanText(text).some((f) => f.rule === id);
}

check('R1 能抓到真实凭据赋值', hitsRuleOn(`MCD_MCP_TOKEN=${FAKE_TOKEN}\n`, 'R1'));
check('R1 不误伤空的 .env.example', !hitsRuleOn('MCD_MCP_TOKEN=\n', 'R1'));
check('R1 不误伤代码里的正则字面量', !hitsRuleOn("if (/^MCD_MCP_TOKEN=.*$/m.test(env)) {}", 'R1'));

check('R2 能抓到真实 Bearer', hitsRuleOn(`Authorization: Bearer ${FAKE_TOKEN}`, 'R2'));
check('R2 不误伤占位符', !hitsRuleOn('Authorization: Bearer <token>', 'R2'));

check('R3 能抓到真实手机号', hitsRuleOn('联系人 13800138000', 'R3'));
check(
  'R3 不误伤图片 URL 里的长数字',
  !hitsRuleOn('https://menu-img.mcd.cn/pcm/prod/menu/20250611/product/MS_1100_600_1749175370846.png', 'R3'),
);

check('R4 能抓到支付链接', hitsRuleOn('https://mcd.cn/pay/abc123', 'R4'));

check('R5 能抓到裸密串', hitsRuleOn(`token: ${FAKE_TOKEN}`, 'R5'));
check('R5 不误伤 URL 路径', !hitsRuleOn('https://x.cn/pcm/prod/menu/20250611/product/MS_1100_600_1749175370846.png', 'R5'));

// ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`礼节检查：${passed} 通过 / ${failed} 失败`);
console.log('═'.repeat(52));

if (failed > 0) {
  console.log('\n⛔ 存在必须处理的问题，不要推送。');
  process.exitCode = 1;
} else {
  console.log('\n✅ 可以推送。');
}
