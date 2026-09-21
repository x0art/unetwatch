"""The verdict endpoint — recording a human decision on a flagged subject.

``POST /api/triage/verdict`` writes exactly ONE ``triage_events`` row for
every verdict, and — depending on the verdict — one enforcement artifact:

- ``HARMFUL_DESTINATION`` → a ``blacklist_entries`` row (via the existing
  blacklist write path, so ``urls.txt``/``ips.txt`` regenerate).
- ``HARMFUL_SOURCE`` → a ``jaillist_entries`` row (via the existing jaillist
  write path, so ``jail-ips.txt`` regenerates).
- ``NOT_HARMFUL`` → a whitelist pattern in ``url_patterns``.
- ``INCONCLUSIVE`` → nothing but the ledger row. Mandatory, never a no-op.

Nothing here writes a feed except through ``sync_regenerate`` /
``sync_regenerate_jail``, and only from this mutation route. No timer, no
threshold, no scheduler may call them (design §9 item 1).
"""

import json
from base64 import b64decode

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.config import get_settings, verify_admin
from app.database import get_db_conn
from app.models import TriageVerdictCreate
from app.services.blacklist import normalize_blacklist_value
from app.services.feeds import sync_regenerate, sync_regenerate_jail
from app.services.jaillist import normalize_jaillist_value
from app.services.timeutil import operator_tz, zone_label
from app.services.triage import (
    SUBJECT_KIND_DESTINATION,
    VERDICT_HARMFUL_DESTINATION,
    VERDICT_HARMFUL_SOURCE,
    VERDICT_INCONCLUSIVE,
    VERDICT_NOT_HARMFUL,
    effective_verdict,
    record_verdict,
    summarize_evidence,
    verdict_history,
)

router = APIRouter(prefix="/api/triage", tags=["triage"])


def _dumps(value) -> str:
    """JSON-serialize a mapping for storage, never ``None``."""
    try:
        return json.dumps(value)
    except (TypeError, ValueError):
        return "{}"



def _decided_by(authorization: str | None) -> str:
    """The authenticated admin identity, for ``triage_events.decided_by``.

    The app has no per-user account system: admin auth is a single shared
    Basic credential (or ``X-API-Key``/session token). The design's §4.4
    asserts the identity is "already available to every admin-gated route",
    but ``verify_admin`` returns ``None`` and no route receives it — so the
    only honest, non-fabricated author is the Basic Auth username that
    actually authenticated this request, falling back to the configured
    ``admin_user`` when the caller used the API key / session-token path.
    """
    if authorization and authorization.lower().startswith("basic "):
        try:
            raw = b64decode(authorization.split(" ", 1)[1]).decode("utf-8", "replace")
            username = raw.split(":", 1)[0].strip()
            if username:
                return username
        except (ValueError, UnicodeDecodeError):
            pass
    return get_settings().admin_user


async def _write_destination(db, payload, finding_id) -> dict:
    """Blacklist the destination via the EXISTING normalization path."""
    try:
        kind, value = normalize_blacklist_value(payload.subject)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    cursor = await db.execute(
        "INSERT OR IGNORE INTO blacklist_entries (kind, value, source, finding_id)"
        " VALUES (?, ?, 'finding', ?)",
        (kind, value, finding_id),
    )
    added = cursor.rowcount == 1
    if added:
        await sync_regenerate(db, (kind,))
    return {"kind": kind, "value": value, "added": added}


async def _write_source(db, payload, finding_id, *, reason, category, note,
                        decided_by, decided_at, evidence_summary, verdict_id) -> dict:
    """Jail the source via the EXISTING normalization path.

    Also populates the §7.1 findability columns on the jail entry, so the
    entry explains itself months later (design §3.3). ``finding_id`` is the
    evidence anchor the design notes is "never populated by any caller"
    today (§4.5) — this is the caller that closes the loop.
    """
    try:
        value = normalize_jaillist_value(payload.subject)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    cursor = await db.execute(
        "INSERT OR IGNORE INTO jaillist_entries"
        " (value, source, finding_id, reason, url, category, note,"
        "  evidence_summary, decided_by, decided_at, verdict_id)"
        " VALUES (?, 'finding', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            value,
            finding_id,
            reason or "",
            payload.url or "",
            category or "",
            note or "",
            evidence_summary,
            decided_by or "",
            decided_at or "",
            verdict_id,
        ),
    )
    added = cursor.rowcount == 1
    if added:
        await sync_regenerate_jail(db)
    else:
        # A jail entry for this value already exists (UNIQUE(value)). Still
        # record the new findability metadata so a correction is visible.
        await db.execute(
            "UPDATE jaillist_entries SET reason = ?, url = ?, category = ?,"
            " note = ?, evidence_summary = ?, decided_by = ?, decided_at = ?,"
            " verdict_id = ?, finding_id = ? WHERE value = ?",
            (
                reason or "",
                payload.url or "",
                category or "",
                note or "",
                evidence_summary,
                decided_by or "",
                decided_at or "",
                verdict_id,
                finding_id,
                value,
            ),
        )
    return {"value": value, "added": added}


async def _write_whitelist(db, payload) -> dict:
    """Write the whitelist pattern for NOT_HARMFUL, so future findings exclude
    this destination (whitelisted rows are excluded at ingest)."""
    pattern = (payload.subject or "").strip()
    if not pattern:
        raise HTTPException(status_code=400, detail="subject must not be empty")
    cursor = await db.execute(
        "INSERT OR IGNORE INTO url_patterns (pattern, pattern_type)"
        " VALUES (?, 'whitelist')",
        (pattern,),
    )
    return {"pattern": pattern, "created": cursor.rowcount == 1}


