# PLAN.md — mcd-txt-order 技术方案

---

## 1. 架构总览

```
┌─────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  微信客户端  │ ◄──► │   微信公众号服务器  │ ◄──► │   本项目服务      │
└─────────────┘      └──────────────────┘      │  (可选自托管)    │
                                               └────────┬────────┘
┌─────────────┐                                         │
│ 本地模拟聊天 │ ◄────────────── 同一套 Handler ─────────┤
│  (CLI/网页)  │                                         │
└─────────────┘                                         ▼
                                        ┌──────────────────────────┐
                                        │      ConversationCore    │
                                        │  意图 → 会话 → 编排 → 回复 │
                                        └────────────┬─────────────┘
                                                     │
                        ┌────────────────────────────┼──────────────────────┐
                        ▼                            ▼                      
              ┌──────────────┐            ┌────────────────────────┐
              │ Favorites    │            │      McpGateway        │
              │ 收藏/别名     │            │ 真实 MCP / Mock 双实现   │
              └──────────────┘            │ （Mock 数据内置于此，     │
                                           │  不另设 DataProvider）   │
                                           └───────────┬────────────┘
                                                       │
                                                       ▼
                                              https://mcp.mcd.cn
```

**核心设计原则：渠道无关。** 微信公众号只是众多输入渠道之一，`ConversationCore` 完全不知道消息来自微信还是命令行。这样：

- 评审者 clone 下来**不用申请公众号**就能跑 `npm run demo` 体验全流程 → 更容易获得 Star
- 后续接企业微信 / Telegram / Slack 只需新增 Adapter

---

## 2. 目录结构

```
mcd-txt-order/
├── SPEC.md                    需求规格
├── PLAN.md                    本文件
├── TASKS.md                   任务清单
├── README.md                  参赛必需：项目介绍
├── CONTEST_DECLARATION.md     参赛必需：官方原文，不可改动
├── MCP_INTEGRATION.md         参赛必需：MCP 使用说明
├── mcp-config.example.json    参赛必需：脱敏配置
├── workbuddy.md               参赛必需（WorkBuddy 积分）：开发对话上下文
├── .env.example / .gitignore
├── config/favorites.example.json
├── scripts/
│   ├── setup-token.cjs        把 Token 写入 MCP 配置与 .env
│   └── probe.ts               只读探针，抓取真实返回结构
└── src/
    ├── env.ts                 ✅ 已完成 .env 加载 + 脱敏
    ├── index.ts               CLI 入口
    ├── mcp/
    │   ├── client.ts          ✅ 已完成 零依赖 Streamable HTTP 客户端
    │   ├── normalize.ts       容忍式字段归一
    │   ├── nutrition.ts       list-nutrition-foods 的 Markdown 解析器
    │   └── gateway.ts         真实 MCP / Mock 数据 双实现切换
    ├── domain/
    │   ├── types.ts           门店/餐品/购物车/订单领域模型
    │   ├── intent.ts          意图识别
    │   ├── matcher.ts         四级降级模糊匹配 + 置信度
    │   ├── favorites.ts       收藏别名管理
    │   ├── session.ts         会话状态机（含 TTL）
    │   └── orderFlow.ts       检索→算价→确认→下单 编排
    ├── safety/
    │   ├── confirmation.ts    一次性确认令牌
    │   └── guard.ts           幂等 / 冷却 / 限额
    ├── channel/
    │   ├── core.ts            渠道无关的 ConversationCore
    │   ├── wechat.ts          验签 / XML / 被动回复 / 客服消息
    │   ├── server.ts          HTTP 服务
    │   └── mock.ts            CLI 与网页模拟器
    └── data/sample.ts         内置示例数据（离线演示）
```

---

## 3. 关键技术决策

### D1. 零依赖 + Node 原生执行 TypeScript

**决策**：不使用任何第三方包，运行时由 Node ≥ 22.6 的 `--experimental-strip-types` 直接执行 `.ts`。

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| Node 原生剥类型 | 零安装、零构建、clone 即跑 | 需 Node ≥ 22.6；不能用 enum/参数属性 | ✅ 采用 |
| 纯 JS + JSDoc | 兼容性最好 | 类型提示弱，代码观感差 | ❌ |
| TS + tsc 构建 | 类型最严格 | 需要 `npm i`，多一步构建，评审者易卡住 | ❌ |

