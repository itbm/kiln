# kiln-agentd — thin control plane (§5.1). Same hardening posture as the
# kiln service: read-only fs, non-root, no capabilities (see compose.yaml).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY package.json ./
# node user = uid 1000, overridden by compose to match the host user that
# owns the sandboxd socket. Core dumps are disabled via compose ulimits
# (§8.1 T6).
USER node
EXPOSE 9090
CMD ["node", "dist/src/index.js"]
