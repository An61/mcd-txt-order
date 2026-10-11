# MCP 集成说明

> 本文说明本项目实际使用的麦当劳 MCP Server、调用的 Tool、调用流程与业务价值。
> **文中所有服务端行为均来自 2026-10-10 对 `https://mcp.mcd.cn` 的真实调用实测**（快照存于 `.cache/probe/`，已 gitignore），不是照抄文档推测。凡是与官方文档不一致的地方，均以实测为准并在本文标注。

---

## 1. MCP Server

| 项 | 值 |
|---|---|
| 名称 | `mcd-mcp`（麦当劳中国官方 MCP Server） |
| 接入地址 | `https://mcp.mcd.cn` |
| 传输协议 | **Streamable HTTP**（单次 POST 同时需要接受 `application/json` 与 `text/event-stream` 两种响应体） |
| 鉴权 | HTTP Header `Authorization: Bearer <MCP Token>` |
| Token 获取 | https://open.mcd.cn/mcp — 手机号验证码登录 → 控制台 → 激活 |
| 实测工具总数 | **35 个**（官方 README 当时记载 28 个，服务端仍在迭代，**应当以 `tools/list` 实时返回为准**） |
| 实测限流 | 600 次/分钟 |

### 客户端实现

`src/mcp/client.ts` —— **零第三方依赖**手写实现：

- 完整握手（`initialize` → `notifications/initialized`），记录服务端返回的 `Mcp-Session-Id` 并在后续请求回传；会话过期时自动重建后重试一次
- **同时兼容 JSON 与 SSE 两种响应体**：SSE 帧按 `event:` / `data:` 逐帧解析并从 `message` 事件里取回 JSON-RPC 结果（这一步是必需的，服务端对部分请求会以 SSE 分包返回，只按 JSON 解析的程序会直接失败）
- 400 / 401 / 403 / 429 均有中文诊断；**401 时向上传播 `authFailed` 信号**，触发 SEC-7 全局冻结
- 写操作（write）与读操作（read）在类型层分离，便于上层做静态检查

---

## 2. 使用的 Tool

### 2.1 核心链路（已实测通过）

| Tool | 用途 | 必填参数 | 实测要点 |
|---|---|---|---|
| `query-nearby-stores` | 到店场景检索门店 | `beType`, `searchType` | `searchType=1` 为**官方收藏餐厅**，正是"预置喜爱门店"所需；`2` 为按定位检索 |
| `delivery-query-stores` | 麦乐送场景检索门店 | `beType`, `addressId` | 需先由 `delivery-query-addresses` 拿到 `addressId` |
| `query-meals` | 拉取门店实时菜单 | `storeCode`, `orderType`, `beType` | **菜单随门店与时间变化，必须实时拉** |
| `query-meal-detail` | 餐品详情 / 套餐组成 / 特制选项 | `storeCode`, `orderType`, `beType`, `code` | **特制选项 code 的唯一来源** |
| `calculate-price` | 真实应付价 + 取餐方式 | `storeCode`, `orderType`, `beType` | 返回 `takeWayList[].code`，`create-order` 要用 |
| `create-order` | **创建真实订单** | `storeCode`, `orderType`, `beType` | 到店必传 `takeWayCode`；外送必传 `addressId` |
| `cancel-order` | 取消订单 | `orderId`, `cancelReasonCode` | P2 阶段接入 |

### 2.2 券与权益

| Tool | 实测要点 |
|---|---|
| `query-store-coupons` | 按「门店 + 订单类型」查可用券，比通用券列表更准 |
| `query-my-coupons` | 卡包资产。实测返回用户的真实券列表 |
| `available-coupons` | 实测返回 7 张可领券 |
| `auto-bind-coupons` | 一键自动领取全部可领券 —— **属写操作**，需二次确认 |

### 2.3 只读查询

| Tool | 实测要点 |
|---|---|
| `list-nutrition-foods` | **`data` 是一整段 Markdown 字符串**（实测 160 条），不是 JSON 数组，必须自写解析器 |
| `order-list` / `query-order` | 历史订单与订单详情 |
| `query-my-account` | 积分账户明细 |
| `now-time-info` | 服务端当前时间。用于对齐 `reservationDate`，值得依赖它而不是本机时钟 |
| `campaign-calendar` | 当月营销活动日历 |

---

## 3. 调用流程

一句话下单背后的完整链路（只读部分已端到端实测跑通）：

