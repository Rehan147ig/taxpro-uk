# ── Production Dockerfile for TaxPro API ──
# Multi-stage build: 1) install+build, 2) production runtime

# ── Stage 1: Build ──
FROM node:26-alpine AS builder

WORKDIR /app

# Install dependencies first (cached unless lockfile changes)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/tax-engine/package.json packages/tax-engine/package.json
COPY packages/tax-engine-enterprise/package.json packages/tax-engine-enterprise/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --include=dev

# Copy source
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/tax-engine packages/tax-engine
COPY packages/tax-engine-enterprise packages/tax-engine-enterprise

# Build tax-engine and enterprise first (dependencies), then API
RUN npm run build -w packages/tax-engine
RUN npm run build -w packages/tax-engine-enterprise
RUN npm run build -w apps/api

# ── Stage 2: Production runtime ──
FROM node:26-alpine

WORKDIR /app

# Copy production node_modules + built artifacts
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/tax-engine/package.json packages/tax-engine/package.json
COPY packages/tax-engine-enterprise/package.json packages/tax-engine-enterprise/package.json

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy built code from builder
COPY --from=builder /app/apps/api/dist /app/apps/api/dist
COPY --from=builder /app/packages/tax-engine/dist /app/packages/tax-engine/dist
COPY --from=builder /app/packages/tax-engine/package.json /app/packages/tax-engine/package.json
COPY --from=builder /app/packages/tax-engine-enterprise/dist /app/packages/tax-engine-enterprise/dist
COPY --from=builder /app/packages/tax-engine-enterprise/package.json /app/packages/tax-engine-enterprise/package.json

# Copy drizzle config + migrations
COPY apps/api/drizzle.config.ts apps/api/drizzle.config.ts
COPY apps/api/src/db/migrations apps/api/src/db/migrations

# The seed script needs tsx at runtime — copy from builder
COPY --from=builder /app/node_modules/tsx /app/node_modules/tsx
COPY apps/api/src/db/seed.ts apps/api/src/db/seed.ts
COPY apps/api/src/db/schema apps/api/src/db/schema
COPY apps/api/src/config/env.ts apps/api/src/config/env.ts

# Create non-root user
RUN addgroup -S taxpro && adduser -S taxpro -G taxpro && chown -R taxpro:taxpro /app
USER taxpro

EXPOSE 3001

# Run migrations, seed if needed, then start
CMD ["sh", "-c", "\
  if [ \"$RUN_MIGRATIONS\" != \"false\" ]; then \
    echo 'Running migrations...' && \
    npx drizzle-kit migrate --config=apps/api/drizzle.config.ts; \
  fi; \
  if [ \"$RUN_SEED\" = \"true\" ]; then \
    echo 'Running seed...' && \
    node --import tsx apps/api/src/db/seed.ts; \
  fi; \
  echo 'Starting API...' && \
  node apps/api/dist/index.js \
"]
