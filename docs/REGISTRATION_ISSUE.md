# 报名 Issue 正文（提交前请先确认已推送仓库）

> **提交地址**：https://github.com/M-China/mcd-developer-innovation-challenge/issues/new
> **提交前**：先把仓库推送到 GitHub 并确保它是 Public，否则审核会失败。
> **格式要求（官方原文）**：正文不超过 1000 字，**不得携带图片**，否则报名失败。

---

## 标题（自定义）

```
【参赛申请】mcd-txt-order —— 微信里一句话下单麦当劳
```

## 正文（复制以下内容）

```
【参赛申请】
项目名称：mcd-txt-order 麦当劳一句话点餐助手
项目地址：https://github.com/An61/mcd-txt-order
项目简介：

基于麦当劳官方 MCP（https://mcp.mcd.cn）开发的微信公众号点餐助手。用户预置喜爱的门店与餐品后，发送「巨无霸 香梅北」这类短句，即可自动完成门店检索、菜单匹配、实时算价，回复「确认」后返回支付链接。

已打通的 MCP 调用链：query-nearby-stores（收藏餐厅优先，为空则回退关键词检索）→ query-meals → 需特制时 query-meal-detail → calculate-price → 用户二次确认 → create-order；另接入 query-store-coupons、list-nutrition-foods 等只读能力。

三点技术取舍：
一、零第三方依赖，用 Node 22 原生 TypeScript 手写 Streamable HTTP MCP 客户端，同时兼容 JSON 与 SSE 两种响应体。
二、所有服务端行为均以真实调用实测为准，修正了五处官方文档未记载的坑：收藏名单不支持关键词检索；reservationDate 必须全链路一致，否则报商品不可售；菜单为「分类 + 字典」双份数据需 join；菜单金额单位是元字符串而算价是分整数；特制 code 只能从 query-meal-detail 取得，不可构造。
三、create-order 涉及真实资金，因此设了五道安全闸：状态机限制「已下单」只能由「待确认」进入；确认令牌用 HMAC 绑定用户与购物车指纹，一次性消费且五分钟过期；幂等加冷却加限次限额守卫；失败绝不自动重试；收到 401 立即冻结一切写操作。针对微信五秒无响应会重发三次的机制，另做了 MsgId 去重。

零安装门槛：无需 Token 即可 clone 后跑通 143 项离线自检；仓库自带由真实探针快照生成的示例数据（8 家真实门店、115 条真实菜单），无凭据也能看到真实命中效果。
```
