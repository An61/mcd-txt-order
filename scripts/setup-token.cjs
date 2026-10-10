const fs = require('fs');
const path = require('path');

// 项目根目录按脚本位置推导，不再写死绝对路径 —— 以后再改项目名/挪目录也不会失效
const PROJECT_ROOT = path.resolve(__dirname, '..');

const tokenPath = process.argv[2] || 'C:/Users/安/Desktop/Mcdonald Token.txt';
const token = fs.readFileSync(tokenPath, 'utf8').trim();

if (!token) throw new Error('Token 文件为空');
const safe = /^[A-Za-z0-9_\-.=+/]+$/.test(token);
console.log('Token 长度:', token.length, '| 字符集安全:', safe);
if (!safe) throw new Error('Token 含意外字符，已中止');

// 1) 写入 WorkBuddy 全局 MCP 配置（合并，不覆盖其他 server）
const mcpPath = 'C:/Users/安/.workbuddy/mcp.json';
let cfg = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
  } catch (e) {
    console.log('现有 mcp.json 解析失败，将重建:', String(e));
    cfg = { mcpServers: {} };
  }
}
cfg.mcpServers['mcd-mcp'] = {
  type: 'streamablehttp',
  url: 'https://mcp.mcd.cn',
  headers: { Authorization: `Bearer ${token}` },
};
fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2), 'utf8');
console.log('已写入:', mcpPath, '| servers:', Object.keys(cfg.mcpServers).join(', '));

// 2) 写入项目 .env（已 gitignore）
const envPath = path.join(PROJECT_ROOT, '.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const line = `MCD_MCP_TOKEN=${token}`;
if (/^MCD_MCP_TOKEN=.*$/m.test(env)) {
  env = env.replace(/^MCD_MCP_TOKEN=.*$/m, line);
} else {
  env = (env ? env.replace(/\s*$/, '\n') : '') + line + '\n';
}
if (!/^MCD_MCP_URL=/m.test(env)) env += 'MCD_MCP_URL=https://mcp.mcd.cn\n';
if (!/^ORDER_REQUIRE_CONFIRM=/m.test(env)) env += 'ORDER_REQUIRE_CONFIRM=true\n';
fs.writeFileSync(envPath, env, 'utf8');
console.log('已写入:', envPath, '| 行数:', env.trim().split(/\r?\n/).length);

// 3) 校验 .gitignore 确实排除了 .env
const gi = path.join(PROJECT_ROOT, '.gitignore');
if (fs.existsSync(gi)) {
  const lines = fs.readFileSync(gi, 'utf8').split(/\r?\n/).map(s => s.trim());
  const ignored = lines.includes('.env') || lines.includes('.env.*');
  console.log('.gitignore 已排除 .env:', ignored);
  if (!ignored) throw new Error('.gitignore 未排除 .env，存在泄密风险，已中止');
}

console.log('OK');
