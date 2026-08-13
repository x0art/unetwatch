"""run_query TTL cache — identical duplicate ticks reuse the cached result.

In the test environment there are no block patterns, so run_query returns
fast without touching ES (es_online stays True); these tests pin the cache
mechanics: a cache entry is written, the key is stable for identical
inputs, and invalidation clears it.
"""

from app.services.monitor import (
    _invalidate_query_cache,
    _query_cache,
    _query_cache_key,
    run_query,
)


async def test_run_query_short_ttl_cache(client):
    _invalidate_query_cache()
    first = await run_query(minutes=30)
    second = await run_query(minutes=30)
    assert _query_cache  # a cache entry was written
    # Same (minutes, no patterns) key -> served from the cache, same result.
    assert first["window_minutes"] == second["window_minutes"] == 30
    # Only one distinct key for the two identical runs.
    assert len(_query_cache) == 1


async def test_query_cache_key_distinguishes_inputs(client):
    _invalidate_query_cache()
    base = _query_cache_key(60, "", False, False, [], [])
    assert base == _query_cache_key(60, "", False, False, [], [])
    assert base != _query_cache_key(30, "", False, False, [], [])  # minutes
    assert base != _query_cache_key(60, "foo", False, False, [], [])  # search
    assert base != _query_cache_key(60, "", True, False, [], [])  # flags
    assert base != _query_cache_key(60, "", False, False, ["*x*"], [])  # patterns


async def test_invalidate_query_cache_clears(client):
    _invalidate_query_cache()
    await run_query(minutes=45)
    assert _query_cache
    _invalidate_query_cache()
    assert not _query_cache
