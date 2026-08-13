# Express API: auth, tenancy, file storage, and orchestration of the Python AI
# service. Build context is this directory (server/).

FROM node:22-slim AS base

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first for layer caching. `npm ci` installs the exact lockfile;
# `--omit=dev` skips test/lint tooling, which never runs in the container.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then the source. No build step: the server is plain ESM.
COPY . .

# The official node image ships a non-root `node` user (uid 1000). The upload
# directory lives on a mounted volume at /data/uploads (see docker-compose) and
# must be writable by that user; the same absolute path has to exist in the AI
# service container too, because the API hands it a file_path to read.
RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node

EXPOSE 4200

# The app reads process.env directly (config/env.js, no dotenv), so unlike the
# dev script there is no --env-file here: the environment is injected by
# docker-compose or the orchestrator.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:4200/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
