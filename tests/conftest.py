import os
from base64 import b64encode

import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def db_path(tmp_path):
    """Point the app at a temp SQLite DB for tests."""
    dbfile = tmp_path / "test.db"
    os.environ["DATABASE_URL"] = f"sqlite:///{dbfile}"

    # Set auth creds for testing
    os.environ["ADMIN_USER"] = "admin"
    os.environ["ADMIN_PASS"] = "admin"

    # Reset cached settings so the new values take effect.
    from app.config import get_settings

    get_settings.cache_clear()

    yield str(dbfile)
    os.environ.pop("DATABASE_URL", None)
    os.environ.pop("ADMIN_USER", None)
    os.environ.pop("ADMIN_PASS", None)
    get_settings.cache_clear()


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
