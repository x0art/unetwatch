"""Tests for the derived "Domain Blacklist" feed (sanctioned from url rows)."""
import asyncio

from app.database import get_db, init_db
from app.services.domain_blacklist import sanction_domains, url_host_to_domain


async def _insert(db, kind, value, source="manual"):
    await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value, source) VALUES (?, ?, ?)",
        (kind, value, source),
    )
    await db.commit()


async def _values(db, kind, source=None):
    if source is None:
        cursor = await db.execute(
            "SELECT value FROM blacklist_entries WHERE kind=? ORDER BY value", (kind,)
        )
    else:
        cursor = await db.execute(
            "SELECT value FROM blacklist_entries WHERE kind=? AND source=? ORDER BY value",
            (kind, source),
        )
    return [row[0] for row in await cursor.fetchall()]


# ── (a) the pure reduction function ──────────────────────────────────────


def test_url_host_to_domain_is_bare_lowercased_fqdn():
    # Rule: identity on the bare lowercased FQDN (see module docstring).
    assert url_host_to_domain("evil.example.com") == "evil.example.com"
    assert url_host_to_domain("WWW.Evil.Example.COM") == "www.evil.example.com"
    assert url_host_to_domain("  spaced.example.com  ") == "spaced.example.com"


# ── (b) sanction creates domain rows with source='sanction' ───────────────


def test_sanction_creates_domain_rows(db_path):
    async def run():
        await init_db()
        db = await get_db()
        try:
            await _insert(db, "url", "evil.example.com")
            await _insert(db, "url", "bad.example.org")
            await _insert(db, "ip", "1.2.3.4")
            stats = await sanction_domains(db)
            domains = await _values(db, "domain", "sanction")
        finally:
            await db.close()
        return stats, domains

    stats, domains = asyncio.run(run())
    assert stats == {"ok": True, "scanned": 2, "added": 2, "skipped": 0, "pruned": 0}
    assert domains == ["bad.example.org", "evil.example.com"]
    # The IP row is untouched; no ip->domain derivation.
    assert "1.2.3.4" not in domains


# ── (c) idempotency ──────────────────────────────────────────────────────


def test_sanction_is_idempotent(db_path):
    async def run():
        await init_db()
        db = await get_db()
        try:
            await _insert(db, "url", "evil.example.com")
            first = await sanction_domains(db)
            second = await sanction_domains(db)
            domains = await _values(db, "domain", "sanction")
        finally:
            await db.close()
        return first, second, domains

    first, second, domains = asyncio.run(run())
    assert first["added"] == 1
    assert second == {"ok": True, "scanned": 1, "added": 0, "skipped": 1, "pruned": 0}
    assert domains == ["evil.example.com"]


# ── (d) prune removes stale sanctioned domains, never other rows ──────────


def test_prune_removes_stale_domains_only(db_path):
    async def run():
        await init_db()
        db = await get_db()
        try:
            await _insert(db, "url", "keep.example.com")
            await _insert(db, "url", "gone.example.com")
            await sanction_domains(db)
            # Drop one URL row -> its sanctioned domain must be pruned.
            await db.execute(
                "DELETE FROM blacklist_entries WHERE kind='url' AND value='gone.example.com'"
            )
            # A hand-added domain (source != sanction) and an ip row must survive.
            await _insert(db, "domain", "manual.example.com", "manual")
            await _insert(db, "ip", "9.9.9.9")
            stats = await sanction_domains(db)
            domains = await _values(db, "domain")
            ips = await _values(db, "ip")
        finally:
            await db.close()
        return stats, domains, ips

    stats, domains, ips = asyncio.run(run())
    assert stats == {"ok": True, "scanned": 1, "added": 0, "skipped": 1, "pruned": 1}
    assert domains == ["keep.example.com", "manual.example.com"]
    assert ips == ["9.9.9.9"]


def test_empty_url_set_empties_derived_feed(db_path):
    async def run():
        await init_db()
        db = await get_db()
        try:
            await _insert(db, "url", "evil.example.com")
            await sanction_domains(db)
            await db.execute("DELETE FROM blacklist_entries WHERE kind='url'")
            await db.commit()
            stats = await sanction_domains(db)
            domains = await _values(db, "domain")
        finally:
            await db.close()
        return stats, domains

    stats, domains = asyncio.run(run())
    assert stats["ok"] is True
    assert stats["pruned"] == 1
    assert domains == []


# ── (e) domains.txt served bare + CRLF + public ──────────────────────────


def test_domains_feed_is_bare_crlf_and_public(client):
    # Add a URL via the API (normalizes to a bare host) then derive.
    client.post("/api/blacklist/", json={"value": "http://evil.example.com/path"})
    assert client.post("/api/blacklist/sanction-domains").status_code == 200

    # Public: fetch without auth.
    client.headers.clear()
    resp = client.get("/api/blacklist/domains.txt")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/plain")
    assert resp.text == "evil.example.com\r\n"


# ── (f) /entries includes domains ────────────────────────────────────────


def test_entries_endpoint_includes_domains(client):
    client.post("/api/blacklist/", json={"value": "evil.example.com"})
    client.post("/api/blacklist/sanction-domains")
    body = client.get("/api/blacklist/entries").json()
    assert set(body) == {"urls", "ips", "domains"}
    assert body["domains"] == ["evil.example.com"]


# ── (g) /sanction-domains returns ok + stats ─────────────────────────────


def test_sanction_route_returns_stats(client):
    client.post("/api/blacklist/", json={"value": "a.example.com"})
    client.post("/api/blacklist/", json={"value": "b.example.com"})
    resp = client.post("/api/blacklist/sanction-domains")
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["scanned"] == 2
    assert body["added"] == 2
    assert set(body) == {"ok", "scanned", "added", "skipped", "pruned"}


def test_upstream_status_reports_derived_domains(client):
    body = client.get("/api/blacklist/upstream-status").json()
    assert body["domains_configured"] is False
    assert body["domains_derived_from"] == "url"
    assert body["feeds"]["domains"] == {
        "last_added": 0,
        "last_skipped": 0,
        "last_errors": 0,
        "last_error": None,
        "last_deleted": 0,
    }


# ── (h) widened CHECK accepts a domain row ───────────────────────────────


def test_domain_kind_accepted_by_check(db_path):
    async def run():
        await init_db()
        db = await get_db()
        try:
            await db.execute(
                "INSERT INTO blacklist_entries (kind, value, source)"
                " VALUES ('domain', 'x.example.com', 'sanction')"
            )
            await db.commit()
            return await _values(db, "domain")
        finally:
            await db.close()

    assert asyncio.run(run()) == ["x.example.com"]


# ── (i) migration is idempotent ──────────────────────────────────────────


def test_migration_idempotent_and_preserves_rows(db_path):
    async def run():
        await init_db()
        db = await get_db()
        try:
            await _insert(db, "url", "pre.example.com")
            await _insert(db, "ip", "1.2.3.4")
        finally:
            await db.close()
        # Second init must not rebuild/lose anything.
        await init_db()
        db = await get_db()
        try:
            cursor = await db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table'"
                " AND name='blacklist_entries'"
            )
            ddl = (await cursor.fetchone())[0]
            urls = await _values(db, "url")
            ips = await _values(db, "ip")
        finally:
            await db.close()
        return ddl, urls, ips

    ddl, urls, ips = asyncio.run(run())
    assert "'domain'" in ddl
    assert "blacklist_entries_new" not in ddl
    assert urls == ["pre.example.com"]
    assert ips == ["1.2.3.4"]
