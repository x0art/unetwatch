"""Server-side exclusion filter for GET /api/findings/.

An excluded row must be absent from BOTH the page and the total, so page
offsets always describe the filtered result set. Terms are literal,
case-insensitive substrings of url / base_url / domain / matched_patterns —
never of the client or server IP columns.
"""

from datetime import datetime, timezone

import pytest

NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _seed_findings(db_path, rows):
    """Insert (client_ip, server_ip, url, base_url, domain, patterns, time) rows."""
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    try:
        await db.executemany(
            "INSERT INTO findings"
            " (client_ip, server_ip, url, base_url, domain, matched_patterns, log_timestamp)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        await db.commit()
    finally:
        await db.close()


async def test_exclude_hides_url_matches_case_insensitively(client, db_path):
    await _seed_findings(db_path, [
        ("1.1.1.1", "", "http://NetFlix.example/watch", "NetFlix.example", "NetFlix.example", "[]", NOW),
        ("2.2.2.2", "", "http://safe.example/", "safe.example", "safe.example", "[]", NOW),
    ])

    res = client.get("/api/findings/", params=[("exclude", "netflix")])

    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 1
    assert [row["client_ip"] for row in data["items"]] == ["2.2.2.2"]


async def test_exclude_matches_base_url_domain_and_matched_patterns(client, db_path):
    await _seed_findings(db_path, [
        ("1.1.1.1", "", "http://a.example/", "netflix-cdn.example", "a.example", "[]", NOW),
        ("2.2.2.2", "", "http://b.example/", "b.example", "netflix.example", "[]", NOW),
        ("3.3.3.3", "", "http://c.example/", "c.example", "c.example", '["NETFLIX"]', NOW),
        ("4.4.4.4", "", "http://safe.example/", "safe.example", "safe.example", '["other"]', NOW),
    ])

    res = client.get("/api/findings/", params=[("exclude", "netflix")])

    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 1
    assert [row["client_ip"] for row in data["items"]] == ["4.4.4.4"]


async def test_exclude_does_not_match_client_or_server_ip(client, db_path):
    await _seed_findings(db_path, [
        ("203.0.113.9", "netflix-cache.example", "http://safe.example/", "safe.example", "safe.example", "[]", NOW),
    ])

    res = client.get("/api/findings/", params=[("exclude", "netflix")])

    assert res.status_code == 200
    assert res.json()["total"] == 1
    assert len(res.json()["items"]) == 1


async def test_repeated_exclude_terms_exclude_a_row_matching_any_term(client, db_path):
    await _seed_findings(db_path, [
        ("1.1.1.1", "", "http://netflix.example/", "netflix.example", "netflix.example", "[]", NOW),
        ("2.2.2.2", "", "http://porn.example/", "porn.example", "porn.example", "[]", NOW),
        ("3.3.3.3", "", "http://netflix.example/porn", "netflix.example", "netflix.example", "[]", NOW),
        ("4.4.4.4", "", "http://safe.example/", "safe.example", "safe.example", "[]", NOW),
    ])

    res = client.get("/api/findings/", params=[("exclude", "netflix"), ("exclude", "porn")])

    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 1
    assert [row["client_ip"] for row in data["items"]] == ["4.4.4.4"]


async def test_exclude_terms_are_literal_substrings_not_sql_wildcards(client, db_path):
    await _seed_findings(db_path, [
        ("1.1.1.1", "", "http://netflix.example/", "netflix.example", "netflix.example", "[]", NOW),
    ])

    for term in ("%", "_", "n_tflix", "netflix%"):
        res = client.get("/api/findings/", params=[("exclude", term)])
        assert res.status_code == 200
        assert res.json()["total"] == 1, f"literal term {term!r} wrongly excluded the row"


async def test_exclude_ignores_empty_and_whitespace_only_terms(client, db_path):
    await _seed_findings(db_path, [
        ("1.1.1.1", "", "http://netflix.example/", "netflix.example", "netflix.example", "[]", NOW),
    ])

    res = client.get("/api/findings/", params=[("exclude", ""), ("exclude", "   "), ("exclude", "\t")])

    assert res.status_code == 200
    assert res.json()["total"] == 1
    assert len(res.json()["items"]) == 1


async def test_exclude_composes_with_search_minutes_limit_and_offset(client, db_path):
    await _seed_findings(db_path, [
        ("1.1.1.1", "", "http://netflix-keep.example/", "netflix-keep.example", "netflix-keep.example", "[]", NOW),
        ("2.2.2.2", "", "http://keep.example/1", "keep.example", "keep.example", "[]", NOW),
        ("3.3.3.3", "", "http://keep.example/2", "keep.example", "keep.example", "[]", NOW),
        ("4.4.4.4", "", "http://keep.example/0", "keep.example", "keep.example", "[]", "2020-01-01T00:00:00Z"),
    ])
    base = [("search", "keep"), ("minutes", "60"), ("exclude", "netflix"), ("limit", "1")]

    first = client.get("/api/findings/", params=[*base, ("offset", "0")])
    second = client.get("/api/findings/", params=[*base, ("offset", "1")])

    assert first.status_code == 200 and second.status_code == 200
    first_data, second_data = first.json(), second.json()
    assert first_data["total"] == 2  # excluded row and out-of-window row both gone
    assert second_data["total"] == 2
    assert [row["url"] for row in first_data["items"]] == ["http://keep.example/2"]
    assert [row["url"] for row in second_data["items"]] == ["http://keep.example/1"]
