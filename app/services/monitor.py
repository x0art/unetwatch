from datetime import UTC, datetime

import pandas as pd
from elasticsearch import AsyncElasticsearch

from app.config import get_settings


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


async def fetch_logs():
    settings = get_settings()
    es = AsyncElasticsearch(
        [settings.elastic_host],
        basic_auth=(settings.elastic_user, settings.elastic_pass),
        verify_certs=False,
        request_timeout=180,
        retry_on_timeout=True,
        max_retries=3,
    )

    from app.database import get_db

    db = await get_db()
    try:
        block_patterns = await get_block_patterns(db)
        whitelist_patterns = await get_whitelist_patterns(db)
    finally:
        await db.close()

    if not block_patterns:
        print(f"[{datetime.now(UTC).isoformat()}][INFO] No block patterns configured.")
        await es.close()
        return

    query_string = " OR ".join([f"url : {p}" for p in block_patterns])
    whitelist_regex = "|".join(whitelist_patterns)

    query = {
        "size": settings.es_query_size,
        "query": {
            "bool": {
                "filter": [{"range": {"@timestamp": {"gte": "now-10m", "lte": "now"}}}],
                "must": [
                    {"query_string": {"query": query_string, "analyze_wildcard": True}}
                ],
            }
        },
    }

    try:
        res = await es.search(index=settings.elastic_index, body=query)
        hits = res["hits"]["hits"]

        if not hits:
            print(f"[{datetime.now(UTC).isoformat()}][INFO] No matches found.")
            return

        raw_docs = [hit["_source"] for hit in hits]
        df = pd.DataFrame(raw_docs)
        df["base_url"] = df["url"].astype(str).apply(
            lambda x: x.split("/")[2].split("/")[0]
        )

        if whitelist_regex:
            df = df[~df["url"].str.contains(whitelist_regex, case=False)]
        df = df[df["action"] == "ALLOW"]

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

        await send_logs(settings.webhook_url, total_sum, payload)

    except Exception as e:
        print(f"Error: {e}")
    finally:
        await es.close()


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
