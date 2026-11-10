FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY frontend/package*.json ./frontend/
RUN npm --prefix frontend ci --no-audit --no-fund
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data TCB_PG_PROXY=0
WORKDIR /app
COPY backend/package*.json ./backend/
RUN npm --prefix backend ci --omit=dev --no-audit --no-fund
COPY backend ./backend
COPY scripts/start-local.mjs ./scripts/start-local.mjs
COPY --from=build /app/frontend/dist ./frontend/dist
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "scripts/start-local.mjs"]
