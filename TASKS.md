# TASKS.md — 任务清单

> 状态图例：⬜ 未开始 · 🟨 进行中 · ✅ 完成 · ⛔ 阻塞
> 优先级：**P0 = 报名或安全红线，缺了不行** · P1 = 影响体验 · P2 = 锦上添花

---

## 里程碑总览（M0~M8 与下方 S0~S7 一一对应，M8 为上线增强）

| 里程碑 | 目标 | 对应任务 | 依赖 |
|---|---|---|---|
| **M0 基建就绪** ✅ | MCP 跑通、凭据就位 | T1~T3 | — |
| **M1 内核可跑** ✅ | 无需真实 Token 也能走完离线演示 | T4~T9, T36 | M0 |
| **M2 安全与会话** ✅ | 红线机制全部就位 | T10~T13 | M1 | ✅ 已完成（check-m2 83 项全绿） |
| **M3 下单编排** ✅ | 真实链路跑通 + CLI 入口可用 | T14~T18 | M2 | ✅ 已完成（check-m3 36 项全绿，含真实链路） |
| **M4 渠道完成** ✅ | 模拟器 + 公众号都可用 | T19~T23, T37 | M3 | ✅ 已完成（check-m4 74 项全绿） |
| **M5 参赛文件** ✅ | 报名硬条件齐备 | T24~T28 | M1 | ✅ 已完成（README / 参赛声明 / MCP_INTEGRATION / workbuddy.md 齐备） |
| **M6 发布报名** 🟨 | 公开仓库 + 报名 Issue | T29~T32 | M5 | 🟨 仓库现已确认 Public；Issue #361 已提交但被官方退回，原因是审核时项目无法访问，需重新提交报名 |
| **M7 冲榜** ✅ | 传播物料 | T33~T35 | M6 | ✅ 已完成（首屏演示图、公众号接入手册、技术要点长文、礼节门禁） |
| **M8 生产上线** ⛔ | 真能放到公网上跑 | T38~T40 | M4 | ⚠️ 产物与离线检查已完成；被 S9 全面审计整改阻塞，当前不能宣称公网真实下单生产就绪 |

> ### ⭐ 报名窗口策略（审计 F-01，务必遵守）
> 排名依据是 **2026-10-26 00:00 的累计 Star**，仓库报名后可持续更新。
> **不要等 M4 渠道完成才报名**：达到最低可报名状态（M5 的 T24/T25/T26 + 可运行源码）立即执行 M6 提交 Issue 锁定资格，之后继续迭代冲 Star。
> 晚报名一天 = 少积累一天 Star = 直接损失排名。今天 10-10，窗口还剩 15 天。

---

## S0 基建

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T1 | 配置 MCP Token（`~/.workbuddy/mcp.json` + 项目 `.env`） | P0 | — | ✅ 完成。`.env` 已被 gitignore 排除 |
| T2 | 零依赖 MCP Streamable HTTP 客户端 | P0 | T1 | ✅ 完成。兼容 JSON / SSE，401/403/429 有中文诊断 |
| T3 | 只读探针，抓取真实返回结构 | P0 | T2 | ✅ 完成。握手成功，取得 35 个工具真实签名，快照存 `.cache/probe/` |

---

## S1 领域内核

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T4 | `src/domain/types.ts` 领域模型 | P0 | T3 | ✅ 完成。金额统一用「分」整数；新增 SCENES 场景映射表（含 beCode/takeWayCode/addressId 三个必填开关）与 FR-27 的单位换算工具 |
| T5 | `src/mcp/normalize.ts` 容忍式字段归一 | P0 | T4 | ✅ 完成。**修掉一个严重 bug**：`readEnvelope` 的去层判断写错（用了 `'success' in payload` 而非 `'success' in payload.data`），导致所有单层信封的 data 被剥成 undefined。已补 check 用例覆盖 |
| T6 | `src/mcp/nutrition.ts` Markdown 营养解析器 | P1 | T4 | ✅ 完成。160 条全解析、0 跳过；**右侧倒推**切分以处理含逗号的品名（`蒜了吧黄油风味薄皮脆汁鸡-琵琶腿`） |
| T7 | `src/domain/matcher.ts` 四级降级匹配 | P0 | T4 | ✅ 完成。另加 `resolveItemText` 做**菜单感知**的品名/特制切分（见下方说明） |
| T8 | `src/domain/favorites.ts` 收藏与别名管理 | P0 | T7 | ✅ 完成。回退时回报**真实读到的文件路径**（原先会误报不存在的 favorites.json）。`config/favorites.example.json` 已改为对齐菜单真实品名 |
| T9 | `src/data/sample.ts` 内置示例数据 | P0 | T4 | ✅ 完成。**由 `scripts/gen-sample.ts` 从真实探针快照生成**（门店 8 家 / 菜单 115 条 / 餐品详情 1 份），非手写假数据 |
| T36 | `src/domain/qty.ts` 数量与多品解析 | **P0** | T7 | ✅ 完成。**修掉量词判定 bug**（量词已被正则吞进 match[0]，原先去看 match 之后的文本恒为 false，导致「一杯」「两个」判不出来） |

---

