import os
from base64 import b64encode

import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def db_path(tmp_path):
    """Point the app at a temp SQLite DB and feed dir for tests."""
    dbfile = tmp_path / "test.db"
    os.environ["DATABASE_URL"] = f"sqlite:///{dbfile}"
    os.environ["BLACKLIST_DIR"] = str(tmp_path / "feeds")

    # Set auth creds for testing
    os.environ["ADMIN_USER"] = "admin"
    os.environ["ADMIN_PASS"] = "admin"

    # Reset cached settings so the new values take effect.
    from app.config import get_settings
    from app.services import timeutil

    get_settings.cache_clear()
    # `system_zone_name()` memoises the host-zone lookup process-wide (it is
    # read inside per-row loops). Reset it per test so a test that sets `TZ`
    # is not contaminated by a previous test's resolved zone.
    timeutil.reset_system_zone_cache()

    yield str(dbfile)
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("BLACKLIST_DIR", None)
    os.environ.pop("ADMIN_USER", None)
    os.environ.pop("ADMIN_PASS", None)
    get_settings.cache_clear()
    timeutil.reset_system_zone_cache()


@pytest_asyncio.fixture
async def client(db_path):
    from fastapi.testclient import TestClient

    from app.database import init_db
    from app.main import app

    await init_db()

    # Pre-computed Basic auth header for test default admin:admin
    basic = b64encode(b"admin:admin").decode()
    headers = {"Authorization": f"Basic {basic}"}

    with TestClient(app, headers=headers) as c:
        yield c
