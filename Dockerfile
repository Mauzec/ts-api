FROM node:24.22.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
COPY package.json package-lock.json ./
RUN npm_config_build_from_source=true npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.22.0-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8599 DB_PTH=/data/db.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
RUN node -e "require('sqlite3')"
EXPOSE 8599
CMD ["node", "dist/main.js"]
