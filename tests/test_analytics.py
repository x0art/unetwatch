"""Analytics risk/enforcements reframe (ADR 0001) — regression tests.

Risk = a URL matched a block pattern, the proxy action was ALLOW, and it is
not whitelisted. Enforcements = DENY/FLAG (the proxy already handled the
request). The findings table only ever holds ALLOW rows in production, so
real enforcement counts come from live ES; the findings fallback reports
enforcements = 0.
"""

import json
from datetime import UTC, datetime

import aiosqlite


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _seed(client, db_path, rows, add_action_col: bool = False):
    """Insert findings rows; optionally add the extended ``action`` column first."""
    db = await aiosqlite.connect(db_path)
    if add_action_col:
        cols = {
            r[1] for r in await (await db.execute("PRAGMA table_info(findings)")).fetchall()
        }
        if "action" not in cols:
            await db.execute(
                "ALTER TABLE findings ADD COLUMN action TEXT NOT NULL DEFAULT ''"
            )
    if add_action_col:
        await db.executemany(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp,"
            " matched_patterns, action) VALUES (?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
    else:
        await db.executemany(
            "INSERT INTO findings (client_ip, server_ip, url, base_url, log_timestamp,"
            " matched_patterns) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    await db.commit()
    await db.close()


async def test_summary_legacy_no_action_column_risks_only(client, db_path):
    """Without an action column, every block-pattern row is a risk (ADR 0001)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"])),
            ("1.1.1.1", "", "http://bad.example/b", "bad.example", _now(), json.dumps(["*bad*"])),
        ],
        add_action_col=False,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["source"] == "findings"
    assert data["totalRisk"] == 2
    assert data["totalEnforcements"] == 0
    # The legacy totalBlocked alias mirrors ENFORCEMENTS, never risk — so the
    # ADR-0001 semantic holds even for old consumers.
    assert data["totalBlocked"] == data["totalEnforcements"] == 0
    assert "enforcementsDeltaPct" in data


async def test_summary_extended_action_split(client, db_path):
    """With an action column: ALLOW = risk, DENY/FLAG = enforcement, empty action
    + matched_patterns = risk (stored as an ALLOW risk)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
            ("1.1.1.1", "", "http://bad.example/b", "bad.example", _now(), json.dumps(["*bad*"]), "DENY"),
            ("2.2.2.2", "", "http://flagged.example/c", "flagged.example", _now(), json.dumps(["*flag*"]), "FLAG"),
            ("2.2.2.2", "", "http://legacy.example/d", "legacy.example", _now(), json.dumps(["*legacy*"]), ""),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["totalRisk"] == 2  # ALLOW + empty-action legacy row
    assert data["totalEnforcements"] == 2  # DENY + FLAG
    # Legacy alias mirrors enforcements (2), NOT risk (2≠"blocked" conflate).
    assert data["totalBlocked"] == 2


async def test_enforcements_findings_fallback(client, db_path):
    """The enforcements chart still renders from the findings table (offline ES)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/enforcements?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["es_online"] is False
    assert data["source"] == "findings"
    assert data["points"]  # at least one bucket


async def test_top_enforced_endpoint(client, db_path):
    """/api/analytics/top-enforced returns enforcements + primaryRule; the
    legacy /top-denied alias maps blocks -> enforcements."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "DENY"),
            ("1.1.1.1", "", "http://bad.example/b", "bad.example", _now(), json.dumps(["*bad*"]), "ALLOW"),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/top-enforced?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["items"] == [
        {"domain": "evil.example", "count": 1, "enforcements": 1, "primaryRule": "*evil*"}
    ]

    legacy = client.get("/api/analytics/top-denied?range=7d")
    assert legacy.status_code == 200
    ldata = legacy.json()
    assert ldata["items"] == [
        {"domain": "evil.example", "count": 1, "blocks": 1, "primaryRule": "*evil*"}
    ]


async def test_summary_blacklisted_allow_is_additive_risk(client, db_path):
    """A blacklisted destination whose request was ALLOWed is the highest-risk
    signal: it counts in ``totalRisk`` AND as the distinct additive
    ``totalBlacklistedRisk`` (ADR 0001 semantics preserved)."""
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
        " VALUES ('url', 'evil.example')"
    )
    await db.commit()
    await db.close()

    await _seed(
        client,
        db_path,
        [
            (
                "1.1.1.1", "", "http://evil.example/a", "evil.example",
                _now(), json.dumps(["*evil*"]), "ALLOW",
            ),
            (
                "1.1.1.1", "", "http://bad.example/b", "bad.example",
                _now(), json.dumps(["*bad*"]), "ALLOW",
            ),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["source"] == "findings"
    assert data["totalRisk"] == 2  # both ALLOW rows remain risk
    assert data["totalBlacklistedRisk"] == 1  # only the blacklisted one


async def test_summary_blacklist_deny_not_risk(client, db_path):
    """A blacklisted destination that was DENYed is an enforcement, not risk —
    totalBlacklistedRisk stays 0 (the proxy already stopped it)."""
    db = await aiosqlite.connect(db_path)
    await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value)"
        " VALUES ('url', 'evil.example')"
    )
    await db.commit()
    await db.close()

    await _seed(
        client,
        db_path,
        [
            (
                "1.1.1.1", "", "http://evil.example/a", "evil.example",
                _now(), json.dumps(["*evil*"]), "DENY",
            ),
        ],
        add_action_col=True,
    )

    res = client.get("/api/analytics/summary?range=7d")
    assert res.status_code == 200
    data = res.json()
    assert data["totalRisk"] == 0
    assert data["totalBlacklistedRisk"] == 0
    assert data["totalEnforcements"] == 1


async def test_summary_accepts_1h_range(client, db_path):
    """1h range is now supported (aligned with FilterContext presets)."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )
    res = client.get("/api/analytics/summary?range=1h")
    assert res.status_code == 200
    assert res.json()["range"] == "1h"


async def test_findings_list_minutes_window(client, db_path):
    """GET /findings/?minutes= narrows the raw-data window."""
    await _seed(
        client,
        db_path,
        [
            ("1.1.1.1", "", "http://evil.example/a", "evil.example", _now(), json.dumps(["*evil*"]), "ALLOW"),
        ],
        add_action_col=True,
    )
    res = client.get("/api/findings/?minutes=60")
    assert res.status_code == 200
    data = res.json()
    assert data["total"] == 1
    assert data["items"][0]["client_ip"] == "1.1.1.1"
