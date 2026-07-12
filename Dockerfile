# Recensa — self-hosted Claude Code session viewer (Node backend + built React frontend).
# Build from the repository root:
#   docker compose up -d --build        (or: docker build -t recensa .)
# node:24-slim -> node:sqlite works unflagged (Node 22 would need --experimental-sqlite).

# ---------- build stage: backend deps + frontend bundle ----------
FROM node:24-slim AS build

# Backend runtime deps (includes @recensa/claude-session from npm). Manifests first for layer caching.
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/ ./

# Frontend build -> emits to /app/public (vite outDir '../public').
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- runtime stage ----------
FROM node:24-slim AS runner
ENV NODE_ENV=production \
    SESSION_VIEWER_HOST=0.0.0.0 \
    SESSION_VIEWER_PORT=7788
WORKDIR /app

# backend/ and public/ sit as siblings; config.js resolves PUBLIC_DIR as backend/src/../../public.
COPY --from=build /app/backend/ ./backend/
COPY --from=build /app/public/ ./public/

# Non-root user + a writable data dir (the DB named volume mounts here).
RUN useradd -r -u 1001 -m appuser \
 && mkdir -p /app/backend/data \
 && chown -R appuser:appuser /app
USER appuser

WORKDIR /app/backend
EXPOSE 7788
CMD ["node", "src/server.js"]