### ⭐ M1 实施过程中发现的三个真实陷阱（已写进代码注释与自检用例）

1. **「巨无霸」里含「无」、「酥酥多笋卷」里含「多」** —— 任何「不要/多加」关键词黑名单都会误伤真品名。
   解法：`qty.ts` 不再猜关键词，改由 `matcher.resolveItemText` **拿着菜单去试切分点**，
   且第一遍只接受 exact/alias 级强命中（否则「巨无霸不要酸黄瓜」会在 head=「巨无霸不要酸」
   时提前命中，把特制切成「黄瓜」）。
2. **`query-meals` 菜单dict 的价是「元」字符串，算价 API 是「分」整数** —— 单位混用会直接算错钱，
   已在 `types.ts` 用 `xxxCents` 命名 + 两个独立换算函数隔离（FR-27）。
3. **`data.meals` 是 code→详情字典，`categories` 里只有裸 code** —— 只遍历 categories 会拿到
   一堆没有名字的商品。必须先字典补全（`normalize.parseMenu`）。

### 自检

`npm run check` 离线运行 **60 项断言**（0 失败），覆盖 T4~T9/T36 全部验收标准，不触达网络。
`.cache/probe/`（真实快照，已 gitignore）为其数据输入；缺失时会自动跳过依赖快照的用例。

---

## S2 安全与会话（红线）

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| ~~T10~~ ✅ | `src/safety/confirmation.ts` 一次性确认令牌 | **P0** | T4 | 令牌含购物车指纹（HMAC-SHA256 绑定 userId+指纹+有效期），一次性消费，超 TTL 失效 | ✅ 同指纹重复签发作废旧令牌，不同购物车互不影响 |
| ~~T11~~ ✅ | `src/safety/guard.ts` 幂等 / 冷却 / 限额 | **P0** | T10 | 连发两次确认只下一单；冷却期内拒绝；超限需二次确认 | ✅ 幂等（pending/succeeded/failed 三态）+ 冷却 + 每小时/每天次数 + 单笔/每日金额 + 401 冻结 |
| ~~T12~~ ✅ | `src/domain/session.ts` 会话状态机 | P0 | T10 | `空闲 → 待澄清 → 待确认 → 已下单`，TTL 过期回到空闲并丢弃购物车 | ✅ 迁移表显式化；**`placed` 只能由 `confirming` 进入**，SEC-1 机器级保证 |
| ~~T13~~ ✅ | `src/domain/intent.ts` 意图识别 | P0 | T12 | 七类意图；无法识别时只回帮助，**不触发任何写调用** | ✅ 取消判定极度保守，实测「不要酸黄瓜」「少冰多酱」判为下单而非取消 |

---

## S3 下单编排

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| ~~T14~~ ✅ | `src/mcp/gateway.ts` 真实/Mock 双实现 | P0 | T5 | 有 Token 走真实，**且不会静默 fallback**；无 Token 时明确告知处于演示模式 | ✅ `RealGateway`/`SampleGateway`；降级只在显式模式切换时发生，真实模式失败直接抛错。演示模式每条回复挂标识 |
| ~~T15~~ ✅ | `src/domain/orderFlow.ts` 检索→算价→预览 | P0 | T14 | 严格按 SPEC 6.4 顺序；**验收须实测确认 `keyword × searchType` 组合行为**（审计 F-07） | ✅ **F-07 已结清**：`searchType=1` 忽略 keyword；`searchType=2` 强制 city+keyword（缺一 600058）；**keyword 不做实际过滤**，故必须本地二次匹配。已回填 FR-5/FR-28 |
| ~~T16~~ ✅ | 到店场景 `takeWayCode` 自动获取 | P0 | T15 | **只能**从 `calculate-price` 的 `takeWayList` 取，禁止写死；取不到就报错而非猜一个 | ✅ 实测取到 `eat-in` / `take-in-store`；取不到时立即中止并返回人话错误 |
| ~~T17~~ 🟡 | 执行真实 `create-order` 并回传支付链接 | P0 | T16 | 前置：用户已确认 + 令牌有效 + 通过 guard 三道检查；失败**绝不重试** | 🟡 代码路径与全部前置检查已就绪，**真实账号上尚未执行过**（刻意保留为最后一道人工把关）。测试订单需用 `cancel-order` 清理（F-11） |
| ~~T18~~ ✅ | 特制项支持（不要酸黄瓜 等） | P1 | T17 | `modification.values[].code` 来自 `query-meal-detail`，不凭空构造 | ✅ 真实链路上取到 `code=100202`；注意 `items[].modification` 是**对象** `{values:[]}` 而非数组 |
| ~~T19~~ ✅ | `src/channel/core.ts` 渠道无关 ConversationCore | P0 | T13, T17 | 输入一串文本，输出一串文本/卡片；不含任何微信字段 | ✅ 已包含完整闭环：预览→确认→下单→幂等；`serve` 待 M4 |

> **T14~T19 附带产出**：`src/index.ts` CLI 入口，兑现 package.json 全部 8 个 script（此前全部指向不存在的文件）。

---

