# SPEC.md — mcd-txt-order 需求规格说明书

> 一句话：**在微信公众号里，给喜爱门店发一句「巨无霸 星河」，自动检索门店与餐品、算好价、等你确认后下单，并把支付链接回给你。**
>
> 本文所有 MCP 行为均基于 2026-10-10 对 `https://mcp.mcd.cn` 的**实测**（Token 可用状态），非文档推测。实测快照见 `.cache/probe/`（已 gitignore）。

> ⚠️ **渠道归属（重要澄清）**：上文中的「公众号」指的是**使用者自己的微信公众号**（或微信接口测试号），**不是麦当劳官方公众号**。
> 麦当劳开放的是 MCP「后厨能力」，本项目的「前台」由使用者自行搭建与部署。
> 因此本项目**不需要、也不可能**获得麦当劳官方公众号的开发权限。详见 `docs/WECHAT_TESTING.md`。

---

## 1. 目标与非目标

### 1.1 目标（本期必须达成）

| 编号 | 目标 |
|---|---|
| G1 | 用户通过微信文本消息完成「选门店 + 选餐品 + 确认 + 支付」全流程，无需打开 App |
| G2 | 喜爱门店与喜爱餐品**预置化**，日常下单压缩到一条短消息（目标是 6~12 个字） |
| G3 | 任何会产生真实资金支出的动作，都必须在执行前有一次明确的、用户主动的确认 |
| G4 | 无可用凭据（MCP Token / 公众号配置）时，项目依然可以 clone 下来跑通演示 |
| G5 | 满足麦当劳程序员创意开发大赛的全部报名硬性条件 |

### 1.2 非目标（明确不做）

| 编号 | 非目标 | 原因 |
|---|---|---|
| N1 | 不代持用户资金、不接入自有支付、**不经手支付链接以外的任何支付环节** | 支付由麦当劳官方链接完成，本项目不碰资金链路 |
| N2 | 不做自动化抢券、刷单、批量注册、定时任务刷榜 | 活动规则明令禁止，违规即取消资格 |
| N3 | 不做多商户 / 非麦当劳场景 | 超出 MCP 能力边界 |
| N4 | 不做 OCR 识别点单、不做微信群机器人 | 场景与权限不匹配 |
| N5 | 不承诺"最快"或"最省"，不与官方渠道做优劣对比 | 触发内容合规条款（贬低/对比品牌）风险 |

---

## 2. 用户故事

### 2.1 主故事（用户原话场景）

> **作为** 一个懒得打开 App 的麦当劳常客，
> **我希望** 在微信公众号发一句「巨无霸 星河」，
> **以便** 直接拿到示例市星河餐厅的巨无霸订单支付链接。

验收路径：

1. 用户发送 `巨无霸 星河`
2. 系统解析出 `{餐品: 巨无霸, 门店: 示例星河}`
3. 检索实时门店 → 检索实时菜单 → 计算实时应付价
4. 返回**预览卡片**（门店、餐品、数量、特制、实付金额、优惠明细）
5. 用户回复 `确认`
6. 系统调用 `create-order`，**返回支付链接**
7. 用户点击链接完成支付

### 2.2 派生故事

| 编号 | 故事 | 优先级 |
|---|---|---|
| US-1 | 发品名即可下单，使用默认喜爱门店 | P0 |
| US-2 | 指定门店：`巨无霸 星河` / `巨无霸 科技园店` | P0 |
| US-3 | 支持数量与多品：`两个巨无霸一杯可乐 星河` | P0 |
| US-4 | 支持特制：预置"巨无霸不要酸黄瓜"，也支持临时说 `不要洋葱` | P1 |
| US-5 | 支持组合套餐别名：`午饭`（= 辣堡+大薯+可乐） | P1 |
| US-6 | 门店或餐品匹配到多个时，列出候选让用户选序号，不擅自决策 | P0 |
| US-7 | 支持切换场景：到店自提 / 得来速 / 麦乐送 | P1 |
| US-8 | 随时取消：`算了` / `取消` 终止当前会话，不产生订单 | P0 |
| US-9 | 查询态（不关单）：`有什么优惠` / `我还有多少积分` | P2 |
| US-10 | 无 MCP Token 时用内置示例数据跑通全流程演示 | P0 |

---

## 3. 功能需求

