"""DataFrame filtering, aggregation, and result-building utilities.

Pure functions that transform ES hit DataFrames into UI-ready payloads.
Extracted from ``monitor.py`` to create a deep module with clear testability:
every function takes a DataFrame and returns a dict/list, with zero I/O.
"""

import json
import math
import re
from datetime import UTC, datetime
from numbers import Integral, Real

import pandas as pd

from app.services.es_fields import mode_has_extended_findings
from app.services.query_builder import glob_to_regex

# ── ADR 0001 row semantics (canonical) ─────────────────────────────────────
#
# The product's definition of risk, stated once. Every consumer that decides
# whether a persisted ``findings`` row is a risk or an enforcement calls these
# two helpers — ``app/routes/analytics.py``, ``app/routes/client_report.py``
# and the persisted-findings fallback in ``app/routes/hosts.py``. They live in
# this service (not in a route module) because they are a domain rule, not an
# endpoint concern, and they sit beside ``intent_for_action`` below: the two
# together classify ALL findings rows — these by the ADR 0001 risk/enforcement
# rule, ``intent_for_action`` by the display intent (REACH/ATTEMPT).
#
# ``_parse_matched_patterns`` is the permissive JSON reader the legacy branch
# needs; it lives here so a route never has to import analytics to classify a
# row.


def _parse_matched_patterns(raw) -> list:
    """Safely parse the stored ``matched_patterns`` JSON column.

    A corrupted or non-JSON row must never 500 an endpoint — a garbage row is
    treated as an empty match list.
    """
    try:
        return json.loads(raw) if raw else []
    except (json.JSONDecodeError, TypeError):
        return []


def _row_is_enforced(row: dict, has_action: bool) -> bool:
    """Whether a row is an enforcement — the proxy already denied it (ADR 0001).

    Only an explicit ``DENY``/``FLAG`` action counts. Legacy rows with an empty
    ``action`` were persisted as ALLOW risks, so they are never enforcements
    even when ``matched_patterns`` is non-empty.
    """
    action = (row.get("action") or "").strip().upper()
    if has_action and action:
        return action in ("DENY", "FLAG")
    return False


def _row_is_risk(row: dict, has_action: bool) -> bool:
    """Whether a row is a risk — pattern match + ALLOW + not whitelisted (ADR 0001).

    Enforcements are never risks. An explicit ``ALLOW`` is a risk; a legacy row
    with an empty ``action`` but a non-empty ``matched_patterns`` was stored as
    an ALLOW risk, so it counts too.
    """
    if _row_is_enforced(row, has_action):
        return False
    action = (row.get("action") or "").strip().upper()
    if has_action and action:
        return action == "ALLOW"
    return bool(_parse_matched_patterns(row.get("matched_patterns")))


# Back-compat alias — older callers import this name for the enforcement test.
_row_is_blocked = _row_is_enforced


# ── Destination host + persisted byte counters (canonical) ─────────────────
#
# Single home for the three helpers that `analytics.py` and `client_report.py`
# each used to carry a copy of. They are domain concerns (what a `base_url`
# denotes, what a persisted byte column means), not endpoint concerns.


def _domain_of_base(base_url: str) -> str:
    """Best-effort hostname: strip scheme, port and path; keep the authority.

    The trailing ``:port`` is removed so ``a.example`` and ``a.example:443``
    aggregate into the same bucket — and so a ported destination still matches
    the blacklist, whose entries are bare hosts (``app/services/blacklist.py``).
    The ``www.`` prefix is deliberately NOT stripped: it is part of the
    authority, and dropping it would reshape displayed aggregates. An empty or
    unparseable input collapses to ``"unknown"`` rather than an empty bucket.
    """
    m = re.match(r"^(?:https?://)?([^/]+)", base_url or "")
    host = m.group(1) if m else (base_url or "unknown")
    host = re.sub(r":\d+$", "", host)
    return host or "unknown"


