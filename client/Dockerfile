# React SPA. Two stages: build the static bundle with Node, then serve it with
# nginx. The final image contains only the built assets and nginx -- no Node,
# no source, no node_modules. Build context is this directory (client/).

# --- build stage ------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

# devDependencies ARE needed here: vite and the plugins are dev deps, and the
# build cannot run without them. That is fine -- this stage is thrown away.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build   # -> /app/dist (hashed asset chunks from Phase 13)

# --- serve stage ------------------------------------------------------------
FROM nginx:1.27-alpine AS serve

# Replace the default site with one that knows about SPA routing and the API
# proxy (see nginx.conf).
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
