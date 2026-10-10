/**
 * 极简 .env 加载器（零依赖）。
 *
 * 只做一件事：把项目根目录的 .env 读进 process.env，且**不覆盖**已有的环境变量，
 * 这样 CI / Docker 里通过真实环境变量注入的凭据永远优先。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LoadEnvResult {
  path: string;
  loadedKeys: string[];
  existed: boolean;
}

const NON_SECRET_HINT_KEYS = [
  'MCD_MCP_TOKEN',
  'WECHAT_APP_SECRET',
  'WECHAT_ENCODING_AES_KEY',
  'WECHAT_TOKEN',
];

/** 从当前文件向上查找项目根目录（含 package.json 的那一层） */
export function findProjectRoot(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadDotEnv(envPath?: string): LoadEnvResult {
  const target = envPath ?? resolve(findProjectRoot(), '.env');
  if (!existsSync(target)) return { path: target, loadedKeys: [], existed: false };

  const raw = readFileSync(target, 'utf8');
  const loadedKeys: string[] = [];

  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      loadedKeys.push(key);
    }
  }

  return { path: target, loadedKeys, existed: true };
}

/** 用于日志：只显示是否为敏感值，不打印内容 */
export function mask(value: string | undefined): string {
  if (!value) return '(未设置)';
  if (value.length <= 8) return `${'*'.repeat(value.length)}`;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export function describeSecrets(): string[] {
  return NON_SECRET_HINT_KEYS.map((key) => `${key}=${mask(process.env[key])}`);
}