def _persisted_bytes(value) -> int | None:
    """The persisted byte figure for one row, or ``None`` when not recorded.

    ``None`` and ``""`` are NOT-RECORDED (absent), and are deliberately
    distinct from a stored ``0``: the flat ``bytes_downloaded`` column
    collapses the raw line's ``-`` sentinel to ``0``, so a ``0`` must never be
    *shown* as a confident measured zero — but it is still a persisted value
    and must not be replaced by an estimate.
    """
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _volume_for_bytes(rows: list[dict]) -> int | None:
    """SUM the persisted byte counters — never a proxy, or ``None``.

    Returns the summed ``bytes_downloaded`` + ``bytes_uploaded`` when at least
    one row carried a byte counter, and ``None`` when no row did. There is no
    duration or per-request fallback: a fabricated total that happened to
    preserve the ranking order would still be a fabricated absolute figure, so
    an unknown volume is reported as unavailable rather than estimated
    (CONTEXT.md, *No synthesized measurements*). Callers surface ``None`` as
    an explicit unavailable marker.
    """
    total = 0
    seen = False
    for r in rows:
        dn = _persisted_bytes(r.get("bytes_downloaded"))
        up = _persisted_bytes(r.get("bytes_uploaded"))
        if dn is None and up is None:
            continue
        seen = True
        total += (dn or 0) + (up or 0)
    return total if seen else None


def normalize_timestamp(ts, fallback: str) -> str:
    """Return a usable ISO-8601 timestamp for a finding.

    The ES ``@timestamp`` is the source of truth; ``fallback`` (the poll
    time) is only used when the document has no usable value. Handles ISO
    strings, datetime/pandas Timestamp objects, numeric epoch values
    (seconds/milliseconds) and missing markers (None, NaN, NaT, empty
    string) so a log entry can never be stored with a blank or "NaT" time.
    """
    if ts is None:
        return fallback
    if isinstance(ts, str):
        ts = ts.strip()
        return ts or fallback
    try:
        if bool(pd.isna(ts)):
            return fallback
    except (TypeError, ValueError):
        pass
    # numbers.Integral/Real also catch numpy scalar types (np.int64, np.float64).
    if isinstance(ts, (Integral, Real)):
        try:
            if not math.isfinite(float(ts)):
                return fallback
            if ts > 1e12:  # epoch milliseconds
                return datetime.fromtimestamp(ts / 1000, UTC).isoformat()
            if ts > 1e9:  # epoch seconds
                return datetime.fromtimestamp(ts, UTC).isoformat()
        except (TypeError, ValueError, OverflowError):
            return fallback
    if isinstance(ts, datetime):
        return ts.isoformat()
    rendered = str(ts).strip()
    return rendered or fallback


def safe_number(value) -> float | None:
    """Coerce a pandas/ES value to a float, or None when it is missing/NaN."""
    if value is None:
        return None
    try:
        if bool(pd.isna(value)):
            return None
    except (TypeError, ValueError):
        pass
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def apply_filters(
    df: pd.DataFrame,
    whitelist_regex: str,
    *,
    exclude_whitelist: bool = True,
    actions: tuple[str, ...] | None = ("ALLOW",),
) -> pd.DataFrame:
    """Apply whitelist + action filters and derive base_url.

    Missing columns are tolerated (filled with empty strings) so a single odd
    document can never crash a whole poll. ``exclude_whitelist=False`` keeps
    whitelisted matches so the Query page can badge them in the UI instead of
    silently dropping them. ``actions`` restricts to the given actions
    (default ALLOW-only, which the findings/webhook flow relies on); pass
    ``actions=None`` to keep every row regardless of action.
    """
    df = df.copy()
    for col in (
    "url",
    "client_ip",
    "action",
    "@timestamp",
    "matched_patterns",
    "user_agent",
    "duration_seconds",
    # Rich flat proxy fields — default-filled so a doc missing one never
    # crashes store_findings/build_items (df[col] on a missing column raises).
    "domain",
    "category",
    "http_method",
    "http_status_code",
    "country_code",
    "bytes_downloaded",
    "bytes_uploaded",
    "rule_info",
    "rule_name",
    "user_id",
):
        if col not in df.columns:
            df[col] = ""
    # Vectorized base_url extraction — equivalent to the old per-row
    # ``parts = url.split("/"); parts[2] if len(parts) >= 3 else url``
    # (a split with no limit keeps the host in position 2; URLs without a
    # third segment — no scheme, bare host, empty — fall back to the url).
    # The trailing :port is stripped so base_url matches the blacklist sets
    # (normalized to bare hosts) consistently across badge/exclusion/count paths.
    urls = df["url"].astype(str)
    df["base_url"] = urls.str.split("/").str[2].fillna(urls).str.replace(
        r":\d+$", "", regex=True
    )
    if whitelist_regex and exclude_whitelist:
        df = df[~df["url"].astype(str).str.contains(whitelist_regex, case=False)]
    if actions is not None:
        df = df[df["action"].isin(actions)]
    return df


