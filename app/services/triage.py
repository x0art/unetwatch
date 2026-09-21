"""The verdict ledger — recording a human's decision on a flagged event.

The product's enforcement actions (blacklist a destination, jail a source)
are human-confirmed only: an operator looks at a queue row, decides, and the
decision is written here permanently. ``triage_events`` is append-only, like
``blacklist_events`` — a correction is a NEW row whose ``supersedes_id``
points at the row it replaces, never an edit. The *effective* verdict for a
subject is therefore the newest row in its supersede chain.

This module is deliberately pure over the DB: each function takes an open
connection and issues SQL. Nothing here writes a feed, and nothing here
auto-blacklists or auto-jails.
"""

import json
from datetime import UTC, datetime, timedelta

from app.services.timeutil import local_day, operator_tz, zone_label

# Allowed verdicts — the DB CHECK is the backstop, not the only guard.
VERDICT_HARMFUL_DESTINATION = "HARMFUL_DESTINATION"
VERDICT_HARMFUL_SOURCE = "HARMFUL_SOURCE"
VERDICT_NOT_HARMFUL = "NOT_HARMFUL"
VERDICT_INCONCLUSIVE = "INCONCLUSIVE"

ALLOWED_VERDICTS = (
    VERDICT_HARMFUL_DESTINATION,
    VERDICT_HARMFUL_SOURCE,
    VERDICT_NOT_HARMFUL,
    VERDICT_INCONCLUSIVE,
)

SUBJECT_KIND_DESTINATION = "destination"
SUBJECT_KIND_SOURCE = "source"

ALLOWED_SUBJECT_KINDS = (SUBJECT_KIND_DESTINATION, SUBJECT_KIND_SOURCE)

# Rolling window (design §2.2 D4 / §3.2 S6): evaluated over persisted
# findings, never over the live Elasticsearch window.
DEFAULT_WINDOW_DAYS = 30

# Intent is a pure function of action (§7.3): legacy rows kept the '' default,
# so intent must be recovered rather than read raw. Defined once here and
# reused by every evidence query below — never derived from `rule_info`.
_INTENT_EXPR = (
    "COALESCE(NULLIF(intent, ''), "
    "CASE WHEN action = 'ALLOW' THEN 'REACH' "
    "WHEN action = 'DENY' THEN 'ATTEMPT' ELSE '' END)"
)


def _utc_now_iso() -> str:
    """UTC ISO string in the same convention as ``findings.log_timestamp``.

    That column is written as ``datetime.now(UTC).isoformat()``
    (``app/services/result_processor.py:161``) — an offset-aware ISO-8601
    string, e.g. ``2026-09-21T03:08:53.462148+00:00``. Match it exactly so a
    lexicographic string compare orders verdicts identically to how findings
    order by time.
    """
    return datetime.now(UTC).isoformat()


def _json_array(value) -> str:
    """Serialize a list to a JSON array string (never ``None``)."""
    if value is None:
        return "[]"
    try:
        return json.dumps(list(value))
    except (TypeError, ValueError):
        return "[]"


def _json_object(value) -> str:
    """Serialize a mapping to a JSON object string (never ``None``)."""
    if value is None:
        return "{}"
    try:
        return json.dumps(dict(value))
    except (TypeError, ValueError):
        return "{}"


async def record_verdict(
    db,
    *,
    subject_kind: str,
    subject: str,
    verdict: str,
    finding_id: int | None = None,
    url: str = "",
    category: str = "",
    note: str = "",
    rule_ids=None,
    evidence_summary=None,
    decided_by: str = "",
    decided_tz: str = "",
    supersedes_id: int | None = None,
) -> int:
    """Append exactly ONE verdict row and return its id.

    Every verdict writes here, including the two that produce no artifact
    (``NOT_HARMFUL`` writes a whitelist pattern, ``INCONCLUSIVE`` writes
    nothing else at all). ``rule_ids`` and ``evidence_summary`` are
    serialized to JSON. ``decided_at`` is stamped UTC in the
    ``findings.log_timestamp`` convention; ``decided_tz`` records the zone in
    force at decision time (design §6.3 item 2) so a later config change does
    not silently rewrite history's meaning.

    Raises ``ValueError`` for an unknown ``subject_kind`` or ``verdict`` — the
    DB CHECK is the backstop, not the only guard.
    """
    if subject_kind not in ALLOWED_SUBJECT_KINDS:
        raise ValueError(
            f"subject_kind must be one of {ALLOWED_SUBJECT_KINDS!r}, "
            f"got {subject_kind!r}"
        )
    if verdict not in ALLOWED_VERDICTS:
        raise ValueError(
            f"verdict must be one of {ALLOWED_VERDICTS!r}, got {verdict!r}"
        )
    subject = (subject or "").strip()
    if not subject:
        raise ValueError("subject must not be empty")

    cursor = await db.execute(
        "INSERT INTO triage_events"
        " (subject_kind, subject, verdict, rule_ids, finding_id, url, category,"
        "  note, evidence_summary, decided_by, decided_at, decided_tz,"
        "  supersedes_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            subject_kind,
            subject,
            verdict,
            _json_array(rule_ids),
            finding_id,
            url or "",
            category or "",
            note or "",
            _json_object(evidence_summary),
            decided_by or "",
            _utc_now_iso(),
            decided_tz or zone_label(operator_tz()),
            supersedes_id,
        ),
    )
    return cursor.lastrowid


