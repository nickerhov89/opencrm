FROM node:24-bookworm-slim AS build

ARG OPENCRM_BASE_PATH=/
ARG VITE_PUBLIC_DEMO=0
ENV OPENCRM_BASE_PATH=${OPENCRM_BASE_PATH} VITE_PUBLIC_DEMO=${VITE_PUBLIC_DEMO}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
# public: favicon and the script that applies the theme before the first paint; dark-theme.mjs runs during the build.
COPY public ./public
COPY scripts/dark-theme.mjs ./scripts/dark-theme.mjs
COPY src ./src
COPY server ./server
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
LABEL org.opencontainers.image.title=opencrm
# pg_dump / pg_restore / psql for backups and rclone for off-site copies; the client must not be older than the server (postgres:17).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-17 rclone \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    UPLOAD_DIR=/app/data/uploads
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/src/deal-card-layout.js /app/src/task-types.js ./src/
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node tests ./tests
RUN mkdir -p /app/data/uploads /app/backups && chown -R node:node /app/data /app/backups
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3001/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