### 3.1 消息路由与意图

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-1 | 支持文本消息；非文本（图片/语音/视频）回复友好提示 | P0 |
| FR-2 | 意图分为：`下单` `确认` `取消` `选择候选` `改配置` `查询` `帮助` 七类 | P0 |
| FR-3 | 输入具备容错：多余空格、全角/半角、错字、拼音首字母（`jwb`、`xinghe`） | P1 |
| FR-4 | 无法识别意图时，回复帮助文案，**不做任何 MCP 写调用** | P0 |
| FR-28 | **兜底城市为必需配置**：因 `searchType=2` 强制要求 city，当用户输入里没有城市线索且未配兜底城市时，必须明确向用户追问城市（`need-store`），不得猜测也不得静默使用任意城市 | P0 |
| FR-29 | 购物车指纹使用**双车道哈希（~64 位）**，而非 32 位 FNV。理由：守卫完全依赖指纹判定幂等，32 位在 6 万笔量级就有近 1% 碰撞率 | P0 |
| FR-25 | 数量与多品解析：支持中文数量词（`两个`/`3份`）与多品拆分（`两个巨无霸一杯可乐 星河`） | P0 |

### 3.2 检索与匹配

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-5 | 到店/得来速场景：门店检索按 **收藏优先、结果为空立即回退** 的降级链执行：`query-nearby-stores(searchType=1)` → 空则返回 `[600050]` → `query-nearby-stores(searchType=2, city, keyword)`。**实测已补全（2026-10-10，F-07 结清）**：① 收藏为空时报 `600050 收藏餐厅列表为空，请您提供城市+关键词进行搜索`；② `searchType=1` 时 **keyword 被忽略**，不存在"收藏+关键词过滤"组合；③ **`searchType=2` 强制要求 city 与 keyword 同时给出**，只给其一即报 `600058 城市名或者关键词不能为空`（→ 兜底城市成为必需配置，见 FR-28）；④ **`keyword` 并不真的按名称过滤** —— 搜「星河」返回周边 5 家不同名门店。**因此：别名在本地（favorites 映射），名单在云端，取回候选池后必须在本地再做一次名称匹配**，禁止直接取第一条。麦乐送走另一条路径 `delivery-query-stores`（需 `addressId`） | P0 |
| FR-26 | **`reservationDate` 全链路一致**：一旦 `query-meals` 带了 `reservationDate`（预约场景），后续 `query-meal-detail` / `calculate-price` / `create-order` 必须传**同一个值**，否则服务端判定商品不可售并报 `60001 / 60006` | P0 |
| FR-27 | **金额单位归一**：`query-meals` 的 `currentPrice` 是**元**的字符串（`"26.5"`），而 `calculate-price` 的 `price / subtotal / discount` 是**分**的整数（`2650`）。两者必须显式换算后再展示，禁止混用 | P0 |
| FR-6 | 菜单匹配必须基于 **`query-meals` 返回的真实 `storeCode` 菜单**，禁止使用本地写死的菜单 | P0 |
| FR-7 | 匹配采用「精确 > 别名 > 包含 > 模糊」四级降级，置信度低于阈值即转为候选列表 | P0 |
| FR-8 | 同一层级出现多个候选且最高分与次高分差 < 阈值时，必须让用户选，不得自动取第一个 | P0 |
| FR-9 | 支持"只要单汉堡"这类消歧（`巨无霸单汉堡` ≠ `巨无霸套餐`） | P1 |

### 3.3 定价与下单

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-10 | 下单前必须经过 `calculate-price` 取得真实应付价，并在预览卡片中展示 | P0 |
| FR-11 | 自动择优使用可用券（`query-store-coupons` / `query-my-coupons`），并把优惠明细列给用户 | P1 |
| FR-12 | **`create-order` 前必须有用户显式确认**（`确认` / `是` / `OK`）；预览卡片超时失效 | P0 |
| FR-13 | 同一用户对同一份预览重复发送确认时，**必须幂等**，不产生第二笔订单 | P0 |
| FR-14 | 两次真实下单之间有冷却时间，防止手滑连发 | P0 |
| FR-15 | 单笔金额超过阈值时，需二次强化确认 | P1 |
| FR-16 | 订单创建后如需取消，提供 `取消订单` 入口（`cancel-order`） | P2 |

### 3.4 会话与状态

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-17 | 每个用户独立会话状态机：`空闲 → 待澄清 → 待确认 → 已下单` | P0 |
| FR-18 | 会话有 TTL，过期自动回到空闲态并丢弃未确认的购物车 | P0 |
| FR-19 | 任一环节失败都需给出**人话**原因，禁止把 JSON 异常抛给用户 | P0 |

### 3.5 渠道

| 编号 | 需求 | 优先级 |
|---|---|---|
| FR-20 | 实现标准微信公众号服务：服务器配置校验（GET 验签）、消息接收（POST XML）、被动回复 | P0 |
| FR-21 | **被动回复必须 5 秒内返回**；来不及完成时就回复 `success`（官方推荐，可抑制重试）并改走客服消息接口异步推送 | P0 |
| FR-22 | 提供本地命令行 / 网页版模拟器，无需公众号即可体验完整交互 | P0 |
| FR-23 | 支持明文 / 兼容 / 安全三种消息模式，默认明文以便调试 | P2 |
| FR-24 | **微信消息按 `MsgId` 去重（事件按 `FromUserName + CreateTime`）**：微信官方在 5 秒无响应时会断连并重发，共重试 3 次，同一消息最多投递 4 次，必须去重防止重复预览、重复消耗 MCP 配额 | P0 |

