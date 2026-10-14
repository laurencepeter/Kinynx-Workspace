# Static web client image (app, board, admin, public viewer). Used by both
# Kubernetes and Docker Compose (baked in rather than bind-mounted).

# ── Build the rich-text engine (Tiptap → apps/web/vendor/kinynx-tiptap.js) ──
FROM node:22-bookworm-slim AS editor
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web-editor ./apps/web-editor
RUN pnpm install --frozen-lockfile=false --filter @kinynx/web-editor \
    && mkdir -p apps/web \
    && pnpm --filter @kinynx/web-editor run build

# ── Serve ────────────────────────────────────────────────────────────────────
FROM nginx:alpine
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web /usr/share/nginx/html
COPY --from=editor /repo/apps/web/vendor /usr/share/nginx/html/vendor
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
