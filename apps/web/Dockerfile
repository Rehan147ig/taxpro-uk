# ── Production Dockerfile for TaxPro Web ──
# Multi-stage build: 1) build static assets, 2) serve via nginx

# ── Stage 1: Build ──
# node:22-slim (glibc) rather than alpine: rollup's native binary for musl
# (rollup-linux-x64-musl) is frequently not installed by `npm ci` in alpine
# (npm/cli#4828), breaking `vite build`; the glibc binary installs reliably.
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/tax-engine/package.json packages/tax-engine/package.json
RUN npm ci --include=dev

# Copy source
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/tax-engine packages/tax-engine

# `npm ci` flakily omits rollup's optional platform binary (npm/cli#4828),
# breaking `vite build`. Install the glibc binary explicitly, version-matched
# to the installed rollup.
RUN npm i --no-save @rollup/rollup-linux-x64-gnu@$(node -p "require('./node_modules/rollup/package.json').version")

# Build tax-engine (needed for references), then web
RUN npm run build -w packages/tax-engine
RUN npm run build -w apps/web

# ── Stage 2: nginx ──
FROM nginx:1.31-alpine

# Copy built static assets
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

# Copy custom nginx config
COPY infrastructure/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