@router.post(
    "/verdict",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_admin)],
)
async def post_verdict(
    payload: TriageVerdictCreate,
    authorization: str | None = Header(default=None),
    db=Depends(get_db_conn),
):
    """Record one verdict, writing the artifact the verdict implies.

    Every path writes exactly one ``triage_events`` row. The artifact write
    and the ledger write share this request's connection; the ledger row is
    written FIRST so its id can be stamped onto the artifact (``verdict_id``).
    """
    subject = (payload.subject or "").strip()
    decided_by = _decided_by(authorization)
    decided_tz = zone_label(operator_tz())

    # Freeze the evidence at decision time (design §3.3): recomputing later
    # would yield a different number as the rolling window moves. An explicit
    # summary from the caller wins over the computed one.
    if payload.evidence_summary is not None:
        evidence_summary = payload.evidence_summary
    else:
        evidence_summary = await summarize_evidence(
            db, payload.subject_kind, subject
        )

    rule_ids = payload.rule_ids
    if rule_ids is None:
        rule_ids = evidence_summary.get("rule_ids", [])
    else:
        # Keep the frozen summary's rule_ids consistent with the ledger
        # column when the caller supplies them explicitly, so the stored
        # evidence is self-describing (design §3.3).
        evidence_summary = {**evidence_summary, "rule_ids": list(rule_ids)}

    # 1) The ledger row — one per decision, always. For HARMFUL_SOURCE and
    #    HARMFUL_DESTINATION we need the id before writing the artifact, so
    #    insert, then update the artifact with verdict_id once known.
    verdict_id = await record_verdict(
        db,
        subject_kind=payload.subject_kind,
        subject=subject,
        verdict=payload.verdict,
        finding_id=payload.finding_id,
        url=payload.url,
        category=payload.category,
        note=payload.note,
        rule_ids=rule_ids,
        evidence_summary=evidence_summary,
        decided_by=decided_by,
        decided_tz=decided_tz,
        supersedes_id=payload.supersedes_id,
    )

    # 2) The artifact the verdict implies.
    artifact: dict | None = None
    if payload.verdict == VERDICT_HARMFUL_DESTINATION:
        artifact = await _write_destination(db, payload, payload.finding_id)
    elif payload.verdict == VERDICT_HARMFUL_SOURCE:
        cursor = await db.execute(
            "SELECT decided_at FROM triage_events WHERE id = ?", (verdict_id,)
        )
        row = await cursor.fetchone()
        decided_at = row["decided_at"] if row else ""
        artifact = await _write_source(
            db,
            payload,
            payload.finding_id,
            reason=payload.note or payload.category,
            category=payload.category,
            note=payload.note,
            decided_by=decided_by,
            decided_at=decided_at,
            evidence_summary=_dumps(evidence_summary),
            verdict_id=verdict_id,
        )
    elif payload.verdict == VERDICT_NOT_HARMFUL:
        artifact = await _write_whitelist(db, payload)
    elif payload.verdict == VERDICT_INCONCLUSIVE:
        # No artifact — by design, and NOT a no-op error. The ledger row
        # above is the whole point: "a human looked and could not decide".
        artifact = None

    await db.commit()

    return {
        "verdict_id": verdict_id,
        "verdict": payload.verdict,
        "subject_kind": payload.subject_kind,
        "subject": subject,
        "decided_by": decided_by,
        "decided_tz": decided_tz,
        "rule_ids": rule_ids,
        "artifact": artifact,
    }


@router.get("/history", dependencies=[Depends(verify_admin)])
async def get_history(
    subject_kind: str = Query(..., pattern="^(destination|source)$"),
    subject: str = Query(..., min_length=1, max_length=500),
    db=Depends(get_db_conn),
):
    """The verdict chain plus the subject's block history (design §8 step 8).

    Reported as TWO separate facts so these three answers are distinguishable:
    "blocked with no events", "blocked with events", and "not blocked with
    events". ``blocked`` is current enforcement state; ``events`` is the
    historical record, which survives an unblock.
    """
    chain = await verdict_history(db, subject_kind, subject)
    current = await effective_verdict(db, subject_kind, subject)

    # Current enforcement / whitelist state for the subject.
    blocked = False
    whitelisted = False
    if subject_kind == SUBJECT_KIND_DESTINATION:
        cur = await db.execute(
            "SELECT 1 FROM blacklist_entries WHERE value = ? LIMIT 1", (subject,)
        )
        blocked = await cur.fetchone() is not None
        cur = await db.execute(
            "SELECT 1 FROM url_patterns WHERE pattern = ? AND pattern_type = 'whitelist'"
            " LIMIT 1",
            (subject,),
        )
        whitelisted = await cur.fetchone() is not None
    else:
        cur = await db.execute(
            "SELECT 1 FROM jaillist_entries WHERE value = ? LIMIT 1", (subject,)
        )
        blocked = await cur.fetchone() is not None

    return {
        "subject_kind": subject_kind,
        "subject": subject,
        "blocked": blocked,
        "whitelisted": whitelisted,
        "has_events": len(chain) > 0,
        "effective_verdict": current["verdict"] if current else None,
        "effective_verdict_id": current["id"] if current else None,
        "verdicts": chain,
    }
