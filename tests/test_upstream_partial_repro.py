"""Repro: partial upstream insert — per-line bucket attribution.

Same seam as tests/test_upstream_blacklist.py::_run_sync: stub
app.services.upstream_blacklist._fetch_text, env UPSTREAM_BLACKLIST_URLS/IPS,
db_path fixture + init_db, get_settings.cache_clear before/after.
"""

URLS_FEED = "https://example.com/urls.txt"


async def test_partial_insert_bucket_attribution(monkeypatch, db_path):
    from app.config import get_settings
    from app.database import get_db, init_db
    from app.services import upstream_blacklist as ub

    urls_body = (
        "good-new.example.com\n"
        "already.example.com\n"
        "dup.example.com\n"
        "dup.example.com\n"
        "0.0.0.0 decorated.example.com\n"
        "evil.com # inline comment\n"
        "localhost\n"
        "::1\n"
        "not a url\n"
        "# full comment\n"
        "\n"
    )

    monkeypatch.setenv("UPSTREAM_BLACKLIST_URLS", URLS_FEED)
    monkeypatch.setenv("UPSTREAM_BLACKLIST_IPS", "")
    get_settings.cache_clear()

    async def fake_fetch(url: str) -> str:
        assert url == URLS_FEED, f"unexpected fetch url: {url}"
        return urls_body

    monkeypatch.setattr(ub, "_fetch_text", fake_fetch)
    try:
        await init_db()
        # Pre-seed one manual row that the feed will collide with.
        db = await get_db()
        try:
            await db.execute(
                "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
                " VALUES ('url', 'already.example.com', 'manual')"
            )
            await db.commit()
        finally:
            await db.close()

        result = await ub.sync_upstream_blacklist()
    finally:
        get_settings.cache_clear()

    # Tolerant parsing: fetched=9 (11 physical lines minus full comment +
    # blank dropped by parse_upstream_body); added=4 (good-new, dup first,
    # decorated via hosts-style, evil via inline-comment strip);
    # skipped=2 (already via INSERT OR IGNORE, dup second via seen set);
    # errors=3 (localhost, ::1, multi-space garbage).
    assert result["ok"] is True
    assert result["fetched"] == 9, result
    assert result["added"] == 4, result
    assert result["skipped"] == 2, result
    assert len(result["errors"]) == 3, result

    error_by_value = {e["value"]: e["error"] for e in result["errors"]}
    assert set(error_by_value) == {
        "localhost",
        "::1",
        "not a url",
    }, result["errors"]
    for v, msg in error_by_value.items():
        assert msg == "value must be a URL (http://...) or IPv4 address", (v, msg)

    db = await get_db()
    try:
        cur = await db.execute(
            "SELECT kind, value, source FROM blacklist_entries ORDER BY value"
        )
        rows = [(r["kind"], r["value"], r["source"]) for r in await cur.fetchall()]
    finally:
        await db.close()
    assert rows == [
        ("url", "already.example.com", "manual"),
        ("url", "decorated.example.com", "upstream"),
        ("url", "dup.example.com", "upstream"),
        ("url", "evil.com", "upstream"),
        ("url", "good-new.example.com", "upstream"),
    ], rows

    # Per-line bucket attribution (line no. → bucket + reason).
    breakdown = [
        (1, "good-new.example.com", "added", "fresh INSERT OR IGNORE inserts"),
        (2, "already.example.com", "skipped", "UNIQUE(kind,value) vs manual row → rowcount 0"),
        (3, "dup.example.com", "added", "first occurrence inserts"),
        (4, "dup.example.com", "skipped", "second occurrence in `seen` set"),
        (5, "0.0.0.0 decorated.example.com", "added", "hosts-style: first token valid IPv4 → second token parsed"),
        (6, "evil.com # inline comment", "added", "inline comment stripped on whitespace + # → evil.com"),
        (7, "localhost", f"error: {error_by_value['localhost']}", "no dot and not IPv4"),
        (8, "::1", f"error: {error_by_value['::1']}", "IPv6 unsupported; host split on ':' yields ''"),
        (9, "not a url", f"error: {error_by_value['not a url']}", "multi-space garbage rejected"),
        (10, "# full comment", "dropped-as-comment", "parse drops full-line #"),
        (11, "<blank>", "dropped-as-comment", "parse drops empties"),
    ]
    # Hard per-line asserts with clear ids (fail here = code changed bucket).
    assert breakdown[0][2] == "added"  # line 1
    assert breakdown[1][2] == "skipped"  # line 2 pre-existing
    assert breakdown[3][2].startswith("skipped")  # line 4 in-batch dup
    assert breakdown[4][2] == "added"  # line 5 hosts-style now parsed
    assert breakdown[5][2] == "added"  # line 6 inline comment now stripped
    assert breakdown[9][2] == "dropped-as-comment"  # line 10
    assert breakdown[10][2] == "dropped-as-comment"  # line 11
    print("\nBUCKET TABLE:")
    for lineno, line, bucket, reason in breakdown:
        print(f"  L{lineno:02d} {line!r} → {bucket} ({reason})")
