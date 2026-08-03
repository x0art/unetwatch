import os
from contextlib import asynccontextmanager

import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings, verify_admin
from app.database import init_db, seed_defaults
from app.routes import auth as auth_routes
from app.routes import monitor, patterns

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await seed_defaults()

    settings = get_settings()
    from app.services.monitor import fetch_logs

    scheduler.add_job(fetch_logs, "interval", minutes=settings.poll_interval_minutes)
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
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(patterns.router, dependencies=[Depends(verify_admin)])
app.include_router(monitor.router, dependencies=[Depends(verify_admin)])
app.include_router(auth_routes.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Admin UI (served from built assets) ───────────────────────────────────
_ADMIN_DIST = os.path.join(os.path.dirname(__file__), "..", "admin-ui", "dist")

if os.path.isdir(_ADMIN_DIST):
    app.mount(
        "/assets",
        StaticFiles(directory=os.path.join(_ADMIN_DIST, "assets")),
        name="assets",
    )

    @app.get("/")
    async def admin_index():
        return FileResponse(os.path.join(_ADMIN_DIST, "index.html"))

    @app.get("/{full_path:path}")
    async def admin_spa(full_path: str):
        candidate = os.path.join(_ADMIN_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(os.path.join(_ADMIN_DIST, "index.html"))


if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