> 比赛里 **clone 下来能不能立刻跑起来** 直接决定 Star 数，因此"零安装"权重高于"类型严格度"。

**已验证**：本机 Node v22.22.2 成功执行 TS 文件。

### D2. 喜爱门店优先走官方收藏能力

**决策**：`query-nearby-stores` 的 `searchType=1` 就是官方"收藏餐厅"。

- 优点：官方原生、跟随账号、不会因为我们在 `favorites.json` 里写死旧店名而失效
- 兜底：本地 `config/favorites.json` 保留**别名映射**（`香梅北 → 完整店名`），用于做关键词检索与消歧
- 即：**別名在本地，名单在云端**

### D3. 二次确认为强制流程

`create-order` 涉及真实资金。**任何**情况下都不允许"一句话直接下单"，即使配置了快捷模式。理由：

1. 手滑成本太高（真金白银）
2. 公众号是异步、弱交互的环境，用户很难判断自己刚才那句话有没有被正确理解
3. 评审会看这一点 —— 有安全设计的项目明显更成熟

> 落实方式（审计 F-03）：`.env` 的 `ORDER_REQUIRE_CONFIRM` 开关**仅在 Mock/演示模式生效**；真实 MCP 模式下**代码级强制开启、不可配置关闭**。防止误配置绕过红线。

### D4. 被动回复 5 秒超时的破解

**官方事实（developers.weixin.qq.com，一手来源）**：
- 微信服务器 5 秒内收不到响应会断连并**重试 3 次**（同一消息最多投递 4 次）
- 若不能在 5 秒内处理完，官方推荐**直接回复 `success` 或空串** —— 微信不再做任何处理、也不再重试，此时应改用客服消息接口异步回复
- 重试消息须排重：有 MsgId 的按 MsgId，事件按 FromUserName + CreateTime

而 `查询门店 → 菜单 → 算价` 链路存在超时风险（实测单工具响应快，但多级串联 + 网络抖动不可控，按超时设计更稳妥）。

**决策**：双阶段响应 + 双保险

```
收到消息 ──► 记录异步任务 ──► 5s 内被动回复「正在为你查询…」
                │                 （若处理逻辑已超过 4s，则改回 success 抑制重试）
                ▼
        后台完成 MCP 调用 ──► 客服消息接口异步推送结果
                                 （客服消息有 48h 窗口 + 条数限制，本项目
                                   推送在用户消息后数秒内，不受影响）
```

同时**按 MsgId 去重**（FR-24 / T37），即使发生重试也不会产生重复预览或重复消耗 MCP 配额。

若未配置 AppSecret（多数个人开发者没有），降级为：**下一次用户任意发言时回补结果**。

### D5. 容忍式字段解析

实测发现 MCP 同时返回 `structuredContent`（结构化）与 `content[].text`（Markdown），且不同工具的 `data` 形态不一（`list-nutrition-foods` 的 `data` 干脆是一整段 Markdown 字符串）。

**决策**：所有解析走 `normalize.ts`，多候选字段名 + 多层级探测；`list-nutrition-foods` 单独写 Markdown/CSV 解析器。解析失败时降级为原文展示，**不抛异常炸给用户**。

### D6. Mock 数据只用于演示，且必须显式标注

示例数据文件顶部写明"非官方数据，仅供离线演示"。**任何时候**只要有真实 Token，一律走真实 MCP，禁止静默 fallback —— 静默 fallback 会让用户以为自己下了真单。

---

## 4. 实现阶段

| 阶段 | 内容 | 产出 | 依赖 |
|---|---|---|---|
| **S0 基建** | env / MCP 客户端 / 探针 | ✅ 已完成 | — |
| **S1 领域内核** | types / normalize / nutrition / matcher / favorites / qty | 可离线跑通匹配 | S0 |
| **S2 安全与会话** | session / intent / confirmation / guard | 红线机制全部就位 | S1 |
| **S3 下单编排** | gateway / orderFlow | 真实 检索→算价→下单 链路 | S2 |
| **S4 渠道** | core / mock / wechat / server / MsgId去重 | 模拟体验 + 公众号可用 | S3 |
| **S5 参赛文件** | README / MCP_INTEGRATION / CONTEST_DECLARATION / workbuddy.md | 满足报名硬条件 | S1 |
| **S6 发布与报名** | 脱敏扫描 → 建仓推送 → 提 Issue | 完成报名 | S5 |
| **S7 冲榜** | GIF / 技术文章 | 传播物料 | S6 |

