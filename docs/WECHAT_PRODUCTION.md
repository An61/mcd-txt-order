# 公众号真实上线手册

`docs/WECHAT_TESTING.md` 回答"能不能测"，`docs/WECHAT_SETUP.md` 回答"怎么接"，
这一篇回答**怎么真的放到公网上给用户用**——含 TLS、回调、加解密、白名单、灰度与回滚。

预计耗时：有域名和服务器的话约 40 分钟；从零开始（含备案/域名）另算。

---

## 0. 先确认你的号有资格

| 能力 | 未认证订阅号 | 认证订阅号 | 认证服务号 | 接口测试号 |
|---|:-:|:-:|:-:|:-:|
| 接收消息 + 被动回复 | ✅ | ✅ | ✅ | ✅ |
| 客服消息接口（异步推送结果） | ❌ | ❌ | ✅ | ✅ |
| 自定义菜单 | ❌ | 部分 | ✅ | ✅ |
| 模板消息 | ❌ | 部分 | ✅ | 部分 |
| 个人可申请 | ✅ | ❌（需企业） | ❌（需企业） | ✅ |

**结论：个人开发者走"接口测试号"即可跑通全链路**；要长期对外服务，至少需要认证服务号。

没有客服消息权限时的表现：链路耗时超过 4.3 秒的结果不会丢失，
会暂存在内存里，**用户下次发言时自动补发**（见 `deliverLater()`）。功能不缺，只是慢一拍。

---

## 1. 部署形态怎么选

| 方案 | 适合 | 门槛 | 说明 |
|---|---|---|---|
| **Docker + Caddy**（推荐） | 有云服务器 | 低 | `docker compose up -d`，Caddy 自动申请证书 |
| systemd + Nginx | 已有服务器 | 中 | 见 `deploy/mcd-txt-order.service` |
| 内网穿透（ngrok/cpolar） | 只想先验证 | 极低 | 只配 `HOST=127.0.0.1`，穿透到 8787 |

⚠️ **穿透工具只用于验证，不要用于生产**：域名随机、随时变更、免费套餐限流，
一旦地址变了，公众号后台就得跟着改，且中间节点能看到明文消息。

### 1.1 Docker 部署

```bash
git clone https://github.com/An61/mcd-txt-order.git
cd mcd-txt-order

cp .env.example .env      # 填 Token / 公众号配置（见第 3 节）
vim deploy/Caddyfile      # 把 mcd.example.com 换成你的域名

docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f
```

### 1.2 systemd 部署

```bash
sudo useradd -r -s /usr/sbin/nologin mcd
sudo mkdir -p /opt/mcd-txt-order
sudo rsync -a --exclude .git --exclude .cache ./ /opt/mcd-txt-order/
sudo cp .env /opt/mcd-txt-order/.env && sudo chmod 600 /opt/mcd-txt-order/.env
sudo chown -R mcd:mcd /opt/mcd-txt-order

sudo cp deploy/mcd-txt-order.service /etc/systemd/system/
sudo cp deploy/nginx.conf /etc/nginx/conf.d/mcd-txt-order.conf   # 改域名与证书路径
sudo systemctl daemon-reload && sudo systemctl enable --now mcd-txt-order
```

---

## 2. 域名与 HTTPS

微信回调**只接受 80/443 端口的 http/https**，且生产环境必须是 HTTPS：

- 证书用 Let's Encrypt（`certbot` 或 Caddy 自动续期）
- 后台里填的 URL 必须是 `https://你的域名/wechat`
  —— 注意**不能**填会 301 跳转的 http 地址，微信的服务器配置校验不跟随重定向
- 域名需要已备案（国内服务器）

验证证书是否就绪：

```bash
curl -i https://你的域名/healthz
```

应返回 200 和一段 JSON（`mode` / `encryptMode` / `exposeMock` 等）。

---

## 3. 环境变量