async def verdict_history(db, subject_kind: str, subject: str) -> list[dict]:
    """The full supersede chain for a subject, newest first.

    Includes every row ever written for the subject — the chain is not
    pruned when a row is superseded, because "it was first judged X, then
    corrected to Y" is itself a fact about the ledger.
    """
    cursor = await db.execute(
        "SELECT * FROM triage_events"
        " WHERE subject_kind = ? AND subject = ?"
        " ORDER BY decided_at DESC, id DESC",
        (subject_kind, subject),
    )
    return [dict(row) for row in await cursor.fetchall()]


async def effective_verdict(db, subject_kind: str, subject: str) -> dict | None:
    """The newest row in the supersede chain, or ``None`` if unjudged.

    The effective verdict is the row with the greatest ``decided_at`` that no
    *other* row's ``supersedes_id`` points at (design §7.2). Returning
    ``None`` — rather than a synthesized "unknown" verdict — is the honest
    answer when a subject has never been decided.
    """
    cursor = await db.execute(
        "SELECT * FROM triage_events AS t"
        " WHERE t.subject_kind = ? AND t.subject = ?"
        "   AND NOT EXISTS ("
        "       SELECT 1 FROM triage_events AS s WHERE s.supersedes_id = t.id"
        "   )"
        " ORDER BY t.decided_at DESC, t.id DESC"
        " LIMIT 1",
        (subject_kind, subject),
    )
    row = await cursor.fetchone()
    return dict(row) if row is not None else None


async def _destination_evidence(db, subject: str, window_days: int) -> dict:
    """Frozen Queue A evidence for a destination (design §2.2/§2.3).

    Only counts that exist are returned; a count that cannot be computed is
    omitted rather than guessed as 0. No bandwidth field is read.
    """
    since = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    cursor = await db.execute(
        f"""
        SELECT
            SUM(CASE WHEN {_INTENT_EXPR} = 'REACH' THEN 1 ELSE 0 END) AS reach_count,
            SUM(CASE WHEN {_INTENT_EXPR} = 'ATTEMPT' THEN 1 ELSE 0 END) AS attempt_count,
            COUNT(DISTINCT CASE WHEN {_INTENT_EXPR} = 'REACH'
                                THEN client_ip END) AS distinct_reach_clients,
            COUNT(DISTINCT CASE WHEN {_INTENT_EXPR} = 'ATTEMPT'
                                THEN client_ip END) AS distinct_attempt_clients,
            MIN(log_timestamp) AS first_seen,
            MAX(log_timestamp) AS last_seen
        FROM findings
        WHERE base_url = ? AND log_timestamp >= ?
        """,
        (subject, since),
    )
    row = await cursor.fetchone()
    reach_count = int(row["reach_count"] or 0)
    attempt_count = int(row["attempt_count"] or 0)
    distinct_reach = int(row["distinct_reach_clients"] or 0)
    distinct_attempt = int(row["distinct_attempt_clients"] or 0)

    blocked_cur = await db.execute(
        "SELECT 1 FROM blacklist_entries WHERE value = ? LIMIT 1", (subject,)
    )
    blocked = await blocked_cur.fetchone() is not None

    rule_ids: list[str] = []
    if distinct_reach >= 3:
        rule_ids.append("D1")
    if reach_count >= 1 and blocked:
        rule_ids.append("D2")
    if distinct_attempt >= 2 and blocked:
        rule_ids.append("D3")

    return {
        "subject_kind": SUBJECT_KIND_DESTINATION,
        "subject": subject,
        "window_days": window_days,
        "reach_count": reach_count,
        "attempt_count": attempt_count,
        "distinct_reach_clients": distinct_reach,
        "distinct_attempt_clients": distinct_attempt,
        "blocked": blocked,
        "first_seen": row["first_seen"],
        "last_seen": row["last_seen"],
        "rule_ids": rule_ids,
    }


