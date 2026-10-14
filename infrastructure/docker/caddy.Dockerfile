# Reverse-proxy image with the Caddyfile baked in. Building it (instead of
# bind-mounting the Caddyfile from the host) keeps the stack portable to
# platforms like Coolify, where the repo is not reliably present at the
# compose project directory at runtime — a missing bind source makes Docker
# create an empty directory and the single-file mount then fails.
FROM caddy:2-alpine
COPY infrastructure/docker/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443
