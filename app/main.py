import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings, verify_admin
from app.database import init_db, seed_defaults
from app.routes import auth as auth_routes
from app.routes import blacklist, findings, logs, monitor, patterns, query, redirects

scheduler = AsyncIOScheduler()

log = logging.getLogger("unetwatch")


def setup_logging():
    """Structured (key=value) logging with a request-correlation id."""
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s level=%(levelname)s logger=%(name)s %(message)s"
        )
    )
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(os.getenv("UNETWATCH_LOG_LEVEL", "INFO").upper())


setup_logging()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await seed_defaults()

    settings = get_settings()
    from app.services.monitor import fetch_logs
    from app.services.redirects import check_all

    scheduler.add_job(
        fetch_logs,
        "interval",
        minutes=settings.poll_interval_minutes,
        kwargs={"minutes": settings.poll_interval_minutes},
    )
    scheduler.add_job(
        check_all,
        "interval",
        minutes=settings.redirect_check_interval_minutes,
    )
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(
    title="uNetWatch",
    description="URL pattern monitoring and redirect tracking for Elasticsearch proxy logs",
    version="1.0.0",
    lifespan=lifespan,
)

_settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _settings.cors_origins.split(",") if o.strip()],
    allow_credentials=False,  # token is in a header, not a cookie
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-API-Key"],
)


@app.middleware("http")
async def request_logging(request: Request, call_next):
    """Structured request logging with a correlation id echoed in the
    response as ``X-Request-ID``."""
    request_id = request.headers.get("X-Request-ID") or uuid.uuid4().hex[:12]
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        log.exception(
            "request method=%s path=%s request_id=%s", request.method, request.url.path, request_id
        )
        raise
    duration_ms = (time.perf_counter() - start) * 1000
    log.info(
        "request method=%s path=%s status=%s duration_ms=%.1f request_id=%s",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
        request_id,
    )
    response.headers["X-Request-ID"] = request_id
    return response


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Defense-in-depth security response headers."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        # The admin UI ships one inline theme script (anti-FOUC) in index.html;
        # allow that exact script by hash instead of weakening script-src.
        # WARNING: if the inline script in admin-ui/index.html ever changes,
        # regenerate this sha256 (or it will be blocked with a CSP error).
        "script-src 'self' 'sha256-cvQ/y5Y/CzMr50PlFUO7L9axSQDilZEGSKf9+XT1tkQ='; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "connect-src 'self'; "
        "img-src 'self' data:; "
        "frame-ancestors 'none'"
    )
    return response

app.include_router(patterns.router, dependencies=[Depends(verify_admin)])
app.include_router(monitor.router, dependencies=[Depends(verify_admin)])
app.include_router(findings.router, dependencies=[Depends(verify_admin)])
app.include_router(blacklist.router, dependencies=[Depends(verify_admin)])
app.include_router(redirects.router, dependencies=[Depends(verify_admin)])
app.include_router(query.router, dependencies=[Depends(verify_admin)])
app.include_router(logs.router, dependencies=[Depends(verify_admin)])
app.include_router(auth_routes.router)


@app.get("/health")
async def health():
    """Liveness + dependency status.

    Returns ``{"status": "ok"}`` when all dependencies are reachable; each
    dependency failure flips the overall status to ``"degraded"`` and is
    reported under ``dependencies``. The endpoint itself always answers so
    orchestrators can observe the degraded state.
    """
    settings = get_settings()
    deps: dict[str, str] = {}

    # Elasticsearch reachability (best-effort ping).
    try:
        from elasticsearch import AsyncElasticsearch

        async with AsyncElasticsearch(
            hosts=[settings.elastic_host],
            basic_auth=(settings.elastic_user, settings.elastic_pass)
            if settings.elastic_user
            else None,
            request_timeout=3,
        ) as es:
            await es.ping()
        deps["elasticsearch"] = "ok"
    except Exception:
        deps["elasticsearch"] = "unreachable"

    # Database reachability.
    try:
        from app.database import get_db

        db = await get_db()
        try:
            await db.execute("SELECT 1")
        finally:
            await db.close()
        deps["database"] = "ok"
    except Exception:
        deps["database"] = "unreachable"

    healthy = all(v == "ok" for v in deps.values())
    return {
        "status": "ok" if healthy else "degraded",
        "version": app.version,
        "dependencies": deps,
    }


# ── Admin UI (served from built assets) ───────────────────────────────────
_ADMIN_DIST = os.path.join(os.path.dirname(__file__), "..", "admin-ui", "dist")
_ADMIN_DIST_PATH = Path(_ADMIN_DIST).resolve()

if os.path.isdir(_ADMIN_DIST):
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(_ADMIN_DIST, "assets")),
        name="assets",
    )

    @app.get("/")
    async def admin_index():
        return FileResponse(_ADMIN_DIST_PATH / "index.html")

    @app.get("/{full_path:path}")
    async def admin_spa(full_path: str):
        if not full_path:
            return FileResponse(_ADMIN_DIST_PATH / "index.html")
        candidate = (_ADMIN_DIST_PATH / full_path).resolve()
        # Prevent path traversal outside the dist directory
        if _ADMIN_DIST_PATH in candidate.parents and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_ADMIN_DIST_PATH / "index.html")


def run():
    """Console entry point: ``unetwatch`` → serves the app on :8000."""
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000)


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