async def _source_evidence(db, subject: str, window_days: int) -> dict:
    """Frozen Queue B evidence for a source client IP (design §3.2/§3.3).

    Counts that exist are returned; missing ones are omitted, never guessed.
    S3's counts are bucketed to operator-local calendar days and the distinct
    day labels are frozen alongside the count, so the rule's output is
    reproducible from the ledger alone (design §6.3 item 3).
    """
    since = (datetime.now(UTC) - timedelta(days=window_days)).isoformat()
    cursor = await db.execute(
        f"""
        SELECT
            log_timestamp,
            base_url,
            {_INTENT_EXPR} AS intent
        FROM findings
        WHERE client_ip = ? AND log_timestamp >= ?
        """,
        (subject, since),
    )
    rows = await cursor.fetchall()

    reach_rows = [r for r in rows if r["intent"] == "REACH"]
    attempt_rows = [r for r in rows if r["intent"] == "ATTEMPT"]
    distinct_reach_urls = {r["base_url"] for r in reach_rows if r["base_url"]}
    distinct_attempt_urls = {r["base_url"] for r in attempt_rows if r["base_url"]}

    # S2 requires a single base_url carrying BOTH ≥1 REACH and ≥3 ATTEMPT.
    reach_bases = {r["base_url"] for r in reach_rows}
    attempt_by_base: dict[str, int] = {}
    for r in attempt_rows:
        attempt_by_base[r["base_url"]] = attempt_by_base.get(r["base_url"], 0) + 1

    # S3: distinct operator-local calendar days carrying a REACH event. The
    # labels are frozen with the count — a later DISPLAY_TZ change must not
    # retroactively re-bucket this rule's evidence (design §6.3 item 3).
    reach_local_days = sorted({local_day(r["log_timestamp"]) for r in reach_rows} - {""})

    # S4: distinct policy classes that fired, from flattened matched_patterns.
    classes: set[str] = set()
    pattern_cur = await db.execute(
        """
        SELECT matched_patterns FROM findings
        WHERE client_ip = ? AND log_timestamp >= ?
        """,
        (subject, since),
    )
    for prow in await pattern_cur.fetchall():
        raw = prow["matched_patterns"]
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(parsed, list):
            classes.update(str(p) for p in parsed if p)

    # S5: ≥1 REACH on a base_url that is currently blacklisted.
    reach_bases_blocked = 0
    if reach_bases:
        placeholders = ", ".join("?" * len(reach_bases))
        bl_cur = await db.execute(
            f"SELECT value FROM blacklist_entries WHERE value IN ({placeholders})",
            tuple(reach_bases),
        )
        reach_bases_blocked = len([r[0] for r in await bl_cur.fetchall()])

    rule_ids: list[str] = []
    if len(reach_rows) >= 3 and len(distinct_reach_urls) >= 2:
        rule_ids.append("S1")
    for base in reach_bases:
        if attempt_by_base.get(base, 0) >= 3:
            rule_ids.append("S2")
            break
    if len(reach_rows) >= 2 and len(reach_local_days) >= 2:
        rule_ids.append("S3")
    if len(classes) >= 2:
        rule_ids.append("S4")
    if reach_bases_blocked >= 1:
        rule_ids.append("S5")

    return {
        "subject_kind": SUBJECT_KIND_SOURCE,
        "subject": subject,
        "window_days": window_days,
        "reach_count": len(reach_rows),
        "attempt_count": len(attempt_rows),
        "distinct_reach_base_urls": len(distinct_reach_urls),
        "distinct_attempt_base_urls": len(distinct_attempt_urls),
        "reach_local_days": reach_local_days,
        "policy_classes": sorted(classes),
        "reach_bases_blocked": reach_bases_blocked,
        "rule_ids": rule_ids,
    }


async def summarize_evidence(
    db, subject_kind: str, subject: str, window_days: int = DEFAULT_WINDOW_DAYS
) -> dict:
    """Compute the frozen ``evidence_summary`` dict for a decision.

    Design §3.3 explains why this must be STORED at decision time rather than
    recomputed later: the rolling window (D4/S6) moves, so recomputing months
    after a jail yields a different number than the one that justified it —
    which makes leaving the jail in place the rational move, and turns the
    owner's declined expiry policy into a de-facto permanent jail.

    Pure over the DB: it reads ``findings`` and ``blacklist_entries`` and
    returns a plain dict. It writes nothing. Every returned number is a real
    count over persisted rows; a count that cannot be computed is omitted,
    never synthesized.
    """
    if subject_kind == SUBJECT_KIND_DESTINATION:
        return await _destination_evidence(db, subject, window_days)
    if subject_kind == SUBJECT_KIND_SOURCE:
        return await _source_evidence(db, subject, window_days)
    raise ValueError(
        f"subject_kind must be one of {ALLOWED_SUBJECT_KINDS!r}, "
        f"got {subject_kind!r}"
    )
