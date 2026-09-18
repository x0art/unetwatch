"""Client IP Report — rule-information honesty tests.

The operator's ``logstash-proxy-*`` documents carry no ``matched_patterns``
field (the backend default-fills it with ``""``), so a report must serve no
rule information rather than a literal that reads like a rule name. These
tests pin the sentinel behaviour added alongside the ``analytics.py`` fix:
``_primary_rule`` returns ``""`` and the two consumers guard against empty
(not against the old ``"matched"`` literal).
"""


async def _seed_findings(db_path, rows) -> None:
    import aiosqlite

    db = await aiosqlite.connect(db_path)
    await db.execute("DELETE FROM findings")
    await db.executemany(
        "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp,"
        " matched_patterns) VALUES (?, ?, ?, ?, ?, ?)",
        rows,
    )
    await db.commit()
    await db.close()


async def test_client_report_no_matched_patterns_serves_no_rule(client, db_path):
    """Rows with empty ``matched_patterns`` must not surface ``"matched"``.

    Neither the single ``top_pattern`` nor the ``top_patterns`` list may carry
    the old literal sentinel, and ``top_patterns`` must not gain a
    blank-pattern row now that the sentinel is empty and the filter guards on
    emptiness instead.
    """
    await _seed_findings(
        db_path,
        [
            ("1.1.1.1", "", "http://a.example/1", "a.example", "2026-08-01T00:00:00Z", ""),
            ("1.1.1.1", "", "http://a.example/2", "a.example", "2026-08-01T00:00:01Z", ""),
        ],
    )

    res = client.get("/api/client-report/1.1.1.1")
    assert res.status_code == 200
    data = res.json()

    # top_pattern: empty/None, never the literal.
    assert data["top_pattern"] != "matched"
    assert not data["top_pattern"]

    # top_patterns: no blank-pattern row, and no literal either.
    assert data["top_patterns"] == []
    assert all(entry["pattern"] for entry in data["top_patterns"])


async def test_client_report_csv_has_no_blank_pattern_row(client, db_path):
    """The CSV export mirrors the JSON — no blank pattern row, no literal.

    ``top_pattern`` is written as ``payload["top_pattern"] or ""`` (empty when
    unknown) and ``top_patterns`` is written row-by-row, so an empty sentinel
    must not produce a ``pattern,hits`` line with an empty pattern.
    """
    await _seed_findings(
        db_path,
        [
            ("1.1.1.1", "", "http://a.example/1", "a.example", "2026-08-01T00:00:00Z", ""),
        ],
    )

    res = client.get("/api/client-report/1.1.1.1/export.csv")
    assert res.status_code == 200
    text = res.text

    assert "matched" not in text
    # The "Top Patterns" section header exists but is followed by no data row.
    lines = text.splitlines()
    idx = lines.index("Top Patterns")
    assert lines[idx + 1] == "pattern,hits"
    assert lines[idx + 2].strip() == ""


async def test_client_report_preserves_real_pattern(client, db_path):
    """A real ``matched_patterns`` value still flows through unchanged."""
    await _seed_findings(
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", "2026-08-01T00:00:00Z", '["*evil*"]'),
        ],
    )

    data = client.get("/api/client-report/1.1.1.1").json()
    assert data["top_pattern"] == "*evil*"
    assert data["top_patterns"] == [{"pattern": "*evil*", "hits": 1}]
