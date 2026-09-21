import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings, verify_admin
from app.database import init_db, seed_defaults
from app.routes import auth as auth_routes
from app.routes import (
    analytics,
    attck,
    backup,
    blacklist,
    enrich,
    findings,
    hosts,
    jaillist,
    logs,
    monitor,
    patterns,
    query,
    redirects,
    timezone,
    triage,
)
from app.services.feeds import sync_regenerate, sync_regenerate_jail

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

    # Regenerate the static blacklist feeds from the DB so the public
    # /api/blacklist/{urls,ips}.txt files match on every startup.
    from app.database import get_db

    db = await get_db()
    try:
        await sync_regenerate(db)
        await sync_regenerate_jail(db)
        # Reconciliation: every tracked redirect URL belongs on the blacklist
        # feed (source='redirect'). Idempotent — already-blacklisted hosts are
        # no-ops — so this also backfills rows tracked before auto-blacklist
        # existed. Feeds are regenerated once at the end either way.
        from app.services.redirects import blacklist_tracked_hosts

        cursor = await db.execute("SELECT url FROM tracked_urls")
        tracked = [row[0] for row in await cursor.fetchall()]
        if tracked:
            added = await blacklist_tracked_hosts(db, tracked)
            if added:
                print(f"[INIT] auto-blacklisted {len(added)} tracked redirect host(s)")
    finally:
        await db.close()

    settings = get_settings()
    print(
        f"[INIT] msteams_webhook_url={'configured' if settings.msteams_webhook_url else 'NOT SET'}"
    )
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
    from app.services.monitor import refresh_field_inventory, warm_field_inventory
    from app.services.upstream_blacklist import sync_upstream_blacklist
    from app.services.upstream_jaillist import sync_upstream_jaillist

    scheduler.add_job(
        sync_upstream_blacklist,
        "interval",
        minutes=5,
        id="upstream-blacklist-sync",
        coalesce=True,
        max_instances=1,
    )
    scheduler.add_job(
        sync_upstream_jaillist,
        "interval",
        minutes=5,
        id="upstream-jaillist-sync",
        coalesce=True,
        max_instances=1,
    )
    # The field inventory is a statement about the ES *schema*, which changes
    # rarely and only by an operator re-indexing or adding a field. An hourly
    # refresh is therefore ample: it costs 24 requests/day against a healthy
    # ES, while still picking up a schema change (and, more importantly,
    # recovering automatically from an ES outage at boot: the failure path no
    # longer poisons the cache, so the next successful run repopulates it)
    # without an app restart. Non-fatal by construction — refresh_field_
    # inventory catches every exception and logs.
    scheduler.add_job(
        refresh_field_inventory,
        "interval",
        minutes=60,
        id="es-field-inventory-refresh",
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()

    # One best-effort immediate upstream sync; never blocks boot.
    try:
        await sync_upstream_blacklist()
    except Exception as e:
        log.warning("initial upstream blacklist sync failed: %s", e)

    try:
        await sync_upstream_jaillist()
    except Exception as e:
        log.warning("initial upstream jaillist sync failed: %s", e)

    # Warm ES field inventory (best-effort, never crashes boot)
    await warm_field_inventory()

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
# Blacklist router is mounted without auth: the .txt feed routes are public
# for external integrations; write/list routes opt back in per-route.
app.include_router(blacklist.router)
# Jaillist router is mounted without auth: the jail .txt feed is public for
# external integrations (firewall, fail2ban); write/list routes opt back in
# per-route.
app.include_router(jaillist.router)
app.include_router(redirects.router, dependencies=[Depends(verify_admin)])
app.include_router(query.router, dependencies=[Depends(verify_admin)])
app.include_router(analytics.router, dependencies=[Depends(verify_admin)])
app.include_router(backup.router, dependencies=[Depends(verify_admin)])
app.include_router(attck.router, dependencies=[Depends(verify_admin)])
app.include_router(enrich.router, dependencies=[Depends(verify_admin)])
app.include_router(hosts.router, dependencies=[Depends(verify_admin)])
app.include_router(logs.router, dependencies=[Depends(verify_admin)])
# Timezone router is mounted with the admin default like every other admin-UI
# read: it exposes the operator's configured zone (mild config disclosure) and
# the SPA already authenticates every API call, so exemption would save nothing.
app.include_router(timezone.router, dependencies=[Depends(verify_admin)])
# Verdict ledger: admin-gated like every other admin-UI write. The two
# routes inside also carry their own per-route verify_admin dependency.
app.include_router(triage.router, dependencies=[Depends(verify_admin)])
app.include_router(auth_routes.router)

from app.routes import readout as readout_routes

app.include_router(readout_routes.router, dependencies=[Depends(verify_admin)])

from app.routes import client_report as client_report_routes

app.include_router(client_report_routes.router, dependencies=[Depends(verify_admin)])


def is_api_reserved_path(full_path: str) -> bool:
    """True when a request path must never be answered with the SPA shell.

    The SPA catch-all returns index.html for unmatched paths. That turns any
    unregistered (or mistyped) API/health route into an HTTP 200 HTML response
    — a fake success that silently masks a missing router (see the hosts
    regression). Reserved prefixes therefore 404 as JSON instead.

    Module-level so it is testable without the conditional dist mount.
    """
    return (
        full_path == "health"
        or full_path == "api"
        or full_path.startswith(("api/", "health/"))
    )


# ── ES Field Inventory Debug Endpoint ───────────────────────────────────────
from app.services.es_fields import fetch_field_inventory


@app.get("/api/es/fields", dependencies=[Depends(verify_admin)])
async def es_fields():
    """Return cached ES field inventory or trigger fresh fetch.

    Response shape:
    {
        "sample": {...},
        "field_caps": {...},
        "cached": true|false,
        "mode": "UC-A|UC-B|COLLAPSED|UNKNOWN",
        "es_online": true|false
    }

    Always returns 200 — never 5xx on ES failure.
    """
    return await fetch_field_inventory()


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
        # Never answer an unmatched API/health path with the SPA shell: a
        # mistyped or unregistered endpoint must 404 as JSON, not return
        # index.html with HTTP 200 (which masked a missing router for real
        # users — see tests/test_route_precedence.py).
        if is_api_reserved_path(full_path):
            raise HTTPException(status_code=404, detail="Not Found")
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
