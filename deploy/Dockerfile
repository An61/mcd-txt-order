# 生产镜像：多阶段，最终镜像只有 node + 源码（零第三方依赖，无需 npm install）
#
# 关键取舍：
#   · 用 node:22 的 slim 变体 —— 项目零依赖，装完整镜像纯属浪费
#   · 以非 root 用户运行 —— 回调服务暴露在公网，容器逃逸的第一道防线
#   · 内置 HEALTHCHECK —— 微信回调挂了要能被编排系统自动发现

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0
WORKDIR /app

# 先只拷清单文件：源码没变时这一层能命中缓存，重建秒级完成
COPY package.json ./

FROM base AS runtime
# 只拷运行时真正用到的目录，.env / .cache / 文档一律不进镜像。
# config/ 必须带上：示例收藏配置在里面，缺失时 favorites 会退化成空配置
# （不抛异常，但门店别名会全丢 —— 属于那种「能跑但不对」的坑，宁可让它没有）
COPY --chown=node:node src/ ./src/
COPY --chown=node:node config/ ./config/
COPY --chown=node:node package.json ./
RUN mkdir -p /app/.cache && chown node:node /app/.cache

USER node
EXPOSE 8787

# /healthz 由 ChannelServer 提供，返回 200 且带 uptime / 加解密模式等字段
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用 --experimental-strip-types 直接跑 TS，镜像里不需要任何构建步骤
CMD ["node", "--experimental-strip-types", "src/index.ts", "serve"]
