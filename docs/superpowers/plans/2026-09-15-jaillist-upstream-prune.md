# Jaillist upstream full sync — prune rows missing upstream

## Context
Today the jaillist upstream sync is insert-only: `sync_upstream_jaillist` merges the feed via `INSERT OR IGNORE` and never deletes. Stale IPs removed from the upstream feed linger locally forever. Goal: full synchronization — IPs missing from the upstream feed get deleted locally too.

Verified current behavior: `_do_sync` loops `parse_upstream_body` lines; per-line normalize fail → `errors`; intra-fetch dup via `seen` set → `skipped`; else `INSERT OR IGNORE (value, 'upstream')`, rowcount → `added`/`touched` else `skipped` (any-source collision via `UNIQUE(value)`). Zero `DELETE` anywhere. `jail-ips.txt` regen only `if touched`. Scheduler (5-min) + boot + manual `POST /upstream-sync` all call the same function.

## Ruling
Empty-valid-feed guard: refuse prune when the parsed set is empty (transient empty/comment-only/all-invalid file must not wipe enforcement). Return `ok:True, deleted:0` + `prune_skipped:"empty-feed"` + warning log. Opt-in `sync_upstream_jaillist(..., allow_empty_prune=False)` for explicit wipe; scheduler keeps default. Cost if wrong (genuine empty feed): needs an explicit step; far cheaper than a wipe.

## Global Constraints
- Deletion scope: ONLY `source='upstream'` rows missing from the fetched set. Never manual/finding. SQL: `DELETE FROM jaillist_entries WHERE source='upstream' AND value NOT IN (...)` with chunked placeholders (SQLite var limit, ~50k-line feeds).
- Guards: disabled (empty URL) → return disabled, no DB open/prune; fetch failure → `ok:False`, `_LAST_SYNC` untouched, no delete.
- Shapes additive only. Sync return adds `deleted:int` + `deleted_sample` (capped 100) + `deleted_truncated:bool` (+ `prune_skipped` when the guard fires). `_LAST_SYNC` adds `last_deleted` (+ `last_deleted_sample`). `get_upstream_status` exposes them. All existing keys byte-identical (admin-ui reads unchanged).
- Regen `jail-ips.txt` when touched OR deleted.
- Verification: new tests + `tests/test_upstream_jaillist.py` green, then full `pytest -q`; admin-ui untouched.
- No new deps, no new endpoints, blacklist sync stays insert-only, scheduler cadence unchanged, routes pass dicts through.
- Commit per task. No subagents; never spawn reviewers (review arrives separately).
- Ruling authority: this plan.

## Task 1 — Prune jaillist rows missing upstream
Files: `app/services/upstream_jaillist.py` (`_do_sync`, `_LAST_SYNC`, `get_upstream_status`), `tests/test_upstream_jaillist.py`.
Change:
1. Post-insert, pre-commit: diff `SELECT value ... WHERE source='upstream'` vs `seen` set (or single `DELETE ... NOT IN`); `DELETE` missing upstream rows with chunked placeholders. Count `deleted` (+ sample capped 100, `deleted_truncated` flag).
2. Empty-valid-set guard: `seen==∅` after parse → skip `DELETE`, return `deleted:0` + `prune_skipped:"empty-feed"` + warning log. Param `allow_empty_prune=False`; scheduler keeps default.
3. Regen when touched or deleted.
4. Return/status: `deleted`, `deleted_sample`, `deleted_truncated`, `prune_skipped` (when fired); `_LAST_SYNC` `last_deleted` (+ sample); status exposes them; legacy keys unchanged.
5. Tests reusing the `_run_sync` seam, `_reset_last_sync`, `db_path` fixture, `cache_clear` pattern: prune removes an upstream-missing row (seed 3 upstream, feed 2 → `deleted==1`, DB count 2); manual/finding rows with missing values survive (`deleted` counts only upstream); pre-existing manual row colliding with a feed value stays `source='manual'` and survives a later prune; disabled (empty URL) → `disabled`, zero deletes on pre-seeded upstream rows; fetch raises (`http_404`/timeout) → `ok:False`, zero deletes, `_LAST_SYNC` preserved; empty-valid fetch (comments/invalid only) → `ok:True, deleted==0`, rows preserved, `prune_skipped` set; `allow_empty_prune=True` wipes; regen reflects deletions (`jail-ips.txt` lacks pruned IP); status shows `last_deleted`/`deleted` with legacy keys unchanged.
Acceptance: new tests green; full `tests/test_upstream_jaillist.py` green; full `pytest -q` green; no blacklist regression.
