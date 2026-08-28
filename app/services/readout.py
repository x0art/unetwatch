"""Ranked readout service — who hits what, ranked by risk.

Provides `get_ranked(minutes, limit, source, search)` with three sources:
- sqlite (default): group persisted findings by client, aggregate policy_classes
  from matched_patterns, compute risk_score. Fast, works with ES down.
- es: re-run block-pattern query live, group by client, compute risk_score.
- auto: sqlite first; fall back to es only when findings are empty.

Every response carries `source` and `es_online`; 200 on ES failure (never 5xx).
"""

import json
import os
import re
from contextlib import asynccontextmanager

import pandas as pd

from app.config import Settings, get_settings
from app.database import get_db
from app.services.es_client import build_es_client
from app.services.query_builder import build_client_session_query, build_logs_query, glob_to_regex
from app.services.result_processor import apply_filters


def _normalize_class_name(pattern: str) -> str:
    """Extract class name from pattern for weight lookup.

    Strips leading/trailing wildcards and non-alphanumeric chars.
    e.g., "*malware*" -> "malware", "malware" -> "malware",
    "*phishing-site*" -> "phishing-site"
    """
    # Strip leading/trailing * and ?
    name = pattern.strip("*?")
    # Replace remaining non-alphanumeric with hyphen
    name = re.sub(r"[^a-zA-Z0-9]+", "-", name)
    return name.lower()


def _get_risk_weights() -> dict[str, float]:
    """Load risk weights from env RISK_WEIGHT_<UPPERCASE_CLASS>, default 1.0."""
    settings = get_settings()
    weights: dict[str, float] = {}
    # Scan all env vars for RISK_WEIGHT_*
    for key, value in os.environ.items():
        if key.startswith("RISK_WEIGHT_"):
            class_name = key[len("RISK_WEIGHT_"):].lower()
            try:
                weights[class_name] = float(value)
            except ValueError:
                weights[class_name] = 1.0
    # Also check pydantic settings (for .env file)
    for field_name in Settings.model_fields:
        if field_name.startswith("risk_weight_"):
            class_name = field_name[len("risk_weight_"):]
            val = getattr(settings, field_name)
            if val is not None:
                weights[class_name] = float(val)
    return weights


@asynccontextmanager
async def _es_client_context(
    settings: Settings | None = None,
    *,
    timeout: float = 5,
    retry_on_timeout: bool = False,
    max_retries: int = 0,
):
    """Context manager that delegates to the (patchable) build_es_client."""
    if settings is None:
        settings = get_settings()
    client = build_es_client(
        settings,
        timeout=timeout,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
    )
    try:
        yield client
    finally:
        await client.close()