---

## 4. 非功能需求

| 编号 | 需求 |
|---|---|
| NF-1 | **零第三方运行时依赖**，仅用 Node 内置模块 + fetch |
| NF-2 | **零构建步骤**：Node ≥ 22.6 直接执行 TypeScript 源码 |
| NF-3 | 冷启动到首字节 < 1s（模拟器内交互响应 < 300ms） |
| NF-4 | 所有凭据走环境变量；日志与回复中对凭据自动脱敏 |
| NF-5 | 仓库内不得出现真实 Token / AppSecret / 手机号 / 收货地址 |
| NF-6 | 全部中文注释与文案，便于中文开发者阅读 |

---

## 5. 安全需求（最高优先级）

> `create-order` 会产生**真实订单与真实资金支出**。以下为不可协商的红线。

| 编号 | 需求 |
|---|---|
| SEC-1 | 任何写操作（`create-order` / `cancel-order` / `auto-bind-coupons`）前必须有用户显式确认 |
| SEC-2 | 确认令牌与购物车绑定，含 TTL 与一次性消费标记，防重放 |
| SEC-3 | 同一用户 + 同一购物车指纹在冷却期内只允许成功下单一次 |
| SEC-4 | 下单金额、频次双重阈值保护 |
| SEC-5 | 支付链接只回复给发起用户本人，不得出现在日志、排行榜、公开页面 |
| SEC-6 | 失败/异常时绝不重试 `create-order`（宁可让用户重发，也不能重复下单） |
| SEC-7 | MCP 返回 401 时立即停止一切写操作并提示重新申请 Token |

---

## 6. MCP 契约（实测结论）

### 6.1 通用响应信封

```json
{ "success": true, "code": 0, "message": "ok", "datetime": "...", "traceId": "...", "data": { } }
```

工具同时返回 `structuredContent`（结构化，推荐）与 `content[].text`（Markdown，给人看）。解析**优先取 `structuredContent`**。

### 6.2 场景参数映射（错一个就全链路失败）

| 场景 | beType | orderType | beCode | 其他必填 |
|---|---|---|---|---|
| 到店自提 | `1` | `1` | 不返回也不传 | `takeWayCode`（来自 calculate-price） |
| 得来速 | `5` | `1` | **必须传** | `takeWayCode` |
| 麦乐送 | `2` | `2` | — | `addressId`（来自 delivery-query-addresses） |
| 企业团餐 | `6` | `2` | — | `addressId` |

### 6.3 关键工具约束

| 工具 | 必填 | 实测要点 |
|---|---|---|
| `query-nearby-stores` | `beType`, `searchType` | `searchType=1`=收藏餐厅、`2`=按位置。**实测 2026-10-10 本账号收藏为空，返回 `{"success":false,"code":600050}`**，且此时传 `keyword` 无效（被忽略、同样报 600050）。因此收藏路径必须做「空即回退」，且 `searchType=2` 时必须补 `city`。门店字段实测：`storeCode / storeName / address / distance / businessStatus / businessStartTime / businessEndTime / reservation / reservationTimeOptions[]` |
| `query-meals` | `storeCode`, `orderType`, `beType` | **返回结构是「分类 + 字典」双份**：`data.categories[] = {name, meals:[{code, tags[]}]}`（**只有裸 code，没有名称**），而真正的名称与价格在 `data.meals` 这个 **以 code 为 key 的字典**里：`{name, image, currentPrice(字符串·元), originalPrice(字符串·元), canWithOrder}`。**必须先建字典映射才能拿到品名**。菜单按时段变化，10:12 实测当前时段 91 条（早餐），传 `reservationDate="2026-10-10 12:00"` 后变成 115 条并出现「巨无霸(1100)」 |
| `query-meal-detail` | `storeCode`, `orderType`, `beType`, `code` | 返回 `modification.items[].values[] = {code, price, name, maxQuantity, minQuantity, selectedQuantity, selectedKey, unselectedKey}` 与 `supportModify`。巨无霸的「酸黄瓜」实测 `code=100202`，其 `selectedKey="0-1"`、`unselectedKey="0-0"`。套餐组成在 `rounds[]` |
| `calculate-price` | `storeCode`, `orderType`, `beType` | 返回 ` data = {productOriginalPrice, productPrice, originalPrice, discount, price, productList[{productCode, productName, quantity, originalSubtotal, subtotal}], takeWayList[{code, title, subtitle}]}`。**金额单位＝分**（巨无霸实测 `price=2650` 即 ¥26.50）。`takeWayList` 实测到店场景两项：`{code:"eat-in",title:"堂食"}`、`{code:"take-in-store",title:"外带"}` |
| `create-order` | `storeCode`, `orderType`, `beType` | 到店必传 `takeWayCode`；外送必传 `addressId`。 **`create-order` 属于写操作，本轮未执行**（SEC 红线），仅在 Mock 模式下模拟 |
| `list-nutrition-foods` | 无参 | **`data` 是 Markdown 字符串**（160 条），首行 `[160]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:`，其后每行 `  品名,null,1288,308,16,16,24,781,213`（注意行首两个空格、`nutritionDescription` 恒为 `null`）。需自写解析器 |
| `available-coupons` | 无参 | 实测返回 7 张可领券；`auto-bind-coupons` 一键领取（属写操作） |

