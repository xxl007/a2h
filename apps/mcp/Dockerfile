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
# The workspace packages first (@a2h/protocol, @a2h/db: Node does not strip
# types under node_modules, design D5), then the service, in dependency order.
RUN pnpm --filter @a2h/mcp... build
# Production-only node_modules plus each package's "files" (dist/, and the
# migrations and seed of @a2h/db).
RUN pnpm --filter @a2h/mcp deploy --prod --legacy /out

# The AWS RDS global CA bundle, fetched and checked at build time (never at
# runtime): the service verifies Aurora's TLS certificate against it.
FROM node:22-bookworm-slim AS rds-ca
COPY apps/mcp/docker/fetch-rds-ca-bundle.mjs /tmp/
RUN node /tmp/fetch-rds-ca-bundle.mjs /tmp/rds-global-bundle.pem

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=rds-ca /tmp/rds-global-bundle.pem /etc/a2h/rds-global-bundle.pem
# Read by apps/mcp/infra/env.ts: TLS with rejectUnauthorized against this CA.
ENV DB_CA_BUNDLE=/etc/a2h/rds-global-bundle.pem
COPY --from=builder /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/src/index.js"]
