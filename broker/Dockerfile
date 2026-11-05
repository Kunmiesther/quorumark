# syntax=docker/dockerfile:1.7
#
# TurtleBot Public Execution Broker — Railway deployment.
#
# Node 22 is the supported LTS floor for the current Supabase JS client.
# Both stages pin the same immutable multi-platform digest.

# ---- Stage 1: builder ----
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

ENV NODE_ENV=production \
    CI=true

WORKDIR /build

# Copy manifests first to cache install layer.
COPY package.json bunfig.toml* ./
# Use npm (ships in the base image); avoids adding bun/curl to build layer.
COPY tsconfig.json ./
COPY src ./src

# npm 10's Arborist crashes while resolving this dependency graph on Railway
# (`Cannot read properties of null (reading 'edgesOut')`). Pin the tested npm
# major before generating the container-local lockfile.
RUN npm install --global npm@11.19.0 \
 && npm install --include=dev --no-audit --no-fund --package-lock-only \
 && npm ci --include=dev --no-audit --no-fund \
 && npx --yes tsc -p tsconfig.json \
 && npm prune --omit=dev

# ---- Stage 2: runtime ----
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

ENV NODE_ENV=production \
    PORT=8080

# Non-root user with fixed uid/gid.
RUN addgroup -S -g 10001 broker \
 && adduser -S -u 10001 -G broker -h /home/broker -s /sbin/nologin broker \
 && mkdir -p /app \
 && chown -R broker:broker /app /home/broker

WORKDIR /app

COPY --from=builder --chown=broker:broker /build/node_modules ./node_modules
COPY --from=builder --chown=broker:broker /build/dist ./dist
COPY --from=builder --chown=broker:broker /build/package.json ./package.json

USER broker:broker

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

# Read-only rootfs is enforced by platform config (Railway).
# Tmpfs mount at /tmp is expected.
CMD ["node", "dist/server.js"]
