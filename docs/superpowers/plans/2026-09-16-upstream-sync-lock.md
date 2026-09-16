# Upstream sync — serialise manual + scheduler fetch

## Context
Both upstream syncs (blacklist urls+ips, jaillist) have NO concurrency guard. Manual `POST /upstream-sync` bypasses the scheduler's `max_instances=1` guard, so manual-vs-scheduler and manual-vs-manual _do_sync coroutines can interleave. Combined with the prune (DELETE NOT IN), each concurrent run's set minus the other's freshly-inserted rows cancels, producing a "randomly different" list each manual fetch. Both crews run on one loop (uvicorn → AsyncIOScheduler), so the whole body anchors to one asyncio loop.

## Ruling
Single per-service asyncio.Lock around the ENTIRE _do_sync critical section (fetch → insert → prune → commit → regen). No re-read-after-lock needed; `seen` snapshot at entry suffices. Manual, scheduled job, and boot all funnel through the same locked wrapper. Scheduler `max_instances=1` + `coalesce` retained (redundant, harmless) so budgets stay honest. Cost if wrong: negligible — lock open/close cost is negligible per 5-min cycle.

## Global Constraints
- Locks are per-service module-level `asyncio.Lock()` (never shared across services; backend only).
- Lock acquired BEFORE `_fetch_text`, held through insert+prune+commit+`sync_regenerate` → whole run exclusive.
- No DB schema change, no new deps, no new endpoints. Existing behaviour/status shapes unchanged.
- Frontend `handleFetchUpstream` untouched — it already awaits, and the "doesn't wait" is the server-side race, not a client gap.
- Scheduler `max_instances=1` + `coalesce=True` kept as-is (redundant but harmless layered protection).
- Verification: new concurrency test GREEN after fix; existing tests stay green; full `pytest -q` green.
- Commit per task. No subagents; never spawn reviewers (review arrives separately).
- Ruling authority: this plan.

## Task 1 — Serialise both sync services with asyncio.Lock
Files: app/services/upstream_blacklist.py, app/services/upstream_jaillist.py, tests/test_upstream_blacklist.py (new concurrency test), tests/test_upstream_jaillist.py (same mirror, one test).
Change:
1. upstream_blacklist.py: module-level `_SYNC_LOCK = asyncio.Lock()` (~:63); in `sync_upstream_blacklist` wrap the `await _do_sync(allow_empty_prune)` call with `async with _SYNC_LOCK:` (line ~151). Import `asyncio`.
2. upstream_jaillist.py: module-level `_SYNC_LOCK = asyncio.Lock()` (~:42); in `sync_upstream_jaillist` wrap `await _do_sync(allow_empty_prune)` with `async with _SYNC_LOCK:` (line ~64). Import `asyncio`.
3. tests/test_upstream_blacklist.py: add `test_sync_concurrent_serialized` — reuses the `_run_sync` monkeypatch `_fetch_text` seam where `fake_fetch` ALTERNATES two overlapping bodies e.g. {"a\nb\nc"} / {"b\nc\nd"} on each invocation. `await asyncio.gather(sync_upstream_blacklist(), sync_upstream_blacklist())` — assert the resulting ip-entries set is EXACTLY deterministic (one of the two bodies' sets, never a cross-interleaved mix) and stable across 3 repeats.
4. tests/test_upstream_jaillist.py: mirror with a `test_sync_concurrent_serialized` using two jaillist bodies e.g. {"1.2.3.4\n2.3.4.5\n3.4.5.6"} and {"2.3.4.5\n3.4.5.6\n4.5.6.7"}, same `asyncio.gather` + stable assertion.
Acceptance: new tests green; upstream_blacklist.py + upstream_jaillist.py suites green; full `pytest -q` green.