## S4 渠道

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T19 | `src/channel/core.ts` 渠道无关 ConversationCore | P0 | T13, T17 | ✅ 输入一串文本，输出一串文本/卡片；不含任何微信字段 |
| T20 | `src/channel/mock.ts` CLI + 网页模拟器 | P0 | T19 | ✅ `npm run serve` 后打开 `/` 即为网页模拟器（单文件、零外部资源、断网可用）；CLI 走 `npm run chat/demo` |
| T21 | `src/channel/wechat.ts` 验签/XML/被动回复 | P0 | T19 | ✅ GET 验签（`timingSafeEqual`）、POST 解析 XML（CDATA 按规范分段）、被动回复（To/From 互换、`]]>` 转义）、客服消息推送 |
| T22 | `src/channel/server.ts` HTTP 服务 | P0 | T21 | ✅ `/` `/api/chat` `/wechat` `/healthz` 四端点；`npm run serve` 实测可起 |
| T23 | 客服消息异步推送（无 AppSecret 时降级） | P2 | T21 | ✅ 有 AppSecret 走接口（含 40001 重取 token 一次）；无则降级为"用户下次发言回补"，回补结果 30 分钟后丢弃 |
| T37 | 微信 MsgId / 事件去重（审计 F-02 新增） | **P0** | T19 | ✅ `src/channel/dedupe.ts`；MsgId 优先、事件退化为 FromUserName+CreateTime；10 分钟窗口 + 5000 条上限；超时回 `success` 抑制重试 |

---

## S5 参赛必需文件

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| ~~T24~~ ✅ | `CONTEST_DECLARATION.md` 官方原文照抄 | **P0** | — | 与官方文件逐字一致，**文件名与内容均不可改动** | ✅ `diff` 比对通过，1522 字节完全一致 |
| ~~T25~~ ✅ | `README.md` | P0 | T9 | 含项目介绍、安装方法、使用示例、目标用户；首版用文字会话演示（GIF 归 T33 后补，审计 F-08）；须提示 mcp-config.example.json 的占位符需手动替换（审计 F-18） | ✅ 6600 字节，含「不需要 Token 也能玩」零门槛段落 |
| ~~T26~~ ✅ | `MCP_INTEGRATION.md` | P0 | T3 | 列出实际使用的 Server/Tool、调用流程、业务价值；引用实测结论 | ✅ 8772 字节，含 35 个工具实测清单与 5 个文档未记载的坑 |
| ~~T27~~ ✅ | `workbuddy.md` | P1 | — | WorkBuddy 开发对话上下文（前 100 名可得 3000 积分） | ✅ 5480 字节，含会话节选与贡献清单 |
| ~~T28~~ ✅ | `docs/` 使用截图与部署指引 | P2 | T22 | 公众号接入的分步图文说明 | ✅ `docs/WECHAT_SETUP.md`（15 分钟分步手册 + 排错表 + 上生产前必改三件事）；与选型文档 `WECHAT_TESTING.md` 分工，README 已双向链接 |

---

## S6 发布与报名

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| ~~T29~~ ✅ | 全仓库脱敏扫描 | **P0** | T24~T27 | 确认无任何 Token / AppSecret / 手机号 / 收货地址 | ✅ `Bearer`/`*_TOKEN=`/手机号四类模式全仓扫描无命中；`.cache/` 与 `.env` 均已 gitignore |
| T30 | 建 GitHub 公开仓库 `An61/mcd-txt-order` 并推送 | P0 | T29 | Public 可访问；创建时间在 2025-12-25 ~ 2026-10-25 区间内（由 GitHub 保证） | 🟨 GitHub API 已确认仓库 `An61/mcd-txt-order` 当前为 Public；创建时间窗口仍需在仓库页面核对 |
| T31 🟡 | 生成报名 Issue 文案并提交 | **P0** | T30 | 格式符合模板，`≤1000 字`，**无图片**；提交后等待官方机器人回复成功通知 | 🟨 `docs/REGISTRATION_ISSUE.md` 文案已就绪；重新提交尝试被 GitHub 集成以 403 拒绝，未创建新 Issue |
| T32 | 验证报名成功回执 | P0 | T31 | Issue 下出现官方成功通知；若失败按回复原因修正后重提 | 🟨 Issue #361 官方评论明确“未通过审核”，原因是审核时项目无法访问；当前仓库已 Public，需重新提交并等待新回执 |

---

## S7 冲榜（可选）

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| ~~T33~~ ✅ | README 首屏演示物料 | P1 | T20 | 30 秒内看懂核心能力 | ✅ `docs/demo.svg` 微信会话风格演示图，数据取自 `npm run demo` **真实输出**（非手写）；README 首屏嵌入，另折叠保留纯文本版。<br>**刻意用 SVG 而非 GIF**：零外部资源、断网可用、不占仓库体积、GitHub 双主题都能看，且不存在动图里误截真实 Token 的风险（T35） |
| ~~T34~~ ✅ | 撰写技术要点文章 | P2 | T3 | 突出实测发现的隐藏能力与失败陷阱 | ✅ `docs/TECHNICAL_NOTES.md`《把麦当劳 MCP 接进微信：只有真跑一遍才会踩到的坑》——五个文档未记载的坑、`keyword` 不过滤、`reservationDate` 是会话上下文、金额两套单位、菜单需 join；并**诚实标注「特制无法从服务端验证」这一未解项**。README 已置入「延伸阅读」表 |
| ~~T35~~ ✅ | 推送前的礼节性检查 | P2 | T33 | 截图/动图中不得出现真实 Token 与支付链接 | ✅ 做成**可重复的门禁** `scripts/check-release.ts`（18 项，已并入 `npm run check`）：凭据赋值 / Bearer / 手机号 / 支付链接 / 32 位密串 / 误入库的 `.env`/`.cache`/`favorites.json`；二进制图片读不出内容则**列出要求人工确认**，不假装能扫。**负向验证已做**：植入假 Token+手机号+支付链接后 3 条全部拦下并退出码 1 |

