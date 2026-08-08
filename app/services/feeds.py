"""Static blacklist feed files (urls.txt / ips.txt).

The plain-text feeds under /api/blacklist/{urls,ips}.txt are real files on
disk: the database remains the source of truth, and ``sync_regenerate``
rewrites the two files from the ``blacklist_entries`` table. It runs at
startup (via app.main lifespan) and after every blacklist mutation (POST /
DELETE in the API route), so the files on disk always match the DB.

Writes are atomic — a temp file in the same directory is fsynced then
``os.replace``d over the target — so a downstream consumer (nginx,
fail2ban, a firewall script) never reads a half-written feed.
"""

import os
from pathlib import Path

from app.config import get_settings


def feeds_dir() -> Path:
    """Directory holding the feed files; created on demand."""
    path = Path(get_settings().blacklist_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _feed_path(kind: str) -> Path:
    return feeds_dir() / f"{kind}s.txt"  # 'url' -> urls.txt, 'ip' -> ips.txt


async def _values(db, kind: str) -> list[str]:
    cursor = await db.execute(
        "SELECT value FROM blacklist_entries WHERE kind = ? ORDER BY value",
        (kind,),
    )
    return [row[0] for row in await cursor.fetchall()]


def _atomic_write(path: Path, body: str) -> None:
    """Write ``body`` to ``path`` atomically (tmp file + rename)."""
    tmp = path.with_name(f".{path.name}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


async def sync_regenerate(db, kinds: tuple[str, ...] = ("url", "ip")) -> None:
    """Rewrite the feed files for ``kinds`` from the database."""
    for kind in kinds:
        _atomic_write(_feed_path(kind), "\n".join(await _values(db, kind)) + "\n")
