# syntax=docker/dockerfile:1

# ---- Production dependencies ----------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# --ignore-scripts (also set in .npmrc): better-sqlite3 ships prebuilt N-API binaries
# (prebuilds/linux-x64.node, glibc >= 2.34). Without it npm 10 runs "node-gyp rebuild",
# which needs Python and a C++ compiler.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ---- Final image -------------------------------------------------------------------
# bookworm-slim rather than Alpine: better-sqlite3's prebuilt binary targets glibc.
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="openpad" \
      org.opencontainers.image.description="Self-hosted Dontpad clone with real-time sync" \
      org.opencontainers.image.source="https://github.com/joaoribeiiro15/Dontpad-Docker" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/openpad.db

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Fail the build right away if the SQLite binary does not load on this platform.
RUN node -e "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get()"

# The code stays owned by root (read-only for the process); only /data is writable.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
