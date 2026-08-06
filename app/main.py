import os
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
from app.routes import blacklist, findings, monitor, patterns, redirects

scheduler = AsyncIOScheduler()


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
    title="ELK Monitoring",
    description="URL pattern monitoring with Elasticsearch integration",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # vite dev server
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,  # token is in a header, not a cookie
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-API-Key"],
)


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
        "script-src 'self' 'sha256-vB8+06HUTvRqA0K16sI1Y4RIaqA1mPIMgTm9Hz7YjJ0='; "
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
app.include_router(auth_routes.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


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


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