> ⭐ **报名窗口策略（审计 F-01）**：不要等 S4 渠道完成才报名。达到 S5 最低可报名状态即执行 S6 提 Issue 锁定资格，之后持续迭代冲 Star。排名按 2026-10-26 00:00 的累计 Star，晚报名 = 直接损失 Star 积累天数。

---

## 5. 风险与对策

| 编号 | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 用户账号无可用券/无配送地址，链路中断 | 中 | 逐步降级提示，引导先创建地址 |
| R2 | `takeWayCode` 取错导致下单失败 | 高 | 强制从 `calculate-price` 返回值中取，禁止写死 |
| R3 | Token 过期 | 中 | 401 立即降旗：停止一切写操作 |
| R4 | 误触真实下单造成资金损失 | **极高** | 双重确认 + 幂等 + 冷却 + 限额 + 失败不重试 |
| R5 | 个人公众号无客服消息权限 | 中 | 降级为"下次发言回补结果" |
| R6 | 仓库误提交 Token | **极高** | 发布前强制跑脱敏扫描（纳入 S6） |
| R7 | Star 数不够进不了前 100 | 中 | 提前报名锁定资格 + 持续迭代（见报名窗口策略）；见第 6 节传播策略 |
| R8 | 微信 5s 重试 3 次导致重复投递 | 高 | 按 MsgId 去重（FR-24 / T37）；来不及处理时回 `success` 抑制重试（官方推荐） |

---

## 6. Star 传播策略（比赛核心）

排名**完全由 Star 数决定**，前 100 进榜。因此传播点必须在设计阶段就埋进去：

| 策略 | 做法 |
|---|---|
| **提前报名** | 达到最低可报名状态立即提 Issue（排名按 10-26 累计 Star，多一天 = 多一天积累） |
| **零安装门槛** | `git clone` → 一条命令跑起 demo，**没有 Token 也能玩** |
| **所见即所得** | README 首页放终端会话 GIF，30 秒内看懂"发一句话能干嘛" |
| **真实稀缺性** | 强调实测发现的隐藏能力：官方 `searchType=1` 收藏餐厅、`takeWayCode` 依赖、`data` 是 Markdown —— 别的参赛者大概率不知道 |
| **安全叙事** | "会下单的 AI 必须能被叫停"，二次确认做成 poster 级卖点 |
| **可复用性** | `ConversationCore` 渠道无关，可接企业微信/Telegram，扩大受众 |
| **中文优先** | 全中文注释与文档，降低国内开发者阅读成本 |

---

## 7. 报名硬条件核对表

来源：活动仓库 README 与 `activityGuidelines.md`。

| 条件 | 文件 | 状态 |
|---|---|---|
| README.md（介绍/安装/示例/目标用户） | `README.md` | ☐ |
| 参赛声明，**文件名与内容均不可改动** | `CONTEST_DECLARATION.md` | ☐ 需原文照抄 |
| MCP 使用说明 | `MCP_INTEGRATION.md` | ☐ |
| 源代码 | `src/**` | 部分已完成 |
| 脱敏 MCP 配置（仅环境变量占位符） | `mcp-config.example.json` | ✅ |
| WorkBuddy 对话上下文（前100名可得3000积分） | `workbuddy.md` | ☐ |
| 仓库创建于 2025-12-25 ~ 2026-10-25 | GitHub 侧 | ☐ 待建仓 |
| Public 公开可访问 | GitHub 侧 | ☐ |
| 提格式为固定的报名 Issue，≤1000 字无图片 | Issue | ☐ |
| 不含真实 Token / 个人信息 | 全仓库 | ☐ 待扫描 |

---

## 8. 当前已完成

- ✅ Token 已写入 `~/.workbuddy/mcp.json` 与项目 `.env`（后者已 gitignore）
- ✅ 零依赖 MCP 客户端 `src/mcp/client.ts`
- ✅ `.env` 加载与脱敏 `src/env.ts`
- ✅ 只读探针 `scripts/probe.ts`，实测握手成功，取得 **35 个工具**的真实签名
- ✅ 配置骨架：`.env.example` / `.gitignore` / `mcp-config.example.json` / `config/favorites.example.json`