async def _sqlite_ranked(
    minutes: int,
    limit: int,
    search: str | None,
    risk_weights: dict[str, float],
) -> list[dict]:
    """Rank clients from persisted findings (sqlite)."""
    db = await get_db()
    try:
        where = ["client_ip != ''"]
        params: list = []
        if minutes:
            where.append(
                "log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
            )
            params.append(f"-{minutes} minutes")
        if search:
            where.append("(url LIKE ? OR base_url LIKE ? OR client_ip LIKE ?)")
            params.extend([f"%{search}%"] * 3)

        clause = f"WHERE {' AND '.join(where)}"

        # Fetch all relevant findings with matched_patterns
        cursor = await db.execute(
            f"""
            SELECT client_ip, server_ip, url, base_url, log_timestamp,
                   matched_patterns
            FROM findings
            {clause}
            """,
            params,
        )
        rows = await cursor.fetchall()
    finally:
        await db.close()

    if not rows:
        return []

    # Process in pandas for aggregation
    df = pd.DataFrame([dict(r) for r in rows])

    # Parse matched_patterns JSON
    def parse_patterns(val: str) -> list[str]:
        try:
            return json.loads(val) if val else []
        except (json.JSONDecodeError, TypeError):
            return []

    df["patterns"] = df["matched_patterns"].apply(parse_patterns)

    # Explode patterns to get one row per pattern match
    exploded = df.explode("patterns")
    exploded = exploded[exploded["patterns"].astype(bool)]

    if exploded.empty:
        return []

    # Aggregate by client
    grouped = exploded.groupby("client_ip").agg(
        total_hits=("patterns", "size"),
        last_seen=("log_timestamp", "max"),
        # Collect top URLs
        urls=("url", lambda s: s.value_counts().head(5).index.tolist()),
    ).reset_index()

    # Policy class counts per client
    policy_classes = (
        exploded.groupby(["client_ip", "patterns"])
        .size()
        .reset_index(name="count")
    )

    # Build policy_classes dict per client
    client_policies: dict[str, dict[str, int]] = {}
    for _, row in policy_classes.iterrows():
        client = row["client_ip"]
        label = row["patterns"]
        count = row["count"]
        if client not in client_policies:
            client_policies[client] = {}
        client_policies[client][label] = client_policies[client].get(label, 0) + count

    # Compute risk_score per client
    def compute_risk(policies: dict[str, int]) -> float:
        score = 0.0
        for label, count in policies.items():
            # Normalize label for weight lookup
            norm_label = _normalize_class_name(label)
            weight = risk_weights.get(norm_label, risk_weights.get(label, 1.0))
            score += count * weight
        return score

    results: list[dict] = []
    for _, row in grouped.iterrows():
        client = row["client_ip"]
        policies = client_policies.get(client, {})
        risk_score = compute_risk(policies)

        results.append(
            {
                "client": client,
                "risk_score": risk_score,
                "total_hits": int(row["total_hits"]),
                "policy_classes": policies,
                "top_urls": row["urls"],
                "last_seen": row["last_seen"],
                "href": f"/api/readout/client/{client}",
            }
        )

    # Sort by risk_score descending, then total_hits descending
    results.sort(key=lambda x: (-x["risk_score"], -x["total_hits"]))
    return results[:limit]


async def _es_ranked(
    minutes: int,
    limit: int,
    search: str | None,
    risk_weights: dict[str, float],
) -> tuple[list[dict], bool]:
    """Rank clients from live ES query."""
    settings = get_settings()

    # Get block patterns from DB
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT pattern FROM url_patterns WHERE pattern_type='block'"
        )
        block_patterns = [r[0] for r in await cursor.fetchall()]
    finally:
        await db.close()

    if not block_patterns:
        return [], False

    # Get whitelist patterns
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT pattern FROM url_patterns WHERE pattern_type='whitelist'"
        )
        whitelist_patterns = [r[0] for r in await cursor.fetchall()]
    finally:
        await db.close()

    whitelist_regex = ""
    if whitelist_patterns:
        from app.services.query_builder import build_pattern_regex

        whitelist_regex = build_pattern_regex(whitelist_patterns)

    # Build query with fields projection
    query = build_logs_query(
        block_patterns,
        minutes,
        settings.es_query_size,
        search=search,
        fields=[
            "@timestamp",
            "client_ip",
            "server_ip",
            "url",
            "base_url",
            "action",
            "duration_seconds",
        ],
    )

    hits = []
    try:
        async with _es_client_context(settings, timeout=30) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception:
                return [], False

        hits = res["hits"]["hits"]
    except Exception:
        return [], False

    if not hits:
        return [], True

    df = pd.DataFrame([h["_source"] for h in hits])
    df = apply_filters(df, whitelist_regex, exclude_whitelist=True, actions=("ALLOW",))

    if df.empty:
        return [], True

    # Annotate block patterns per URL
    from app.services.query_builder import glob_to_regex

    df["matched_patterns"] = [[] for _ in range(len(df))]
    for pattern in block_patterns:
        if not pattern.strip():
            continue
        regex = glob_to_regex(pattern)
        matched = df["url"].astype(str).str.contains(regex, case=False, na=False)
        for i in matched[matched].index:
            df.at[i, "matched_patterns"].append(pattern)

    # Explode patterns
    exploded = df.explode("matched_patterns")
    exploded = exploded[exploded["matched_patterns"].astype(bool)]

    if exploded.empty:
        return [], True

    # Aggregate by client_ip
    grouped = exploded.groupby("client_ip").agg(
        total_hits=("matched_patterns", "size"),
        last_seen=("@timestamp", "max"),
        urls=("url", lambda s: s.value_counts().head(5).index.tolist()),
    ).reset_index()

    # Policy class counts
    policy_classes = (
        exploded.groupby(["client_ip", "matched_patterns"])
        .size()
        .reset_index(name="count")
    )

    client_policies: dict[str, dict[str, int]] = {}
    for _, row in policy_classes.iterrows():
        client = row["client_ip"]
        label = row["matched_patterns"]
        count = row["count"]
        if client not in client_policies:
            client_policies[client] = {}
        client_policies[client][label] = client_policies[client].get(label, 0) + count

    # Compute risk_score
    def compute_risk(policies: dict[str, int]) -> float:
        score = 0.0
        for label, count in policies.items():
            # Normalize label for weight lookup
            norm_label = _normalize_class_name(label)
            weight = risk_weights.get(norm_label, risk_weights.get(label, 1.0))
            score += count * weight
        return score

    results: list[dict] = []
    for _, row in grouped.iterrows():
        client = row["client_ip"]
        policies = client_policies.get(client, {})
        risk_score = compute_risk(policies)

        results.append(
            {
                "client": client,
                "risk_score": risk_score,
                "total_hits": int(row["total_hits"]),
                "policy_classes": policies,
                "top_urls": row["urls"],
                "last_seen": row["last_seen"],
                "href": f"/api/readout/client/{client}",
            }
        )

    results.sort(key=lambda x: (-x["risk_score"], -x["total_hits"]))
    return results[:limit], True