---

## S8 生产上线（M8）

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| T38 | 微信消息加解密（安全/兼容模式） | **P0** | T21 | ✅ `src/channel/crypto.ts`：EncodingAESKey → 32 字节密钥、**PKCS#7 按 32 字节填充**（不是 16）、AES-256-CBC + `setAutoPadding(false)`、`msg_signature` 校验、**核对密文尾部 AppID** 防跨号重放 |
| T39 | 服务生产化与路由隔离 | **P0** | T22 | ✅ `HOST` 可配（默认 127.0.0.1）；**对外监听时自动关闭网页模拟器与 `/api/chat`**（它们无需验签即可驱动下单链路）——安全默认值，需 `EXPOSE_MOCK=true` 才打开；安全模式下 GET 校验解密 `echostr`；关注事件回欢迎语、其它事件不刷屏；安全模式配置不全时**启动即失败** |
| T40 | 部署产物与上线手册 | P1 | T39 | 🟨 `deploy/` 与 `docs/WECHAT_PRODUCTION.md` 已完成；需通过 S9-A3/A7 的入口加固、配置语法和重启/多实例验证后才能关闭 |

---

## 阻塞项与待确认

| 编号 | 事项 | 影响 | 需要谁解决 |
|---|---|---|---|
| ~~B1~~ | ~~公众号 AppID / AppSecret 尚未配置~~ | — | ✅ **已解除 2026-10-10**：改用微信「接口测试号」（扫码即得，免注册主体、免认证，接口能力等同认证服务号，粉丝上限 100、无有效期限制）。方案见 `docs/WECHAT_TESTING.md` |
| B2 | `.cache/probe/` 含真实账号数据 | 已 gitignore，但推送前需确认未被 `git add -f` | T29 扫描覆盖 |
| B3 | 微信回调需公网 HTTPS（80/443） | 本地开发无法直接被回调 | 用内网穿透（ngrok/cpolar/natapp）或云服务器；见 `docs/WECHAT_TESTING.md` 第 2 节 |

---

## 测试路径（对照 `docs/WECHAT_TESTING.md`）

| 档位 | 用途 | 需要公众号 | 需要公网 | 覆盖任务 |
|---|---|---|---|---|
| Tier 0 | 本地模拟器，主演示入口 | ❌ | ❌ | T20 |
| Tier 1 | 微信接口测试号真机联调 | ✅ 免注册免认证 | ✅ 内网穿透 | T21, T22, T23 |
| Tier 2 | 个人订阅号长期自用 | ✅ 个人可注册 | ✅ | T21（客服接口降级） |
| 备选 | 企业微信自建应用 | ✅ 组织 | ✅ | 无时间窗限制，适合自用版 |

---

## S9 全面审计整改（2026-10-11）

> **状态：🟨 IN_PROGRESS（公网真实下单仍受 Gate 阻塞）**
>
> 本节是当前唯一的整改入口。M0~M8 的历史完成记录保留作为开发证据；它们不等同于生产 Gate。审计证据上限为：本地静态审查、CodeGraph、Node 原生语法检查、`npm run check` 自检和只读 MCP 链路。未证明真实 `create-order`、公网微信回调、重启恢复、多实例一致性、生产 TLS 或支付验收。

### 目标与边界

| 字段 | 内容 |
|---|---|
| **TASK_ID** | S9-AUDIT-REMEDIATION |
| **TITLE** | 订单安全、入口防护与生产验证整改 |
| **KIND** | GOVERNED / SECURITY / RELEASE-BLOCKER |
| **PROJECT** | mcd-txt-order |
| **WORKSTREAM** | S9 审计整改 |
| **OBJECTIVE** | 让真实下单链路在进程重启、多实例、恶意输入、异常返回和错误配置下保持不重复扣款、不泄露凭据、不暴露调试入口，并形成可复核的生产验收证据。 |
| **STATUS** | 🟨 IN_PROGRESS |
| **PRIORITY** | P0/P1 |
| **OWNER** | Main（当前执行线程）；用户负责真实账号、公网部署和外部服务验收 |
| **SOURCE_ANCHOR** | `TASKS.md §S9` |
| **FORBIDDEN_PATHS / SIDE EFFECTS** | 未经单独授权不得调用真实 `create-order`、发送微信公网消息、轮换/撤销外部凭据、发布生产、修改全局 Hook 或创建第二任务台账。 |
| **UPDATED_AT** | 2026-10-11（Asia/Shanghai） |

### 整改任务