def intent_for_action(action: str) -> str:
    """Derive the intent class of an evidence row from its proxy action.

    REACH  — ``ALLOW``: the client reached a prohibited destination.
    ATTEMPT — ``DENY``: the proxy blocked the attempt (the client's intent).
    ""     — anything else (``FLAG``, empty, None, unknown future values).
    """
    if action == "ALLOW":
        return "REACH"
    if action == "DENY":
        return "ATTEMPT"
    return ""


async def store_findings(db, df: pd.DataFrame, matched_patterns: list[str] | None = None) -> int:
    """Persist filtered matches so they surface in the Findings page.

    Uses INSERT OR IGNORE + a UNIQUE(client_ip, url, log_timestamp) constraint so
    overlapping poll windows never create duplicate rows. Returns the number of
    rows actually inserted.

    ``action``/``duration_seconds`` and the rich flat proxy fields (domain,
    category, http_method, http_status_code, country_code, bytes_*, rule_*,
    user_id) are always written — the flat logstash-proxy index carries them.
    ``user_agent`` remains mode-gated (UC-A/UC-B only).

    ``intent`` is derived from ``action`` via :func:`intent_for_action` and
    written alongside it: REACH for ALLOW, ATTEMPT for DENY, "" otherwise.
    Legacy rows predating the column keep the DB default "" — that is
    intentional and requires no backfill, since the value is a pure function
    of ``action`` (which is likewise "" for those same legacy rows).
    """
    rows = []
    now = datetime.now(UTC).isoformat()
    # Guard every column we read — a DataFrame built directly from ES hits
    # (bypassing apply_filters) may be missing server_ip or the rich flat
    # proxy fields, and df[col].itertuples raises KeyError on a missing one.
    # Numeric columns default to 0; text columns to "" (apply_filters fills
    # duration_seconds as "", so coercion below must tolerate both).
    for _col in (
        "client_ip", "server_ip", "url", "base_url", "@timestamp",
        "domain", "category", "http_method", "http_status_code",
        "country_code", "bytes_downloaded", "bytes_uploaded",
        "rule_info", "rule_name", "user_id",
        "action", "duration_seconds", "user_agent", "intent",
    ):
        if _col not in df.columns:
            df[_col] = 0 if _col == "duration_seconds" else ""
    matched_json = json.dumps(matched_patterns or [])

    # Check if extended findings columns exist in DB (UC-A/UC-B mode)
    extended = mode_has_extended_findings()

    # Base columns (always present) - DataFrame column names. The rich flat
    # proxy fields ride along so Query/Findings/Host/Analytics can surface
    # them (migration in database.py adds the columns idempotently).
    base_cols = [
        "client_ip", "server_ip", "url", "base_url", "@timestamp",
        "domain", "category", "http_method", "http_status_code",
        "country_code", "bytes_downloaded", "bytes_uploaded",
        "rule_info", "rule_name", "user_id",
    ]
    # Database column names (log_timestamp instead of @timestamp, plus matched_patterns)
    db_base_cols = [
        "client_ip",
        "server_ip",
        "url",
        "base_url",
        "log_timestamp",
        "matched_patterns",
    ] + [
        "domain", "category", "http_method", "http_status_code",
        "country_code", "bytes_downloaded", "bytes_uploaded",
        "rule_info", "rule_name", "user_id",
    ] + [
        # action + duration_seconds are persisted unconditionally now — the
        # flat logstash-proxy index carries both, and COLLAPSED mode previously
        # dropped them (starving analytics). database.py ALTERs the columns in.
        "action",
        "duration_seconds",
    ]
    # Extended column (only in UC-A/UC-B) — user_agent remains mode-gated.
    ext_cols = ["user_agent"] if extended else []

    # Derived intent column — persisted for both ALLOW (REACH) and DENY
    # (ATTEMPT) rows; "" only for legacy rows and non-ALLOW/DENY actions.
    df["intent"] = df["action"].astype(str).map(intent_for_action)
    all_cols = db_base_cols + ext_cols + ["intent"]
    placeholders = ", ".join(["?"] * len(all_cols))
    col_names = ", ".join(all_cols)

    # Iterate over base columns, use df.iloc[i].get for extra columns with defaults
    for i, r in enumerate(df[base_cols].itertuples(index=False, name=None)):
        vals = [
            str(r[0] or ""),
            str(r[1] or ""),
            str(r[2] or ""),
            str(r[3] or ""),
            normalize_timestamp(r[4], now),
            matched_json,
        ]
        # Rich flat proxy fields (positions 5..14 of base_cols)
        for j in range(5, len(base_cols)):
            vals.append(str(r[j] if r[j] is not None else ""))
        # action + duration_seconds — always persisted from the flat index.
        vals.append(str(df.iloc[i].get("action", "")) if "action" in df.columns else "")
        dur = df.iloc[i].get("duration_seconds") if "duration_seconds" in df.columns else None
        try:
            dur_int = int(dur) if dur not in (None, "") else 0
        except (TypeError, ValueError):
            dur_int = 0
        vals.append(dur_int)
        if extended:
            # user_agent defaults to ""
            vals.append(str(df.iloc[i].get("user_agent", "")) if "user_agent" in df.columns else "")
        vals.append(str(df.iloc[i].get("intent", "")))
        rows.append(tuple(vals))

    if not rows:
        return 0
    cursor = await db.executemany(
        f"INSERT OR IGNORE INTO findings ({col_names}) VALUES ({placeholders})",
        rows,
    )
    await db.commit()
    return int(cursor.rowcount or 0)