async def get_ranked(
    minutes: int = 1440,
    limit: int = 50,
    source: str = "sqlite",
    search: str | None = None,
) -> dict:
    """Get ranked readout: clients ranked by risk.

    Args:
        minutes: Time window in minutes (default 1440 = 24h)
        limit: Max number of clients to return (default 50)
        source: "sqlite" | "es" | "auto" (default "sqlite")
        search: Optional substring to filter URLs/IPs

    Returns:
        Dict with items, source, es_online
    """
    risk_weights = _get_risk_weights()

    if source == "sqlite":
        items = await _sqlite_ranked(minutes, limit, search, risk_weights)
        return {
            "items": items,
            "source": "sqlite",
            "es_online": True,  # Not queried
        }

    if source == "es":
        items, es_online = await _es_ranked(minutes, limit, search, risk_weights)
        return {"items": items, "source": "es", "es_online": es_online}

    # source == "auto"
    items = await _sqlite_ranked(minutes, limit, search, risk_weights)
    if items:
        return {"items": items, "source": "sqlite", "es_online": True}

    # Fall back to ES
    items, es_online = await _es_ranked(minutes, limit, search, risk_weights)
    return {"items": items, "source": "es", "es_online": es_online}


async def get_client_timeline(
    client: str,
    minutes: int = 1440,
    limit: int = 200,
) -> dict:
    """Get per-client session timeline (drilldown).

    Dual-source: timeline from live ES (all requests in window, sorted @timestamp asc),
    persisted sub-object from SQLite (policy breakdown + hit count).

    ES down -> es_online:false, timeline:[], persisted still served (200).
    """
    settings = get_settings()

    # 1. Get persisted data from SQLite
    db = await get_db()
    try:
        where = ["client_ip = ?"]
        params: list = [client]
        if minutes:
            where.append(
                "log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
            )
            params.append(f"-{minutes} minutes")

        clause = f"WHERE {' AND '.join(where)}"

        cursor = await db.execute(
            f"""
            SELECT client_ip, server_ip, url, base_url, log_timestamp,
                   matched_patterns
            FROM findings
            {clause}
            """,
            params,
        )
        rows = await cursor.fetchall()
    finally:
        await db.close()

    # Build persisted policy breakdown
    persisted_hits = 0
    persisted_policy_classes: dict[str, int] = {}
    if rows:
        df = pd.DataFrame([dict(r) for r in rows])

        def parse_patterns(val: str) -> list[str]:
            try:
                return json.loads(val) if val else []
            except (json.JSONDecodeError, TypeError):
                return []

        df["patterns"] = df["matched_patterns"].apply(parse_patterns)
        exploded = df.explode("patterns")
        exploded = exploded[exploded["patterns"].astype(bool)]
        if not exploded.empty:
            persisted_hits = len(exploded)
            policy_classes = (
                exploded.groupby(["patterns"]).size().reset_index(name="count")
            )
            for _, row in policy_classes.iterrows():
                persisted_policy_classes[row["patterns"]] = int(row["count"])

    persisted = {
        "policy_classes": persisted_policy_classes,
        "hit_count": persisted_hits,
    }

    # 2. Get timeline from live ES
    query = build_client_session_query(client, minutes, limit)

    es_online = True
    timeline: list[dict] = []
    try:
        async with _es_client_context(settings, timeout=30) as es:
            try:
                res = await es.search(index=settings.elastic_index, body=query)
            except Exception:
                es_online = False
                return {"timeline": [], "persisted": persisted, "es_online": False}

        hits = res["hits"]["hits"]
        for h in hits:
            src = h["_source"]
            timeline.append(
                {
                    "@timestamp": src.get("@timestamp", ""),
                    "client_ip": src.get("client_ip", ""),
                    "server_ip": src.get("server_ip", ""),
                    "url": src.get("url", ""),
                    "base_url": src.get("base_url", ""),
                    "action": src.get("action", ""),
                    "duration_seconds": src.get("duration_seconds"),
                }
            )
    except Exception:
        es_online = False

    return {"timeline": timeline, "persisted": persisted, "es_online": es_online}