> **⚠️ 审计 F-07 已回填（2026-10-10 实测）**：`keyword × searchType=1` 组合**无效** ——
> 服务端忽略 `keyword`，收藏为空时统一返回 `{success:false, code:600050, message:"收藏餐厅列表为空，请您提供城市+关键词进行搜索"}`。
> 因此「用关键词缩小收藏范围」这条路走不通，必须整链表回退到 `searchType=2`。

> **⚠️ 新增陷阱：reservationDate 一致性（FR-26）**
> 实测踩到的坑：`query-meals(storeCode, orderType=1, beType=1, reservationDate="2026-10-10 12:00")` 拿到了巨无霸 `code=1100`，
> 但紧接着不带 `reservationDate` 调 `query-meal-detail` / `calculate-price`，服务端返回
> `{success:false, code:60001, message:"未匹配到商品，请重新拉取全量商品列表"}` 与
> `{success:false, code:60006, message:"商品已售罄或不可售，换一个商品或检查orderType/beType"}`。
> **把同一个 `reservationDate` 补齐后，两个调用立刻成功。** 结论：预约日期对象是整个会话的上下文，不是单次参数。

> **⚠️ 关于「特制」（FR-18 的实现依据）**
> 以「巨无霸不要酸黄瓜」为例实测四种传参（A: `key=unselectedKey + quantity=0`、B: `key=selectedKey + quantity=0`、
> C: 仅 `code + quantity=0`、D: `key=unselectedKey + quantity=1`），**服务端全部返回 success，且响应体完全一致、不回显任何 modification 字段**。
> 也就是说 **`calculate-price` 端无法验证特制是否生效**。工程取舍：采用**语义最明确**的 A 方案
> （`values:[{code, key: 该项的 unselectedKey, quantity: 0}]`，即"取消该项"），并在预览卡片明确提示"特制以门店出餐为准"。
> 若未来发现服务端实际判定不同，只需调整 `src/domain/modification.ts` 一处。

### 6.4 下单链路（顺序不可颠倒）

### 6.4 下单链路（顺序不可颠倒）

```
query-nearby-stores ── storeCode ──> query-meals ── code ──┐
                                                            │
                              (需特制时) query-meal-detail ──┤
                                                            ▼
                                        calculate-price ── 实付价 + takeWayList
                                                            ▼
                                              [用户确认] ──> create-order ── 支付链接
```

---

## 7. 验收标准

| 编号 | 验收项 |
|---|---|
| AC-1 | 无 Token 执行 demo 命令，能在终端走完「输入 → 预览 → 确认 → 产出支付链接（示例）」 |
| AC-2 | 有 Token 执行真实链路，在用户显式确认后产出可用的麦当劳支付链接。**确认开关（`ORDER_REQUIRE_CONFIRM`）仅在 Mock/演示模式生效；真实 MCP 模式下代码级强制开启，不可配置关闭**。测试产生的未支付订单需用 `cancel-order` 清理 |
| AC-3 | 不回复确认时，**不调用** `create-order`（以日志断言） |
| AC-4 | 连续发送两次确认，只产生一笔订单 |
| AC-5 | `巨无霸 星河` 「巨无霸 + 示例星河店」命中，且当出现同分候选时转为候选列表 |
| AC-6 | 仓库全量扫描无任何真实凭据 |
| AC-7 | 满足大赛报名全部硬条件（见 PLAN 第 7 节） |

---

## 8. 术语

| 术语 | 含义 |
|---|---|
| 预览卡片 | 下单前给用户的订单摘要，含金额与用途明细 |
| 待确认态 | 会话已生成购物车、等待用户确认的状态 |
| 购物指纹 | 由 用户 + 门店 + 餐品 + 数量 + 特制 生成的哈希，用于幂等与去重 |
| takeWay | 取餐方式（堂食/外带/得来速等），其 code 必须取自 `calculate-price` |
| MsgId 去重 | 微信 5 秒无响应会重试 3 次（同一消息最多投递 4 次），须按 MsgId 排重；事件消息按 FromUserName+CreateTime 排重（官方推荐） |