```bash
# ── 公众号（公众号后台 → 开发 → 基本配置）──
WECHAT_TOKEN=你自己编的一个字符串          # 两边一致即可，不是微信下发的
WECHAT_APP_ID=wx##################
WECHAT_APP_SECRET=************************
WECHAT_ENCRYPT_MODE=plain                  # plain / mixed / encrypt
WECHAT_ENCODING_AES_KEY=                   # 非 plain 时填 43 位

# ── 服务 ──
HOST=0.0.0.0                               # 容器/服务器内监听
PORT=8787
# EXPOSE_MOCK=true                         # 仅在你要用网页模拟器时打开

# ── 麦当劳 MCP ──
MCD_MCP_TOKEN=************************
MCD_MCP_URL=https://mcp.mcd.cn
# 公网 MCP 只允许 HTTPS；本机 HTTP 代理必须单独显式开启
MCD_MCP_ALLOW_INSECURE_LOOPBACK=false
# 实际支付域名白名单，逗号分隔；不填使用代码内置麦当劳域名白名单
# MCD_PAYMENT_HOSTS=pay.mcd.cn,mcd.cn
# 默认按精确主机匹配；只有显式写 *.example.com 才允许其子域名。

# ── 持久化与入口防护 ──
ORDER_STATE_DB=/app/.cache/order-state.sqlite  # Docker；systemd 用 /opt/mcd-txt-order/.cache/order-state.sqlite
ORDER_PENDING_TIMEOUT_MS=300000                # 进程重启时将过期 pending 封存为 unknown
HTTP_MAX_BODY_BYTES=1048576
HTTP_REQUEST_TIMEOUT_MS=5000
HTTP_RATE_LIMIT_WINDOW_MS=60000
HTTP_RATE_LIMIT_MAX=60
```

`ORDER_STATE_DB` 必须位于持久卷。Docker Compose 已将 `/app/.cache` 挂到 `order-state` 卷；多实例跨主机时必须改为所有实例可见的共享持久存储。订单状态只保存购物车指纹、状态、金额和订单号，不保存 Token、支付链接或原始请求体。

当前 Compose 保留多实例 claim 审计能力，但**不能把 `--scale mcd-txt-order=2` 直接用于用户流量**：会话草稿、确认 ticket 和无客服权限时的待补发结果仍保存在单进程内存，预览落在实例 A、确认落在实例 B 会丢失状态。生产部署先保持单应用实例；如果要做隔离的幂等演练，可在本机临时用 `--scale=2`，只验共享 SQLite claim，不把它当作用户流量验收。真正多实例上线前必须补齐共享会话/ticket 存储或可靠的用户级亲和路由，并完成目标机验收。

改完用体检命令确认一遍：

```bash
npm run doctor
```

它会明确告诉你缺什么、以及缺了之后的**实际后果**（比如"超时结果只能等用户下次发言补发"）。

---

## 4. IP 白名单（最容易漏的一步）

调用 `access_token` 与客服消息接口前，必须把**服务器出口 IP** 填进
公众号后台 → 开发 → 基本配置 → **IP 白名单**。否则一律报错：

```
{"errcode": 40164, "errmsg": "invalid ip ..."}
```

查出口 IP：

```bash
npm run ip
```

多实例/弹性 IP 场景要把所有可能的出口都填进去。

---

## 5. 公众号后台配置

后台 → 开发 → 基本配置 → 服务器配置 → 修改配置：

| 字段 | 填什么 |
|---|---|
| URL | `https://你的域名/wechat` |
| Token | 与 `.env` 的 `WECHAT_TOKEN` **完全相同** |
| EncodingAESKey | 选"随机生成"；若 `WECHAT_ENCRYPT_MODE=plain` 可不填 |
| 消息加解密方式 | 与 `WECHAT_ENCRYPT_MODE` 对应 |

**保存失败的 99% 原因**：

1. Token 两边含有看不见的空格 → 复制时带上了换行
2. URL 忘了 `/wechat`，或写成了 http（会 301）
3. 服务没起来 / 防火墙没开 443
4. 加解密方式选了安全模式，但 `WECHAT_ENCODING_AES_KEY` 没填或不是 43 位

排错时直接看服务端返回：

```bash
curl 'https://你的域名/wechat?signature=xxx&timestamp=1&nonce=1&echostr=hello'
```

