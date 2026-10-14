# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# Native build deps for argon2 (node-gyp).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install with the full workspace so workspace: deps resolve.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY enterprise ./enterprise
RUN pnpm install --frozen-lockfile=false

# Build packages then the API.
RUN pnpm --filter @kinynx/shared --filter @kinynx/permissions run build \
    && pnpm --filter @kinynx/api run build

# Prune to production dependencies for the API.
# pnpm 10 requires --legacy to deploy workspaces that aren't injected
# (workspace:* deps here are symlinked, not injected); --legacy copies the
# built workspace packages (@kinynx/shared, @kinynx/permissions) into /app.
RUN pnpm --filter @kinynx/api --prod --legacy deploy /app

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /repo/services/api/dist ./dist
COPY --from=build /repo/services/api/package.json ./package.json

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://localhost:4000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations run automatically on boot (see src/index.ts).
CMD ["node", "dist/index.js"]
