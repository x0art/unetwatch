import os

import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def db_path(tmp_path):
    """Point the app at a temp SQLite DB for tests."""
    dbfile = tmp_path / "test.db"
    os.environ["DATABASE_URL"] = f"sqlite:///{dbfile}"

    # Reset cached settings so the new DATABASE_URL takes effect.
    from app.config import get_settings

    get_settings.cache_clear()

    yield str(dbfile)
    os.environ.pop("DATABASE_URL", None)
    get_settings.cache_clear()


@pytest_asyncio.fixture
async def client(db_path):
    from fastapi.testclient import TestClient

    from app.database import init_db
    from app.main import app

    await init_db()
    with TestClient(app) as c:
        yield c
