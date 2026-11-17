# syntax=docker/dockerfile:1

# ---- Dependências de produção -------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Imagem final -----------------------------------------------------------
# bookworm-slim em vez de Alpine: o better-sqlite3 traz binários pré-compilados
# para glibc, sem toolchain de C++ na imagem.
FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="openpad" \
      org.opencontainers.image.description="Clone self-hosted do dontpad.com" \
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

# O código fica com dono root (só leitura para o processo); só /data é gravável.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