```
用户指令「巨无霸 星河」
        │
        ▼
  ① 意图识别 ────► order / confirm / cancel / query …（七类，本地完成，零 MCP 调用）
        │
        ▼
  ② query-nearby-stores          收藏餐厅优先（searchType=1）
     └─ 空列表则回退 ──────────► searchType=2 + city + keyword
        │
        ▼
  ③ query-meals                  拿实时菜单（分类 + code→详情 字典）
        │
        ├── 需要特制？──► ④ query-meal-detail   取 modification.values[].code
        │
        ▼
  ⑤ calculate-price              ← 真实应付价 + takeWayList
        │
        ▼
  ⑥ 【本地】生成预览卡片 + 一次性确认令牌（HMAC-SHA256 绑定 userId + 购物车指纹）
        │
        ▼
  ⑦ 用户回复「确认」──► 令牌校验 + 守卫检查 ──► ⑧ create-order ──► 支付链接（仅回给本人）
```

**两个顺序上的硬约束（改错就失败）**：

1. `takeWayCode` 只能从 `calculate-price` 的返回里取 → **⑥ 必须在 ⑧ 之前**，不可跳过算价直接下单。
2. `reservationDate` 一旦在某个环节传入，**全链路必须传同一个值**。实测：`query-meals` 带 `reservationDate` 拿到了午餐菜单（巨无霸 `code=1100`），但后续 `query-meal-detail` / `calculate-price` 漏传即报 `60001 未匹配到商品` / `60006 商品已售罄或不可售`。它不是单次参数，而是**会话上下文**。

---

## 4. 业务价值

| 维度 | 说明 |
|---|---|
| **用户侧** | 把「翻 App 找店 → 找菜 → 配券 → 下单」压缩成**一句话**。对高频固定口味的用户（"我永远吃巨无霸不要酸黄瓜"）价值最大 |
| **场景侧** | 公众号是零安装入口：不用下载 App、不用扫码点餐小程序，关注即用，老人与临时用户友好 |
| **技术侧** | 把 MCP 能力从"AI 对话演示"推进到"可通过即时通讯触达真实用户的产品形态"，验证了 MCP Server 在真实链路上的可用性 |
| **生态侧** | 沉淀了一份**实测校正过的 MCP 契约**（含 5 个官方文档未覆盖的陷阱），后续开发者可直接复用 |

---

## 5. 实测发现的 5 个坑（官方 README 未记载）

这几条是本项目最值得被复用的部分，全部出自对真实 API 的调用：

1. **收藏餐厅不能带关键词**。`query-nearby-stores(searchType=1)` 只返回收藏列表（本账号为空，返回 `code:600050`），且此时**传 `keyword` 会被忽略**。所以「预置喜爱餐厅」必须做成「**别名在本地，名单在云端**」：本地只存 `星河 → 示例星河餐厅` 的映射，实际检索仍走官方能力 + 关键词回退。
2. **菜单是「分类 + 字典」两份数据**。`categories[]` 里只有裸 `code`（**没有名称**），名称与价格在另一个 `data.meals` 字典里。只遍历分类会拿到一堆无名商品，必须做一次 join。
3. **金额有两套单位**。`query-meals` 的 `currentPrice` 是「元」的**字符串**（`"26.5"`），`calculate-price` 的 `price / subtotal / discount` 是「分」的**整数**（`2650`）。混用会产生 100 倍误差。本项目在领域模型层强制"一律用分"，并写了显式换算函数。
4. **营养数据是 Markdown**。`list-nutrition-foods` 返回的 `data` 是一整段 Markdown 文本（160 条，`productName, energyKj, energyKcal, protein, fat, carbohydrate, sodium, calcium`），必须自写解析器（见 `src/mcp/nutrition.ts`）。
5. **特制 code 不可凭空构造**。「不要酸黄瓜」对应的 `modification.values[].code` 只能从 `query-meal-detail` 取得（实测巨无霸酸黄瓜 `code=100202`）。因此"带特制"必须付出一次额外的 `query-meal-detail` 调用。

---

## 6. 安全边界

`create-order` 会产生**真实订单与真实支付链接**，本项目因此设了五道闸（详见 `SPEC.md` 的 SEC 章节、`src/safety/`）：

| 闸 | 机制 |
|---|---|
| 状态机 | **`placed` 只能由 `confirming` 状态进入**，其它路径在机器上走不通，不是靠"记得判断" |
| 确认令牌 | HMAC-SHA256 绑定 `userId + 购物车指纹 + 有效期`，一次性消费，5 分钟过期；改购物车立即作废 |
| 守卫 | 幂等（三态：`pending` / `succeeded` / `failed`）+ 60 秒冷却 + 每小时/每天次数 + 单笔/每日金额上限 |
| 失败策略 | **`create-order` 失败绝不自动重试**。宁可让用户重说一遍，也不能下出第二笔 |
| 凭据 | Token 只走环境变量；仓库内的配置文件全部为占位符；`401` 立即冻结一切写操作 |

> **说明**：`create-order` 的代码路径已就绪，但**尚未在真实账号上执行过一次** —— 这是刻意的：它作为最后一道人工把关环节留到最后，执行前需显式传入确认旗标。
