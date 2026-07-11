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
# filesystem plus a tmpfs on /tmp (see docker-compose.yml).
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