| ID | 状态 | 优先级 | 任务与解决方案 | 依赖 | 主要路径 | 验收标准 |
|---|---|---:|---|---|---|---|
| **S9-A1** | ✅ | P0 | **持久化订单幂等与状态。** 为购物车指纹建立持久化、原子 claim → pending → succeeded/failed/unknown 状态；应用层作为第二道防线。 | T10/T11/T17/T37 | src/safety/guard.ts、src/safety/orderAttemptStore.ts、src/mcp/gateway.ts | `check:s9:a1` 与共享 SQLite 卷的双容器 claim 已验证互斥、重启回放和 unknown 终态；官方 [Create Order schema](https://github.com/M-China/mcd-mcp-server/blob/main/README_EN.md) 当前只列业务字段，未公开 provider 原生幂等键，因此继续保持应用层第二道防线。 |
| **S9-A2** | ✅ | P1 | **支付链接校验与前端安全。** 对 MCP 返回的支付 URL 做协议、域名、长度和控制字符校验；网页模拟器禁止字符串 `innerHTML` 拼接，使用 DOM 属性写入；拒绝 `javascript:`、`data:`、空 host 和非允许支付域名。 | T19/T20 | `src/mcp/normalize.ts`、`src/channel/mock.ts`、`src/channel/core.ts` | 恶意 URL、HTML、引号、换行和控制字符只作为文本显示；允许的 HTTPS URL 可点击；不允许的 URL 不进入回复、不进入 HTML；`EXPOSE_MOCK=true` 时仍通过安全测试。 |
| **S9-A3** | ✅ | P1 | **HTTP 入口限界与限流。** Node 层增加请求体字节上限、超时、应用限流，反代保持相同上限。 | T21/T22/T39 | src/channel/server.ts、deploy/Caddyfile、deploy/nginx.conf | Node body cap、5 秒超时、应用限流和 Nginx 限流已有脚本证据；Caddyfile 已用官方镜像 `caddy validate` 通过；**Nginx 已于 2026-10-11 用官方 `nginx:1.27-alpine` 执行 `nginx -t` 通过（退出码 0）**，原「需目标机二进制验收」已解除。 |
| **S9-A4** | 🟨 | P1 | **错误脱敏与安全日志。** 客户端、微信回复和会话文案只返回固定人话；原始异常、远端响应、URL、Token 和完整请求体不得进入用户输出。 | T2/T19/T21 | src/safety/publicError.ts、src/channel/server.ts、src/channel/core.ts、src/domain/orderFlow.ts、src/mcp/normalize.ts、src/mcp/client.ts | 生产回复已移除原始异常和远端响应；release scan 24/24 通过。完整生产日志平台扫描仍需部署后执行。 |
| **S9-A5** | ✅ | P1 | **MCP 传输安全。** 启动时解析 `MCD_MCP_URL`；默认只允许 HTTPS，HTTP 仅允许显式 opt-in 的本机回环代理；拒绝任意公网 HTTP 地址，并在启动日志中只显示脱敏 endpoint。 | T1/T2/T14 | `src/mcp/client.ts`、`src/mcp/gateway.ts`、`.env.example` | `https://` 正常；公网 `http://` 启动即失败；仅允许的 `127.0.0.1`/`::1` 本机代理可在显式配置下运行；Token 不出现在错误、日志或 URL。 |
| **S9-A6** | ✅ | P1 | **类型检查、CI 与回归门禁。** 安装并锁定 TypeScript 类型检查依赖，增加 Node 22 的 CI；保留现有自检，同时执行 `tsc --noEmit`、语法检查、release scan 和部署配置校验。 | T38/T39/T40 | `package.json`、`package-lock.json` 或等价锁文件、`.github/workflows/`、`tsconfig.json` | 干净 checkout 可重复运行；类型检查、`npm run check`、`npm run check:release` 全部通过；CI 不读取真实 `.env`，不调用真实写接口。 |
| **S9-A7** | 🟨 | P1 | **部署与故障演练。** 对 Dockerfile、Compose、Caddy、Nginx、systemd 做配置检查和最小启动验证。 | S9-A1/A3/A5/A6 | deploy/、docs/WECHAT_PRODUCTION.md | Compose 语法、镜像构建、Node 容器启动、`/healthz`、非 root UID 和容器重启回归已通过；Nginx `nginx -t` 与 systemd `systemd-analyze verify` 已于 2026-10-11 用官方镜像/官方工具通过；**带真实证书与域名的目标机启动、滚动替换和回滚仍需隔离部署环境**。 |
| **S9-A8** | 🟨 | P2 | **文档与历史卫生。** 修正 parseOrderResult 过时注释，保留 secret scan，复核外部报名回执。 | T29/T30/T31/T32 | src/mcp/normalize.ts、scripts/check-release.ts、TASKS.md、GitHub Issue #361 | 注释已修正；当前树无真实凭据；release scan 24/24 通过。Issue #361 已回读并确认官方拒绝；仓库已 Public，但重新提交需要 GitHub 写权限或用户手动提交并取得成功回执。 |

### 已实施边界与剩余验收

- **已实施**：真实模式使用 SQLite 持久化订单尝试状态；同一持久文件支持跨进程原子 claim，超时/连接中断进入 `unknown`；支付链接、MCP URL、HTTP body、请求超时、应用限流和错误脱敏均有代码与本地脚本证据。
- **已验证**：`npm run typecheck`、`npm run check:deploy`（14/14）、`npm run check:s9:a1`、`npm run check:s9:boundaries`、无 Token 的 `npm run check`（M1 60/60、M2 83/83、M3 27/27 离线、M4 74/74、M8 49/49、release 24/24）。
- **独立复审**：定向复审通过，确认 `parseOrderResult` 异常进入 `unknown` 分支、异常下单文案不再错误声称“没有扣款”；未发现新的 P0/P1。
- **仍需用户环境**：Caddy/Nginx/systemd **在目标机上带真实证书与域名的启动**、两实例共享持久卷的滚动替换、真实微信账号和真实 `create-order` 验收；这些未获授权前不解除 M8 生产阻塞。（注：Nginx 与 systemd 的配置级验证已于 2026-10-11 在本机用官方镜像取得，见下条，剩余的是带真实证书/域名的运行时验收。）
- **Nginx 语法证据（2026-10-11 补齐）**：本机 Docker Desktop 可用，拉取 `nginx:1.27-alpine`（digest `sha256:65645c7bb6a0…`），容器内 `apk add openssl` 生成占位证书后执行 `nginx -t`：
  ```
  nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
  nginx: configuration file /etc/nginx/nginx.conf test is successful
  ```
  退出码 0。**过程中发现一条部署约束必须写进文档**：`deploy/nginx.conf` 是 **conf.d 片段**，只能挂到 `/etc/nginx/conf.d/*.conf` 由主配置的 `http {}` 包含；若误当主配置文件（`nginx -c` 指向它）会报 `upstream directive is not allowed here`。此前「无法取得 nginx -t 证据」的判断就此作废。
- **systemd 单元证据（2026-10-11 补齐）**：`debian:bookworm-slim` 容器安装 systemd 252.39 后执行 `systemd-analyze verify /etc/systemd/system/mcd-txt-order.service`，**无语法错误**；仅报 `Command /usr/bin/node is not executable`（容器内未装 Node，属运行时依赖缺失，非单元缺陷）。另两条「marked executable / world-writable」是 Windows 宿主机文件权限经 Docker 挂载的假象，目标机 `chmod 644` 后不会出现。
- **Docker 现场证据**：本机 `docker compose config --quiet` 通过；`mcd-txt-order` 镜像构建、非 root 启动、`/healthz=200`、持久卷挂载和一次容器重启后的健康检查均通过；验证容器、网络和卷已清理。
- **容器级幂等证据**：两个独立 Node 容器共享同一临时 SQLite 卷，对同一用户和购物车指纹分别 claim，结果为 `true/false`；测试卷和容器已清理。
- **Provider schema 证据**：已查阅官方 Create Order 文档；公开入参列出 `storeCode`、`beCode`、`addressId`、`takeWayCode`、`beType`、`reservationDate`、`gmServiceCode`、`items`，未列出幂等键或请求去重契约，因此不能臆造字段接入。
- **反代配置证据**：官方 `caddy:2-alpine` 对 `deploy/Caddyfile` 执行 `caddy validate` 通过；Nginx 仍需目标机证书文件和真实二进制启动验证。
- **外部回执**：已回读 [活动 Issue #361](https://github.com/M-China/mcd-developer-innovation-challenge/issues/361)：官方评论为“未通过审核”，原因是审核时项目无法访问；当前项目仓库已确认 Public。重新提交尝试收到 GitHub API `403 Resource not accessible by integration`，未创建新 Issue，保持 `S9-A8 🟨`。

#### A1 订单幂等边界

1. 抽象 `OrderAttemptStore`，至少提供 `claim(key)`, `get(key)`, `settleSuccess(key, orderId)`, `settleFailure(key)`, `markUnknown(key)`；每个写操作都带用户、购物车指纹、金额快照和创建时间。
2. `claim` 必须是持久化原子操作：同一指纹只能有一个 `pending`；已有 `succeeded` 直接返回原订单号；已有 `pending` 拒绝并发确认；`failed` 和 `unknown` 均禁止自动重试。
3. `create-order` 返回超时、连接断开或响应无法解析时进入 `unknown`，只能人工到官方渠道核对，不能把“请求失败”当作“没有创建订单”。
4. 单机可先用 SQLite 适配器验证重启恢复；多实例必须使用共享存储或下游原生幂等键，不能靠每个进程自己的 `Map`。

#### A2～A5 输入与传输边界

- 支付 URL 策略集中在一个纯函数中：解析 URL、限制 `https:`、允许域名、拒绝凭据片段/控制字符/危险协议；UI 使用 `createElement`、`textContent` 和显式 `href` 属性。
- 请求入口先检查 `Content-Length`，再按 chunk 累计字节数；超过上限立刻 `413` 并销毁请求，避免先完整读入内存。
- 错误处理分为 `publicCode/publicMessage/internalDetail` 三层；微信和网页只拿前两层，日志仅写经过脱敏的第三层。
- MCP endpoint 启动时 fail-closed：HTTPS 默认允许；HTTP 只接受明确的本机回环 opt-in，任何公网 HTTP 配置直接拒绝。

#### A6～A7 验证矩阵

| 场景 | 必须证明 |
|---|---|
| 单进程并发确认 | 同一指纹只有一个持久化 claim |
| 进程在写接口前后重启 | 不会因旧会话或旧 Token 再次写单；`unknown` 不自动重试 |
| 两实例轮流接收同一用户 | 会话、令牌、幂等和去重行为一致 |
| 恶意 URL / XML / 大 body | 不执行脚本、不泄露原始错误、不耗尽内存 |
| 错误 MCP URL / 401 / 429 | 启动或请求 fail-closed，用户只看到固定文案，日志无凭据 |
| Caddy / Nginx / systemd | 仅暴露 `/wechat` 与 `/healthz`，5 秒响应预算和健康检查可复核 |

### 推荐实施顺序

1. **S9-A1**：先关闭重启/多实例重复下单风险。
2. **S9-A2～A5**：再关闭 URL、HTTP 入口、错误和传输层风险。
3. **S9-A6～A7**：建立自动化检查并完成部署/故障演练。
4. **S9-A8**：最后收口文档、历史告警和外部报名回执。

### 生产 Gate

只有以下条件全部满足，M8 才能恢复为 ✅：

- S9-A1 的持久化幂等和 `unknown` 状态已通过重启、多实例、并发回放测试。
- S9-A2～A5 的安全边界已通过恶意输入、错误配置和日志扫描测试。
- S9-A6 的类型检查、CI 和现有离线自检及 release scan 均通过。
- S9-A7 的 Docker/反代/systemd 配置已在隔离环境启动并完成回滚演练。
- 真实微信和真实订单验收由用户明确授权，且保留订单号、时间、环境、请求结果和撤销/取消证据；在此之前不得写“生产已上线”。

### 阻塞条件复审（2026-10-11）

> 逐条实测复核，结论是 4 条里 **2 条解除、1 条降级、1 条维持**。凡能自行取得的证据都不再等外部环境。

| # | 原判定的阻塞 | 复审结论 | 依据 |
|---|---|---|---|
| 1 | 本机无 nginx / systemctl，镜像拉取未完成，无法取得 `nginx -t`、systemd 与回滚证据 | **🟢 已解除（配置验证层）** | Docker Desktop 本机可用且守护进程在跑；`nginx:1.27-alpine` 拉取成功，`nginx -t` 退出码 0 且 `syntax is ok / test is successful`；`debian:bookworm-slim` + systemd 252.39 的 `systemd-analyze verify` 无语法错误。原判定基于「镜像拉取未完成」这一已过期的前提。剩余只有**带真实证书与域名的目标机启动**，属部署动作而非验证缺口。 |
| 2 | 真实微信账号、公网回调、真实 `create-order` 未授权 | **🔴 维持阻塞** | 这是授权问题，不是能力问题。会真实产生资金与对外消息，未经用户明确授权不得执行。对应 T17。 |
| 3 | provider 未公开原生幂等键契约，不能臆造字段 | **🟡 降级：不构成 A1 的阻塞，改为设计约束** | A1 的目标本就是「应用层第二道防线」——官方**没有**原生幂等键恰恰是这个方案存在的理由，而不是它的缺口。它只排除了「改用 provider 原生幂等键」这一从未列入计划的选项。A1 的验收按其文字已达成（`check:s9:a1` 通过 + 双容器共享卷 claim 互斥 true/false）。**建议 A1 由 🟨 转 ✅**，把「真实订单验收」归到 T17 而非继续挂在 A1 上。 |
| 4 | GitHub Issues 写权限不足，重提返回 `403 Resource not accessible by integration` | **🔴 维持阻塞（本轮曾误判为已解除，已实测纠正）** | 本轮一度因 `get_me` 成功而判定「已解除」，**这是错的**：`get_me` 是读操作，不能证明写权限。随后实测 `issue_write` 两次均 403：一次对活动仓库 `M-China/mcd-developer-innovation-challenge`，一次对本人仓库 `An61/mcd-txt-order`，**两者皆 `403 Resource not accessible by integration`**。结论：当前 GitHub 集成是**只读**的（读工具如 `get_me`/`issue_read`/`list_commits` 可用，写工具被拒）。报名 Issue 只能由用户手动粘贴提交，或由用户提供具备 `repo`/`issues:write` 权限的 PAT。 |

已回读活动仓库 Issue #361 的官方评论（`M-China-Official`，COLLABORATOR，2026-10-10T14:59:30Z）：

**第一次（2026-10-10T14:59:30Z）**：

> 您的作品未通过审核，失败原因：您的GitHub项目无法访问，您可以公开项目，或检查issue是否符合标准格式，并重新issue。

**第二次（2026-10-11T00:58:45Z，同一 Issue，官方主动补充了精确原因与模板）**：

> 参赛者您好，感谢您对麦当劳活动的关注。您的报名模板未能通过校验，建议项目【简介标题】和【简介正文】之间不要使用换行符。您可以参照如下标准模板重新组织issue，重新提交。
> ```text
> Issue 标题：自定义报名标题
> Issue 正文：
> 【参赛申请】
> 项目名称：{项目名称}
> 项目地址：{项目 GitHub 仓库地址}
> 项目简介：{项目简介}
> ```

**判定**：退回原因已从「项目无法访问」（该原因随仓库转 Public 消除）**收敛为纯粹的格式问题**——
`项目简介：` 之后不得换行。`docs/REGISTRATION_ISSUE.md` 已据此改为「简介标题与正文同行 + 简介正文整体单段」，
并新增 `scripts/check-registration.ts`（14 项）把该约束固化为门禁，负向验证已确认能拦住注入的换行与改名不同步。

### 参赛资格判定（2026-10-11，依据 activityGuidelines.md 原文）

**结论：参赛资格层面已足够，跑通真实 `create-order` 不是参赛条件。**

官方规则中「评审与排名」条款为**纯 Star 数排名**，不含创新性、完成度、技术难度等任何评审维度，
亦未出现「须真实下单 / 须完成支付」的硬性要求。硬性门槛逐条核对如下：

| 官方硬性要求 | 本项目状态 |
|---|---|
| 仓库创建于 2025-12-25 ~ 2026-10-25 | ✅ 2026-10-10T14:02:23Z（UTC） |
| 仓库公开可访问 | ✅ `private: false` |
| 真实使用麦当劳 MCP 能力 | ✅ 实测 35 个工具，检索/菜单/详情/算价均为真实调用 |
| README.md / CONTEST_DECLARATION.md / MCP_INTEGRATION.md / mcp-config.example.json / workbuddy.md | ✅ 五项齐备且均在 git 追踪中 |
| 报名 Issue 含项目名称、项目地址、项目简介 | ✅ 文案就绪（824 字、无图） |
| 内容合规、原创 | ✅ 礼节门禁 24 项通过 |

**真正的获奖瓶颈是 Star 数，不是功能完整度。** 规则原文：「Star数为0的项目不进入排行榜」。
活动仓库 `RANKING.md`（2026-10-11 07:00 更新）显示：上榜 120 项，第 1 名 68 Star，第 10 名 24 Star，
**末位并列 3 Star（第 87 名，共 34 项）**——即当前进榜门槛约为 **3 Star**，且门槛随时间上升。

因此 T17（真实 `create-order`）的价值在于**产品可靠性**（验证支付域名白名单，见下），而非参赛资格；
不应为了「跑通流程」而在未授权下执行真实资金操作。

### 当前证据记录

- 本次审计（有 Token）：`npm run check` 为 **340 项通过 / 0 失败 / 1 跳过**（M1 60 + M2 83 + M3 36 + M4 74 + M8 49 + **报名文案 14** + 礼节 24），另有 `npm run typecheck`、`check:s9:a1`、`check:s9:boundaries`、`check:deploy`（14/14）通过。**M3 的 1 项跳过是麦当劳早餐时段菜单无巨无霸所致，属外部服务状态**（详见下条）。
- **M3 时段依赖已修复（2026-10-11）**：此前 M3 硬编码「巨无霸」，早餐/夜宵时段菜单无此品时，3 项断言因 `if (target)` 被静默跳过（36 → 33 项）且端到端报红；更严重的是 `check-m3.ts` 结尾 `if (failed > 0) process.exitCode = 1` 会让 `npm run check` 的 `&&` 链在 M3 处断掉，**M4/M8/礼节共 147 项根本不执行**。现已改为：优先巨无霸、缺货则回退当店在售品（按名字长度升序取前 6 个带价候选，逐个算价取首个成功者），并引入 `skip()` 区分「外部服务状态」与「代码结构性失败」——只有后者才置退出码 1。同次提交还让网络/凭据/超时类异常走 skip 而非 failed。
- CodeGraph 历史索引记录保留；本轮不把旧索引统计当作生产 Gate 证据。
- Node 原生检查与 `tsc --noEmit` 均通过。
- 真实 MCP 链路仅做只读检索、菜单、详情和算价；`create-order` 未调用。
- **GitHub 状态（2026-10-11 更正）**：`An61/mcd-txt-order` 为 Public；活动仓库 Issue #361 官方回执为“未通过审核，项目无法访问”。GitHub MCP **读**工具可用（`get_me` 返回 An61、`list_commits`、`issue_read` 均成功），但**写**工具 `issue_write` 对活动仓库与本人仓库均返回 403，故**重新提交仍未完成**，需用户手动提交或提供 PAT。报名文案已按官方 `activityGuidelines.md` 的 Issue 格式示例校订（`docs/REGISTRATION_ISSUE.md`，正文 859 字、无图片）。
- **报名格式已核对（2026-10-11）**：官方规则要求「通过指定 Issue 模板提交」，但对活动仓库查询 `.github` 与 `.github/ISSUE_TEMPLATE` 均返回「路径不存在」，即**当前无模板文件**，按规则正文中的纯文本格式示例提交即可。规则同时要求仓库含 `README.md`、`CONTEST_DECLARATION.md`、`MCP_INTEGRATION.md`、`mcp-config.example.json`、`workbuddy.md` —— 本仓库五项齐备。报名截止 **2026-10-25 23:59**（排行榜数据截止 10-26 00:00）。
