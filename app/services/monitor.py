from datetime import UTC, datetime

import pandas as pd
from elasticsearch import AsyncElasticsearch

from app.config import get_settings


def build_es_client(
    settings,
    *,
    timeout: float = 5,
    retry_on_timeout: bool = False,
    max_retries: int = 0,
) -> AsyncElasticsearch:
    """Shared Elasticsearch client factory (short timeouts by default)."""
    return AsyncElasticsearch(
        [settings.elastic_host],
        basic_auth=(settings.elastic_user, settings.elastic_pass),
        verify_certs=False,
        request_timeout=timeout,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
    )


async def is_es_online() -> bool:
    """True when Elasticsearch answers a ping within a short timeout."""
    settings = get_settings()
    es = build_es_client(settings)
    try:
        return await es.ping()
    except Exception:
        return False
    finally:
        await es.close()


async def get_block_patterns(db) -> list[str]:
    cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type='block'"
    )
    rows = await cursor.fetchall()
    return [r[0] for r in rows]


async def get_whitelist_patterns(db) -> list[str]:
    cursor = await db.execute(
        "SELECT pattern FROM url_patterns WHERE pattern_type='whitelist'"
    )
    rows = await cursor.fetchall()
    return [r[0] for r in rows]


def build_logs_query(block_patterns: list[str], minutes: int, size: int) -> dict:
    """ES query that flags URLs matching any block pattern within the window."""
    query_string = " OR ".join([f"url : {p}" for p in block_patterns])
    return {
        "size": size,
        "query": {
            "bool": {
                "filter": [
                    {"range": {"@timestamp": {"gte": f"now-{minutes}m", "lte": "now"}}}
                ],
                "must": [
                    {"query_string": {"query": query_string, "analyze_wildcard": True}}
                ],
            }
        },
    }


def _extract_base_url(url: str) -> str:
    parts = str(url).split("/")
    if len(parts) < 3:
        return str(url)
    return parts[2]


def apply_filters(df: pd.DataFrame, whitelist_regex: str) -> pd.DataFrame:
    """Apply whitelist + ALLOW filters and derive base_url.

    Missing columns are tolerated (filled with empty strings) so a single odd
    document can never crash a whole poll.
    """
    df = df.copy()
    for col in ("url", "client_ip", "action", "@timestamp"):
        if col not in df.columns:
            df[col] = ""
    df["base_url"] = df["url"].astype(str).apply(_extract_base_url)
    if whitelist_regex:
        df = df[~df["url"].astype(str).str.contains(whitelist_regex, case=False)]
    return df[df["action"] == "ALLOW"]


async def store_findings(db, df: pd.DataFrame):
    """Persist filtered matches so they surface in the Findings page.

    Uses INSERT OR IGNORE + a UNIQUE(client_ip, url, log_timestamp) constraint so
    overlapping poll windows never create duplicate rows.
    """
    rows = []
    now = datetime.now(UTC).isoformat()
    for _, row in df.iterrows():
        ts = row.get("@timestamp")
        if ts is None or (isinstance(ts, float) and pd.isna(ts)):
            ts = now
        rows.append(
            (
                str(row.get("client_ip") or ""),
                str(row.get("url") or ""),
                str(row.get("base_url") or ""),
                str(ts),
            )
        )
    if not rows:
        return
    await db.executemany(
        "INSERT OR IGNORE INTO findings (client_ip, url, base_url, log_timestamp)"
        " VALUES (?, ?, ?, ?)",
        rows,
    )
    await db.commit()


