# ---- build the static PWA ----
FROM node:22-alpine AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- serve with unprivileged nginx (static files + Ollama relay) ----
# nginx-unprivileged runs as uid 101, listens on 8080, and keeps its pid and
# temp paths under /tmp — so the container works with a read-only root
# filesystem plus a tmpfs on /tmp (see compose.yaml).
#
# The same container also runs the cloud turn runner (server/cloud.mjs, a
# dependency-free Node script) on 127.0.0.1:8090, reached through nginx at
# /api/cloud/. Its state is memory-only, so the read-only fs still holds.
FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
RUN apk add --no-cache nodejs
USER 101
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY server/cloud.mjs /opt/kiln/cloud.mjs
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
# The runner restarts if it ever dies (chat itself never depends on it);
# nginx stays PID 1 via exec so signals keep working.
CMD ["/bin/sh", "-c", "(while :; do node /opt/kiln/cloud.mjs; echo '[kiln] cloud runner exited, restarting' >&2; sleep 1; done) & exec nginx -g 'daemon off;'"]
