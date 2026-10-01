"""Elasticsearch client factory and health check.

Provides a shared client builder and an async context manager for
connection lifecycle management. Extracted from ``monitor.py`` to
centralize ES connection concerns.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from elasticsearch import AsyncElasticsearch

from app.config import Settings, get_settings


def build_es_client(
    settings: Settings | None = None,
    *,
    timeout: float = 5,
    retry_on_timeout: bool = False,
    max_retries: int = 0,
) -> AsyncElasticsearch:
    """Shared Elasticsearch client factory (short timeouts by default)."""
    if settings is None:
        settings = get_settings()
    return AsyncElasticsearch(
        [settings.elastic_host],
        basic_auth=(settings.elastic_user, settings.elastic_pass),
        verify_certs=False,
        request_timeout=timeout,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
    )


@asynccontextmanager
async def es_client(
    settings: Settings | None = None,
    *,
    timeout: float = 5,
    retry_on_timeout: bool = False,
    max_retries: int = 0,
) -> AsyncIterator[AsyncElasticsearch]:
    """Async context manager that yields a connected ES client and always closes it.

    Usage::

        async with es_client(timeout=30) as es:
            res = await es.search(index="...", body=query)
    """
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


def es_hits_total(response: object) -> int | None:
    """Total hit count from an Elasticsearch search response, or ``None``.

    Returns ``None`` when the response carries no usable ``hits.total`` — a
    window the search could not answer (a stub, an old index without
    ``track_total_hits``) — so callers can report the count as *unavailable*
    rather than assuming a confident 0.

    ``es.search()`` does **not** return a ``dict``: elasticsearch-py 8/9
    returns an :class:`elastic_transport.ObjectApiResponse`, whose ``ApiResponse``
    base is not a ``dict`` subclass. A bare ``isinstance(res, dict)`` guard is
    therefore always false and silently blanks every count; read the payload
    through mapping-style access (which the response proxies to its ``.body``)
    instead.
    """
    try:
        hits = response["hits"]  # type: ignore[index]
    except (TypeError, KeyError, IndexError):
        return None
    total = hits.get("total") if hasattr(hits, "get") else None
    if isinstance(total, int):  # ES 6-style scalar total
        return total
    if hasattr(total, "get"):
        value = total.get("value")
        if isinstance(value, int):
            return value
    return None


async def is_es_online() -> bool:
    """True when Elasticsearch answers a ping within a short timeout."""
    settings = get_settings()
    client = build_es_client(settings)
    try:
        return await client.ping()
    except Exception:
        return False
    finally:
        await client.close()