async def fetch_logs(minutes: int = 10):
    settings = get_settings()
    es = build_es_client(
        settings, timeout=180, retry_on_timeout=True, max_retries=3
    )

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)

        if not block_patterns:
            print(f"[{datetime.now(UTC).isoformat()}][INFO] No block patterns configured.")
            return

        whitelist_regex = "|".join(whitelist_patterns)
        query = build_logs_query(block_patterns, minutes, settings.es_query_size)

        try:
            res = await es.search(index=settings.elastic_index, body=query)
        except Exception as e:
            print(f"Error: {e}")
            return

        hits = res["hits"]["hits"]

        if not hits:
            print(f"[{datetime.now(UTC).isoformat()}][INFO] No matches found.")
            return

        df = apply_filters(pd.DataFrame([h["_source"] for h in hits]), whitelist_regex)

        if df.empty:
            print(f"[{datetime.now(UTC).isoformat()}][INFO] No filtered matches.")
            return

        required_columns = [
            "@timestamp", "client_ip", "server_ip", "url",
            "duration_seconds", "action",
        ]
        df_filtered = df[required_columns]
        model_groupby_ip = (
            df.groupby("client_ip")[["url", "base_url"]].agg(list).reset_index()
        )
        model_groupby_ip["base_url"] = (
            model_groupby_ip["base_url"].apply(set).apply(list)
        )
        result = model_groupby_ip.apply(
            lambda row: {
                "client_ip": row["client_ip"],
                "url": row["url"],
                "base_url": row["base_url"],
            },
            axis=1,
        ).tolist()

        total_sum = len(df_filtered)
        documents_len = len(model_groupby_ip)

        payload = {
            "summary": {
                "total_matches": total_sum,
                "timestamp_utc": datetime.now(UTC).isoformat(),
            },
            "total_documents": documents_len,
            "documents": result,
        }

        # Persist locally before webhook delivery; storage failures must never
        # break alert delivery, so this is best-effort.
        try:
            await store_findings(db, df)
        except Exception as e:
            print(f"[{datetime.now(UTC).isoformat()}][WARN] Failed to store findings: {e}")

        await send_logs(settings.webhook_url, total_sum, payload)

    except Exception as e:
        print(f"Error: {e}")
    finally:
        await es.close()
        await db.close()


async def fetch_metrics(minutes: int = 60) -> dict:
    """Aggregate flagged URL traffic from ES for the dashboard metrics charts.

    Applies the same block-pattern + whitelist + ALLOW filter as fetch_logs().
    Elasticsearch being unreachable (or returning unexpected documents) degrades
    gracefully — the endpoint never 500s.
    """
    settings = get_settings()

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
    finally:
        await db.close()

    result = {
        "window_minutes": minutes,
        "es_online": True,
        "total_requests": 0,
        "unique_ips": 0,
        "top_urls": [],
        "top_ips": [],
    }

    if not block_patterns:
        return result

    es = build_es_client(settings, timeout=15)
    whitelist_regex = "|".join(whitelist_patterns)
    query = build_logs_query(block_patterns, minutes, settings.es_query_size)

    try:
        res = await es.search(index=settings.elastic_index, body=query)
    except Exception:
        result["es_online"] = False
        return result
    finally:
        await es.close()

    try:
        hits = res["hits"]["hits"]
        if not hits:
            return result

        df = apply_filters(pd.DataFrame([h["_source"] for h in hits]), whitelist_regex)
        if df.empty:
            return result

        result["total_requests"] = int(len(df))
        result["unique_ips"] = int(df["client_ip"].nunique())
        top_urls = df["url"].astype(str).value_counts().head(10)
        top_ips = df["client_ip"].astype(str).value_counts().head(10)
        result["top_urls"] = [
            {"url": url, "count": int(count)} for url, count in top_urls.items()
        ]
        result["top_ips"] = [
            {"client_ip": ip, "count": int(count)} for ip, count in top_ips.items()
        ]
    except Exception as e:
        print(f"[{datetime.now(UTC).isoformat()}][WARN] Metrics aggregation failed: {e}")
    return result


async def send_logs(webhook_url: str, n_item: int, payload: dict):
    import aiohttp

    async with aiohttp.ClientSession() as session:
        async with session.post(webhook_url, json=payload, timeout=15) as response:
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] Found {n_item} rows."
            )
            result_msg = (
                "Success on"
                if response.status == 200
                else f"Error {response.status} while"
            )
            print(
                f"[{datetime.now(UTC).isoformat()}][INFO] "
                f"{result_msg} sending."
            )
