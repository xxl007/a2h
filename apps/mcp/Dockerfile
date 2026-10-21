# syntax=docker/dockerfile:1
# Build context: the repository root (infra/mcp.ts sets image.context ".").
#   docker build -f apps/mcp/Dockerfile .
# SST builds it for linux/arm64 (Fargate Graviton); nothing here is arch-specific.

FROM node:22-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
# pnpm version comes from packageManager in package.json (corepack).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @a2h/mcp...
RUN pnpm --filter @a2h/mcp build
# Production-only node_modules plus the package's "files" (dist/).
RUN pnpm --filter @a2h/mcp deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
