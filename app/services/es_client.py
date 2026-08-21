"""Elasticsearch client factory and health check.

Provides a shared client builder and an async context manager for
connection lifecycle management. Extracted from ``monitor.py`` to
centralize ES connection concerns.
"""

from contextlib import asynccontextmanager
from typing import AsyncIterator

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
