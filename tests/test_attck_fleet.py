"""Fleet-wide ATT&CK aggregate — SQLite-sourced, N+1-free, never-500.

The fleet endpoint exists because the per-entity panels cannot answer the
fleet question ("across all hosts, which techniques are present, how many?").
These tests pin three properties that make it trustworthy:

1. **No per-host ES call.** The aggregation reads the findings table only; the
   test asserts ``es_client`` is never touched.
2. **Same gate as the per-entity paths.** A technique withheld for a host is
   withheld fleet-wide, and the resolved mode is reported.
3. **Never 500.** A broken resolver or an unreadable table degrades to a
   well-formed empty result with a reason, never an exception.
"""


from app.services import attck_fleet as fleet
from app.services.attck_fleet import map_fleet


async def _seed(db, rows):
    """Insert findings rows; each is (client_ip, server_ip, url, action, bytes_up)."""
    for client_ip, server_ip, url, action, bytes_up, ts in rows:
        await db.execute(
            """
            INSERT INTO findings (client_ip, server_ip, url, base_url,
                                  log_timestamp, action, bytes_uploaded,
                                  bytes_downloaded)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
            """,
            (client_ip, server_ip, url, url.split("/")[2] if "//" in url else url,
             ts, action, bytes_up),
        )
    await db.commit()


def _uc_a_resolver(monkeypatch):
    """Force a UC-A availability so byte/domain fields are PRESENT."""
    from app.services.attck_mapping import resolve_availability

    monkeypatch.setattr(
        fleet,
        "resolve_availability",
        lambda **kw: resolve_availability(
            mode="UC-A",
            inventory_names={
                "@timestamp", "url", "client_ip", "server_ip",
                "duration_seconds", "action", "domain", "category",
                "bytes_downloaded", "bytes_uploaded", "rule_name",
            },
            es_online=True,
        ),
    )


async def test_map_fleet_empty_findings_is_well_formed(monkeypatch):
    """No findings => a valid empty mapping, not an error."""
    from app.database import init_db

    await init_db()
    _uc_a_resolver(monkeypatch)

    result = await map_fleet(1440)
    assert result.hosts_scanned == 0
    assert result.techniques == []
    assert "No persisted findings" in result.summary


async def test_map_fleet_unknown_mode_emits_zero_techniques(monkeypatch):
    """mode=UNKNOWN => zero techniques, es_online False, explicit reason."""
    from app.services.attck_mapping import FieldAvailability

    monkeypatch.setattr(
        fleet,
        "resolve_availability",
        lambda **kw: FieldAvailability(mode="UNKNOWN", es_online=False, fields={}),
    )
    result = await map_fleet(1440)
    assert result.techniques == []
    assert result.es_online is False
    assert result.mode == "UNKNOWN"
    assert "not resolvable" in result.summary


async def test_map_fleet_aggregates_across_hosts(monkeypatch):
    """Two hosts each evidencing T1078 aggregate to one row with host_count 2.

    T1078 needs client_ip + action + >= 20 requests + risk_share >= 0.8 + no
    enforcements + time_span >= 1h. Two hosts are seeded with 25 ALLOW rows
    spread over 2h, so both qualify and must be counted together.
    """
    from app.database import get_db, init_db

    await init_db()
    _uc_a_resolver(monkeypatch)
    db = await get_db()
    try:
        rows = []
        for host in ("10.0.0.1", "10.0.0.2"):
            for i in range(25):
                rows.append(
                    (
                        host,
                        "203.0.113.5",
                        f"https://svc.example/{i}",
                        "ALLOW",
                        0,
                        f"2026-09-18T{10 + (i // 15):02d}:{i % 60:02d}:00+00:00",
                    )
                )
        await _seed(db, rows)
    finally:
        await db.close()

    result = await map_fleet(60 * 24)
    assert result.hosts_scanned == 2
    by_id = {t.technique_id: t for t in result.techniques}
    assert "T1078" in by_id
    assert by_id["T1078"].host_count == 2
    assert set(by_id["T1078"].example_hosts) == {"10.0.0.1", "10.0.0.2"}


async def test_map_fleet_does_not_call_elasticsearch(monkeypatch):
    """The whole point: no per-host ES query (the N+1 this design avoids)."""
    from app.database import get_db, init_db

    await init_db()
    _uc_a_resolver(monkeypatch)

    # attck_fleet must not import the ES client or the per-host mapper. The
    # docstring may *name* map_host (to explain what this module avoids), so
    # assert on the import surface, not on substring presence.
    import app.services.attck_fleet as mod

    assert not hasattr(mod, "es_client")
    assert not hasattr(mod, "map_host")

    db = await get_db()
    try:
        await _seed(db, [("10.0.0.9", "203.0.113.9", "https://x.example/", "ALLOW", 0,
                          "2026-09-18T10:00:00+00:00")])
    finally:
        await db.close()

    result = await map_fleet(1440)
    assert result.hosts_scanned == 1


async def test_map_fleet_respects_host_limit(monkeypatch):
    """The technique aggregate spans all hosts; only the host list is capped."""
    from app.database import get_db, init_db

    await init_db()
    _uc_a_resolver(monkeypatch)
    db = await get_db()
    try:
        rows = [
            (f"10.0.1.{i}", "203.0.113.5", f"https://svc.example/{i}", "ALLOW", 0,
             "2026-09-18T10:00:00+00:00")
            for i in range(10)
        ]
        await _seed(db, rows)
    finally:
        await db.close()

    result = await map_fleet(1440, host_limit=3)
    assert result.hosts_scanned == 10
    assert len(result.host_summaries) == 3


async def test_map_fleet_survives_broken_resolver(monkeypatch):
    """A resolver that raises must not take the endpoint down (never 500)."""

    def _boom(**kw):
        raise RuntimeError("inventory exploded")

    monkeypatch.setattr(fleet, "resolve_availability", _boom)
    result = await map_fleet(1440)
    assert result.techniques == []
    assert result.mode == "UNKNOWN"
    assert result.es_online is False


async def test_map_fleet_endpoint_returns_200(client):
    """The route is wired and returns a well-formed payload."""
    resp = client.get("/api/attck/fleet?timeRange=24h")
    assert resp.status_code == 200
    body = resp.json()
    for key in (
        "generated_at", "es_online", "mode", "data_sources",
        "hosts_scanned", "hosts_with_techniques", "techniques", "summary",
    ):
        assert key in body, f"missing {key}"