def build_timeline(df: pd.DataFrame, minutes: int) -> list[dict]:
    """Bucket matching docs into a continuous minute-granularity timeline.

    Bucket width is scaled to the window so long windows (e.g. 24h) still
    render a reasonable number of points (~48 max).
    """
    ts = pd.to_datetime(df["@timestamp"], errors="coerce", utc=True).dropna()
    if ts.empty:
        return []
    if minutes <= 0:
        # All-time window: bucket from the data's own span instead of a
        # fixed minute window, keeping ~48 buckets.
        span_min = (ts.max() - ts.min()).total_seconds() / 60
        span = max(1, int(span_min) // 48)
    else:
        span = max(1, minutes // 48)
    binned = ts.dt.floor(f"{span}min")
    counts = binned.value_counts().sort_index()
    if counts.empty:
        return []
    full = pd.date_range(counts.index.min(), counts.index.max(), freq=f"{span}min")
    counts = counts.reindex(full, fill_value=0)
    return [
        {"bucket": idx.isoformat(), "count": int(c)} for idx, c in counts.items()
    ]


def build_flow(df: pd.DataFrame) -> dict:
    """Collapse docs into a client_ip → base_url flow for visualization."""
    grouped = (
        df.groupby(["client_ip", "base_url"]).size().reset_index(name="count")
    )
    nodes: list[dict] = []
    for ip in grouped["client_ip"].unique():
        nodes.append({"id": f"ip:{ip}", "label": str(ip), "kind": "ip"})
    for base in grouped["base_url"].unique():
        nodes.append({"id": f"base:{base}", "label": str(base), "kind": "base"})
    links = [
        {
            "source": f"ip:{row.client_ip}",
            "target": f"base:{row.base_url}",
            "count": int(row.count),
        }
        for row in grouped.itertuples()
    ]
    return {"nodes": nodes, "links": links}


def build_items(
    df: pd.DataFrame,
    limit: int,
    *,
    block_patterns: list[str],
    whitelist_regex: str,
    blacklist_urls: set[str],
    blacklist_ips: set[str],
) -> list[dict]:
    """Rows for the Query page table (capped to ``limit``).

    Each row is annotated for the UI badges: which block pattern(s) matched
    (``blocked_by``), whether the URL matches a whitelist pattern
    (``whitelisted``), and whether its destination host (``base_url``) is
    already on the blacklist (``blacklisted`` / ``blacklist_source``).
    """
    now = datetime.now(UTC).isoformat()
    whitelist_matcher = (
        re.compile(whitelist_regex, re.IGNORECASE) if whitelist_regex else None
    )

    df = df.head(limit)
    records = df.to_dict("records")
    # Vectorized block-pattern annotation: one regex pass per pattern across
    # the whole batch instead of a per-row re.search per pattern. Indices are
    # positional (reset_index) so they line up with the records list.
    url_series = df["url"].astype(str).reset_index(drop=True)
    block_hits: list[list[str]] = [[] for _ in range(len(records))]
    for pattern in block_patterns:
        if not pattern.strip():
            continue
        matched = url_series.str.contains(
            glob_to_regex(pattern), regex=True, case=False, na=False
        )
        for i in matched[matched].index:
            block_hits[i].append(pattern)

    items: list[dict] = []
    for i, row in enumerate(records):
        url = str(row.get("url") or "")
        base_url = str(row.get("base_url") or "")
        client_ip = str(row.get("client_ip") or "")

        blocked_by = block_hits[i]
        whitelisted = bool(whitelist_matcher and whitelist_matcher.search(url))

        # A base_url can itself be an IP address, so it must be matched
        # against the IP list too — otherwise IP-based entries never get
        # the blacklist badge even when the address is on the blacklist.
        blacklisted = base_url in blacklist_urls or base_url in blacklist_ips
        blacklist_source = (
            "url" if base_url in blacklist_urls
            else "ip" if base_url in blacklist_ips
            else None
        )

        # Rich flat proxy fields ride along so the Query/Host tables can surface
        # category, method, status, country, bytes and rule. bytes_* stay numeric
        # so the frontend can sum them for real bandwidth.
        rich: dict = {
            key: (str(row.get(key) or "") if row.get(key) is not None else "")
            for key in (
                "domain",
                "category",
                "http_method",
                "http_status_code",
                "country_code",
                "rule_info",
                "rule_name",
                "user_id",
            )
        }
        rich["bytes_downloaded"] = safe_number(row.get("bytes_downloaded"))
        rich["bytes_uploaded"] = safe_number(row.get("bytes_uploaded"))
        items.append(
            {
                "timestamp": normalize_timestamp(row.get("@timestamp"), now),
                "client_ip": client_ip,
                "server_ip": str(row.get("server_ip") or ""),
                "url": url,
                "base_url": base_url,
                "duration_seconds": safe_number(row.get("duration_seconds")),
                "action": str(row.get("action") or ""),
                "blocked_by": blocked_by,
                "whitelisted": whitelisted,
                "blacklisted": blacklisted,
                "blacklist_source": blacklist_source,
                **rich,
            }
        )
    return items
