FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY nest-cli.json tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Patch one named package instead of `apk upgrade` (which would pull every newer package on each build).
# zlib 1.4-r0 fixes CVE-2026-4738 (critical). The build fails if that version isn't available.
RUN apk add --no-cache 'zlib>=1.4-r0'
COPY package*.json ./
# The API runs with `node`, never npm, so delete npm and npx after installing:
# npm's own bundled packages carried 10 of the image's high CVEs.
RUN npm ci --omit=dev && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
 && mkdir logs && chown node:node logs
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/health || exit 1
# The schema lives in Supabase and is managed there; this image only runs the API
CMD ["node", "dist/main.js"]
