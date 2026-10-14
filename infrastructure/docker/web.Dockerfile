# Static web client image (app, board, admin, public viewer). Used by both
# Kubernetes and Docker Compose (baked in rather than bind-mounted).
FROM nginx:alpine
COPY infrastructure/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
