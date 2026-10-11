/** Structural deployment checks that do not require external services. */

import { readFileSync } from 'node:fs';

const files = {
  env: readFileSync('.env.example', 'utf8'),
  dockerfile: readFileSync('deploy/Dockerfile', 'utf8'),
  compose: readFileSync('deploy/docker-compose.yml', 'utf8'),
  caddy: readFileSync('deploy/Caddyfile', 'utf8'),
  nginx: readFileSync('deploy/nginx.conf', 'utf8'),
  systemd: readFileSync('deploy/mcd-txt-order.service', 'utf8'),
};

const checks: Array<[string, boolean]> = [
  ['Node body cap is 1 MiB', /HTTP_MAX_BODY_BYTES=1048576/.test(files.env)],
  ['Node request timeout is 5 seconds', /HTTP_REQUEST_TIMEOUT_MS=5000/.test(files.env)],
  ['Docker image runs as node', /\nUSER node\n/.test(files.dockerfile)],
  ['Docker healthcheck is present', /HEALTHCHECK/.test(files.dockerfile)],
  ['Docker creates writable state directory', /mkdir -p \/app\/\.cache/.test(files.dockerfile)],
  ['Compose persists order state', /order-state:\/app\/\.cache/.test(files.compose) && /order-state:\n/.test(files.compose)],
  ['Compose disables public mock', /EXPOSE_MOCK: "false"/.test(files.compose)],
  ['Caddy caps body at 1 MiB', /max_size 1MB/.test(files.caddy)],
  ['Caddy timeout is 5 seconds', /read_timeout 5s/.test(files.caddy) && /write_timeout 5s/.test(files.caddy)],
  ['Nginx caps body at 1 MiB', /client_max_body_size 1m/.test(files.nginx)],
  ['Nginx rate limits callbacks', /limit_req_zone/.test(files.nginx) && /limit_req zone=mcd_wechat/.test(files.nginx)],
  ['Nginx callback timeout is 5 seconds', /proxy_read_timeout 5s/.test(files.nginx) && /proxy_send_timeout 5s/.test(files.nginx)],
  ['systemd restarts on failure', /Restart=always/.test(files.systemd)],
  ['systemd keeps secrets outside the unit', /EnvironmentFile=/.test(files.systemd) && !/MCD_MCP_TOKEN=/.test(files.systemd)],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? '✅' : '❌'} ${label}`);
if (failed.length > 0) process.exitCode = 1;
else console.log(`部署检查通过：${checks.length} 项`);