async def get_policy_classes(minutes: int = 1440) -> dict:
    """Get overall policy class breakdown across all clients .

    Primary source: persisted `matched_patterns` from findings (Schema S1).
    Fallback when SQLite empty: re-match URLs against current block patterns
    using `glob_to_regex` + pattern from `result_processor.py:207-216`.

    Returns: {classes: {label: count}, total_hits, es_online: true}
    """
    db = await get_db()
    try:
        where = ["client_ip != ''"]
        params: list = []
        if minutes:
            where.append(
                "log_timestamp >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)"
            )
            params.append(f"-{minutes} minutes")

        clause = f"WHERE {' AND '.join(where)}"

        cursor = await db.execute(
            f"""
            SELECT matched_patterns, url
            FROM findings
            {clause}
            """,
            params,
        )
        rows = await cursor.fetchall()
    finally:
        await db.close()

    classes: dict[str, int] = {}
    total_hits = 0

    if rows:
        # Primary: aggregate from persisted matched_patterns
        for row in rows:
            patterns = row["matched_patterns"]
            if patterns:
                try:
                    parsed = json.loads(patterns)
                    for p in parsed:
                        if p:
                            classes[p] = classes.get(p, 0) + 1
                            total_hits += 1
                except (json.JSONDecodeError, TypeError):
                    pass

    # Fallback: if no matched_patterns found, re-match URLs against current block patterns
    if not classes:
        # Get current block patterns from DB
        db = await get_db()
        try:
            cursor = await db.execute(
                "SELECT pattern FROM url_patterns WHERE pattern_type='block'"
            )
            block_patterns = [r[0] for r in await cursor.fetchall()]
        finally:
            await db.close()

        if block_patterns and rows:
            # Re-match URLs against current block patterns (result_processor.py:207-216 pattern)
            url_to_patterns: dict[str, list[str]] = {}
            for pattern in block_patterns:
                if not pattern.strip():
                    continue
                regex = glob_to_regex(pattern)
                for row in rows:
                    url = str(row["url"] or "")
                    if re.search(regex, url, re.IGNORECASE):
                        if url not in url_to_patterns:
                            url_to_patterns[url] = []
                        url_to_patterns[url].append(pattern)

            # Count each match
            for patterns in url_to_patterns.values():
                for p in patterns:
                    classes[p] = classes.get(p, 0) + 1
                    total_hits += 1

    return {"classes": classes, "total_hits": total_hits, "es_online": True}


async def get_risk_explain() -> dict:
    """Read-only explain of risk scoring formula and default weights .

    Returns the formula and weights for transparency.
    """
    weights = _get_risk_weights()
    return {
        "formula": "risk_score = SUM(hits_in_class * weight_class)",
        "weights": weights or {"(default)": 1.0},
        "env_prefix": "RISK_WEIGHT_",
        "notes": (
            "Weights are loaded from env RISK_WEIGHT_<UPPERCASE_CLASS> or "
            "Settings risk_weight_<class>. Default is 1.0 per class."
        ),
    }


