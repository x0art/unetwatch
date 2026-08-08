# ── Stage 1: build the admin UI ─────────────────────────────────────
FROM node:22-alpine AS ui-build
WORKDIR /build
COPY admin-ui/package.json admin-ui/package-lock.json ./
RUN npm ci
COPY admin-ui/ ./
RUN npm run build

# ── Stage 2: runtime ────────────────────────────────────────────────
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UNETWATCH_HOME=/app

WORKDIR /app

# Install the Python package (app/ + entry point) without dev deps.
COPY pyproject.toml README.md LICENSE ./
COPY app/ ./app/
RUN pip install --no-cache-dir .

# Copy the built admin UI from the build stage.
COPY --from=ui-build /build/dist ./admin-ui/dist

# Non-root user. /app/data (the blacklist feed files, mounted as a named
# volume in docker-compose) must exist and be owned by the app user, or the
# first volume mount would come up root-owned and feed writes would fail.
RUN useradd --create-home --uid 1000 unetwatch && \
    mkdir -p /app/data && \
    chown -R unetwatch:unetwatch /app
USER unetwatch

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" || exit 1

CMD ["unetwatch"]
