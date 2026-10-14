# Static web client image (docs, board, admin). Used by both Kubernetes and
# Docker Compose (baked in rather than bind-mounted, for portability).
FROM nginx:alpine
COPY apps/web /usr/share/nginx/html
# SPA-ish: fall back to index.html is not needed (multi-page static), but ensure
# the API is proxied by the ingress/Caddy in front of this container.
EXPOSE 80
