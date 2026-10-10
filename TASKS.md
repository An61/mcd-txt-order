# TASKS.md — 任务清单

> 状态图例：⬜ 未开始 · 🟨 进行中 · ✅ 完成 · ⛔ 阻塞
> 优先级：**P0 = 报名或安全红线，缺了不行** · P1 = 影响体验 · P2 = 锦上添花

---

## 里程碑总览（M0~M7 与下方 S0~S7 一一对应）

| 里程碑 | 目标 | 对应任务 | 依赖 |
|---|---|---|---|
| **M0 基建就绪** ✅ | MCP 跑通、凭据就位 | T1~T3 | — |
| **M1 内核可跑** ✅ | 无需真实 Token 也能走完离线演示 | T4~T9, T36 | M0 |
| **M2 安全与会话** ✅ | 红线机制全部就位 | T10~T13 | M1 | ✅ 已完成（check-m2 83 项全绿） |
| **M3 下单编排** ✅ | 真实链路跑通 + CLI 入口可用 | T14~T18 | M2 | ✅ 已完成（check-m3 36 项全绿，含真实链路） |
| **M4 渠道完成** ✅ | 模拟器 + 公众号都可用 | T19~T23, T37 | M3 | ✅ 已完成（check-m4 74 项全绿） |
| **M5 参赛文件** ✅ | 报名硬条件齐备 | T24~T28 | M1 | ✅ 已完成（README / 参赛声明 / MCP_INTEGRATION / workbuddy.md 齐备） |
| **M6 发布报名** | 公开仓库 + 报名 Issue | T29~T32 | M5 |
| **M7 冲榜** | 传播物料 | T33~T35 | M6 |

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
| T30 | 建 GitHub 公开仓库 `An61/mcd-txt-order` 并推送 | P0 | T29 | Public 可访问；创建时间在 2025-12-25 ~ 2026-10-25 区间内（由 GitHub 保证） | ⚠️ **阻塞**：本机无 `gh` CLI 且无 GitHub PAT，**无法代为创建远端仓库**。需用户在 GitHub 网页建空仓库后给授权，或提供 PAT |
| ~~T31~~ 🟡 | 生成报名 Issue 文案并提交 | **P0** | T30 | 格式符合模板，`≤1000 字`，**无图片**；提交后等待官方机器人回复成功通知 | 🟡 文案已就绪（`docs/REGISTRATION_ISSUE.md`，889 字、无图片、格式校验通过），待 T30 推送后可立即提交 |
| T32 | 验证报名成功回执 | P0 | T31 | Issue 下出现官方成功通知；若失败按回复原因修正后重提 |

---

## S7 冲榜（可选）

| ID | 任务 | 优先级 | 依赖 | 验收标准 |
|---|---|---|---|---|
| ~~T33~~ ✅ | README 首屏演示物料 | P1 | T20 | 30 秒内看懂核心能力 | ✅ `docs/demo.svg` 微信会话风格演示图，数据取自 `npm run demo` **真实输出**（非手写）；README 首屏嵌入，另折叠保留纯文本版。<br>**刻意用 SVG 而非 GIF**：零外部资源、断网可用、不占仓库体积、GitHub 双主题都能看，且不存在动图里误截真实 Token 的风险（T35） |
| T34 | 撰写技术要点文章 | P2 | T3 | 突出实测发现的隐藏能力与失败陷阱 |
| T35 | 推送前的礼节性检查 | P2 | T33 | 截图/动图中不得出现真实 Token 与支付链接 |

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