- 回 `signature mismatch` → Token 不一致（这是正常的校验失败，说明服务活着）
- 回 `未配置 WECHAT_TOKEN…` → .env 没生效，检查容器是否挂了 env_file
- 超时/502 → 服务或反代没起来

---

## 6. 加解密模式怎么选

| 模式 | 消息形态 | 建议 |
|---|---|---|
| `plain` | 明文 XML | 调试阶段用这个，出问题肉眼可读 |
| `mixed` | 明文/密文都可能 | 迁移过渡期 |
| `encrypt` | 全密文 | **生产建议** |

安全模式有两个坑，代码里已经处理：

1. **URL 校验时的 `echostr` 也是密文** —— 直接原样回给微信会一直提示"token 验证失败"。
   `resolveWechatVerify()` 会先解密再返回。
2. **回复也必须加密**，且密文尾部要带 AppID。见 `WechatMessageCrypto.encryptReply()`。

`encrypt` 模式启动时会做快速失败检查：缺 `WECHAT_ENCODING_AES_KEY` 或 `WECHAT_APP_ID` 直接拒绝启动，
而不是等第一条消息进来才报错。

---

## 7. 上线前检查清单

- [ ] `npm run typecheck`、`npm run check:deploy`、`npm run check:s9:a1`、`npm run check:s9:boundaries` 全绿
- [ ] 无 Token 环境运行 `npm run check` 全绿；带 Token 的真实链路只做只读探针
- [ ] `npm run doctor` 无任何 ⚠️
- [ ] `npm run ip` 的出口 IP 已加入白名单
- [ ] `curl https://域名/healthz` 返回 `ok: true`
- [ ] `healthz` 里 `exposeMock` 为 `false`（对外服务时必须是 false）
- [ ] 已用**接口测试号**完整走过一遍：发「巨无霸 星河」→ 收到预览 → 回复「确认」
- [ ] 真实下单只在本人可控的情况下验证过一次（会产生真实订单与付款）
- [ ] `.env` 权限 600 且不在 git 里（`npm run check:release` 会查）
- [ ] 日志可查：`docker compose logs -f` 或 `journalctl -u mcd-txt-order -f`
- [ ] 入口 body 上限、超时和限流与反代配置一致（Node/Caddy/Nginx 均为 1 MiB、5 秒）

---

## 8. 灰度与回滚

**灰度**：先用接口测试号跑，再切到正式号。两者配置完全一样，只是 AppID/Secret 不同。

**回滚**：

```bash
# Docker
docker compose -f deploy/docker-compose.yml down
git checkout <上一个可用的 commit>
docker compose -f deploy/docker-compose.yml up -d --build

# systemd
sudo systemctl stop mcd-txt-order
cd /opt/mcd-txt-order && sudo git checkout <commit>
sudo systemctl start mcd-txt-order
```

回滚期间公众号后台**无需改动** —— 只要 URL 不变，微信照常推送；
服务不可用时的表现是用户收不到回复，恢复后不会丢消息（微信会重试 3 次，我们也做了 MsgId 去重）。

---

## 9. 上线后要盯的三件事

1. **超时率**：链路 2~6 秒，超过 4.3 秒就走异步。若 `healthz` 的 `asyncPush` 为 false，
   说明客服消息没权限，用户感知会明显变慢 —— 换认证服务号可以解决。
2. **去重命中**：`healthz` 的 `dedupeKeys` 持续增长说明微信在频繁重试，检查响应耗时。
3. **下单失败**：`create-order` 失败**不重试**（会产生重复订单）。用户只看到固定人话；原始异常不得写入回复、支付链接或完整请求体。

---

## 10. 合规提醒

- 这是个人开发者的技术方案，不是麦当劳官方服务，对外说明时必须写清楚
- 用户下单产生的是**真实订单、真实付款**，任何"自动确认"的实现都是危险的 ——
  本项目用一次性确认令牌 + 状态机把这条锁死（见 `src/safety/`）
- 不要把 `MCD_MCP_TOKEN` 与其它账号共享；它是你个人账号的凭据
