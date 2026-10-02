# Backend CPU / Memory Leak Audit — `app/` (FastAPI + APScheduler)

**Date:** 2026-10-02
**Scope:** `/home/x0art/Project/uNetWatch/app` (Python backend only; the frontend audit lives in `docs/leak-audit-cpu-memory.md`)
**Trigger:** user report — *"the app flooding the CPU usage, ensure there is no CPU leaks and no Memory leaks."*
**Prime suspects under audit:** (a) the recent `UNETWATCH_WORKERS` + `_acquire_singleton_lock` change, (b) the SQL-aggregation rewrite of the analytics fallbacks, (c) the APScheduler poller.
**Method:** read-only static audit of `app/main.py`, `app/database.py`, every file under `app/services/**` and `app/routes/**`; exhaustive greps for `while True` / `asyncio.sleep` / `time.sleep` / `lru_cache` / `@cache` / module-level containers / `LIMIT 1000|10000|20000|100000` / `ClientSession` / `AsyncElasticsearch`; an AST pass for module-level mutable containers; and **read-only measurement scripts** that (1) simulated the `_RUNS` eviction bound, (2) proved the `_query_cache` key space is unbounded, (3) exercised the `fcntl.flock` singleton semantics, and (4) counted real rows in the three on-disk SQLite files. The server was NOT started; no DB was mutated beyond `SELECT`/`COUNT` and opening files read-only.

**Headline:** there is **no CPU leak (no spin loop, no busy-wait, no unbacked retry loop)** in the backend. There **is** one genuine **unbounded in-process memory growth** (`_query_cache`) and one **effectively-unbounded session-token store** (`_session_tokens`), plus a set of **bounded-but-heavy per-request CPU hotspots** that will *read* as a CPU leak on a single worker under the admin UI's request storm. The recent changes are sound; one ordering nit in `lifespan` does redundant startup work under `workers > 1`.

---

## 1. Executive summary

| # | file:line | Mechanism | Severity | Steady-state? |
|---|-----------|-----------|----------|---------------|
| 1 | `app/services/monitor.py:95` (+ writes at `:245`, `:404`, `:546`; reads `:188`, `:297`, `:453`) | Module-level `_query_cache` dict; entries written on every query, **never evicted** — the TTL (`_QUERY_TTL_S = 2.0`) only turns a read into a cache *miss*, it never deletes. Key embeds arbitrary user `search` text and per-IP values → unbounded distinct keys. | **unbounded-growth** | steady (per user query) |
| 2 | `app/auth_store.py:4` | `_session_tokens: dict[str, float]` grows by one entry per successful `/api/auth/login`; only popped lazily when an *expired* token is *checked again*. Never swept. | **unbounded-growth** | triggered (per login) |
| 3 | `app/services/readout.py:108-125`, `:419-444`, `:514-522` | `SELECT ... FROM findings` **with no LIMIT** → entire window materialized into `rows`, then `pd.DataFrame`, then per-row `json.loads` (`:130`, `:440`, `:535`). `get_policy_classes` also has a quadratic `patterns × rows` `re.search` fallback (`:558-567`). | **CPU-hot / large-alloc** | triggered (per request) |
| 4 | `app/routes/hosts.py:407` | `SELECT * FROM findings {clause}` **no LIMIT** into `rows`, then ~5 full Python passes (`:520`, `:522`, `:530`, `:531`, `:536`, `:551`) per host request. | **CPU-hot / large-alloc** | triggered (per request) |
| 5 | `app/routes/findings.py:357` | Row-level fallback fetches **`LIMIT 100000`** rows into Python and runs `re.search` per row (`:361-366`). | **CPU-hot** | triggered (whitelist-with-regex config) |
| 6 | `app/routes/client_report.py:126/136` + `_build_report_payload` `:149-276` | Up to **20 000** rows fetched, then **~13 separate full passes** over the list (lines 154,155,157,158,165,171,176,186,200,228,249,264,272) in one request on the event loop. | **CPU-hot** | triggered (per report request) |
| 7 | `app/database.py:73-108` | Startup backfill: loops every `matched_patterns='[]'` finding × every block pattern with `re.search`, then one `UPDATE` + one `commit` **per row**. O(rows × patterns) regex work on the loop, per process. | **CPU-hot (startup)** | steady at boot |
| 8 | `app/main.py:100` vs `:106` | `await init_db()` runs **before** the singleton gate, so with `UNETWATCH_WORKERS>1` every worker runs the full schema DDL + O(rows×patterns) backfill + `prune_logs` even though only one owns the scheduler. | **redundant work** | steady at boot (multi-worker) |
| 9 | `app/database.py:19,479` | `init_db()` opens `db` at `:19`; `await db.close()` is at `:479` with **no `try/finally`** — an exception between them (e.g. a DDL failure) leaks one aiosqlite connection for the process lifetime. | **fd-leak (startup, bounded)** | triggered (init failure) |
| 10 | `app/routes/backup.py:88` | `SELECT * FROM findings ORDER BY id` (no LIMIT) → whole findings table into a list in memory for export. Inherent to a full backup; note only. | large-alloc | triggered (`/backup/export`) |

**Ranked answer — is there a CPU leak?** No. See §3: no `while True` without an `await`, no busy-wait, no unbacked retry, and every scheduled interval is honored. The *apparent* CPU flood is items 3–7: heavy **per-request** Python row processing (up to 20 000 rows × many passes) executing on the single event loop. On `UNETWATCH_WORKERS=1` (the default) these serialize and pin a core under the admin UI request storm — exactly the symptom in the frontend audit's commit `24254e1`. This is a **throughput hotspot, not a leak**: it is bounded and stops when requests stop.

**Ranked answer — is there a memory leak?** Yes — two genuine unbounded-growth stores (items 1–2), both process-local and covering the scheduler-owner process. Both are small-per-entry but strictly monotonic in distinct inputs and never release. Everything else that grows is bounded (see §2.4 / §4).

---

## 2. Part 1 — CPU: scheduled work and spin loops

### 2.1 Every scheduled job (enumerated)

All `add_job` calls are in `app/main.py` inside `lifespan`, gated behind the singleton lock. There are **exactly five**, and none is added per-request.

| # | file:line | Function | Trigger | Interval | What it does | Proportional to DB/ES size? | Steady-state cost |
|---|-----------|----------|---------|----------|--------------|------------------------------|-------------------|
| 1 | `app/main.py:145-150` | `app.services.monitor.fetch_logs` | `interval` | `poll_interval_minutes` = **600 s** (10 min, `config.py:26`), passed via `kwargs={"minutes": …}` | ES search (`es_query_size`=5000 hits, 180 s timeout, `max_retries=3`), pandas filter, per-row pattern regex loop, store findings, 2 webhooks | **Yes** — bounded by `es_query_size` (5000), not by DB size | **Hot but bounded** (~once / 10 min) |
| 2 | `app/main.py:151-155` | `app.services.redirects.check_all` | `interval` | `redirect_check_interval_minutes` = **3600 s** (60 min, `config.py:32`) | Sequential HTTP HEAD/GET per tracked URL + per-hop DB writes | **Yes** — linear in tracked URLs, serial | Cheap unless tracked set is large |
| 3 | `app/main.py:160-167` | `app.services.upstream_blacklist.sync_upstream_blacklist` | `interval` | **300 s** (5 min), `coalesce=True, max_instances=1` | Fetch ≤1 MiB per feed, `INSERT OR IGNORE` **per line** (≤~50 k), prune, regenerate `.txt` feeds | **Yes** — linear in upstream feed size | **Heaviest scheduled job** — but disabled by default (`upstream_blacklist_* = ""`) |
| 4 | `app/main.py:168-175` | `app.services.upstream_jaillist.sync_upstream_jaillist` | `interval` | **300 s** (5 min), `coalesce=True, max_instances=1` | Same shape, single IP feed | Yes | Same; disabled by default |
| 5 | `app/main.py:184-191` | `app.services.monitor.refresh_field_inventory` | `interval` | **3600 s** (60 min), `coalesce=True, max_instances=1` | One ES `_search` (size 1) + `field_caps`; writes the process cache | No | Cheap (24 ES req/day) |

Plus three **one-shot** boot actions in `lifespan` (not jobs): `sync_regenerate`/`sync_regenerate_jail` (`main.py:121-122`), `blacklist_tracked_hosts` over all `tracked_urls` (`:127-134`), and one immediate `sync_upstream_blacklist`/`sync_upstream_jaillist`/`warm_field_inventory` (`:196-206`).

**Verdict per job:** intervals are sane for their work. Item 3/4 fire every 5 min, which is 12×/hour — that is more often than needed for a blacklist that changes slowly, but each is O(feed) with a 1 MiB cap and is off by default. **Nothing runs "far more often than its work needs" in the default configuration.** The 10-min poller is the correct cadence for a proxy-log monitor.

### 2.2 Tight loops / spin

`grep -rn "while True|time.sleep|asyncio.sleep"` returns **two** `while True` sites and **zero** sleeps:

- `app/services/upstream_blacklist.py:129` — inside `_fetch_text`, a **bounded read loop**:
  ```python
  body = bytearray()
  while True:
      chunk = await resp.content.read(65536)   # ← awaits network I/O
      if not chunk:
          break
      body.extend(chunk)
      if len(body) > MAX_UPSTREAM_BYTES:       # 1 MiB cap
          raise RuntimeError("body_too_large")
  ```
  Terminates on EOF or at the 1 MiB cap. **Not a spin.** (The old `read(MAX+1)` truncation bug is why it loops — the chunking is deliberate.)

- `app/services/redirects.py:90` — inside `check_url`, a **hop-following loop**:
  ```python
  while True:
      if current in seen:                      # seen set → cycle detection
          return hops, 0, current, "redirect loop detected"
      seen.add(current)
      status, location = await _request_once(session, "HEAD", current, timeout)  # awaits HTTP
      ...
      if status in (301,302,303,307,308) and location:
          ...; current = target; continue
      return hops, status, current, None
  ```
  Every iteration `await`s an HTTP round-trip and the `seen` set bounds the iteration count. **Not a spin.**

There is **no** `while True` without an `await`, and **no** `time.sleep`/`asyncio.sleep` anywhere in `app/` (the sleeps are in the frontend, per the sibling audit). **No busy-wait on a future/task**: `_TASKS` in `routes/redirects.py` holds strong refs with a `add_done_callback(_TASKS.discard)` (`:56`); nothing polls them.

### 2.3 Retry loops with no backoff — ES down / webhook 500

- **ES**: the poll passes `retry_on_timeout=True, max_retries=3` into `build_es_client` (`monitor.py:636-638`), and elasticsearch-py applies its own backoff. An **unreachable** ES raises immediately (no timeout to retry) and is caught (`monitor.py:641-645`) → the job returns. There is **no loop that hammers ES**. The `es_fields` path adds a **negative-result throttle** (`es_fields.py:44,90-92`, `_FAILED_TTL_SECONDS = 30.0`) so a down ES does not make every request pay a connect timeout.
- **n8n webhook**: `deliver_n8n` (`delivery.py:183-207`) → `send_logs` (`:16-32`) does **a single POST** with a 15 s timeout inside `async with`. A 500 is *recorded* (`log["webhook_error"]`) and the job moves on. **No retry loop.**
- **MS Teams**: same — `deliver_msteams` (`delivery.py:35-180`) is single-shot; failures are caught and logged (`:178-180`).
- **Upstream fetch**: `_fetch_text` (`upstream_blacklist.py:113-136`) is a single GET, 15 s total timeout, no retry; a dead feed is skipped and the *other* feed still syncs (`_do_sync:227-241`).
- **Manual webhook retry** (`routes/logs.py:107-186`): single POST, no loop.

**No retry-without-backoff anywhere.** Down ES or a 500ing webhook does **not** spin the app.

### 2.4 The countdown/poll cycle — is the interval honoured?

The poller is registered with the **absolute** interval form:
```python
scheduler.add_job(
    fetch_logs,
    "interval",
    minutes=settings.poll_interval_minutes,
    kwargs={"minutes": settings.poll_interval_minutes},
)
```
`poll_interval_minutes: int = 10` (`config.py:26`) and `redirect_check_interval_minutes: int = 60` (`:32`). Both are `int` with **non-zero defaults**, and the pydantic `Settings` type coerces env values. There is **no job that reschedules itself from wall-clock**, and **no path that could make an interval 0 or None**: the values are read once in `lifespan` and fed straight to APScheduler's `interval` trigger. `redirect_check_interval_minutes` and `poll_interval_minutes` would have to be set to `0` **by an operator** (env) to produce sub-minute rescheduling; there is no computed/`None` path that reaches `add_job`. **The interval is honoured; no accidental sub-second rescheduling.**

*(One theoretical note, not a defect: setting `UNETWATCH_POLL_INTERVAL_MINUTES=0` in the environment would give APScheduler a 0-second interval. This is operator error, not a code path — the config default is 10 and nothing derives the value.)*

### 2.5 Per-request CPU hotspots still left (Python loops over large result sets)

These are the CPU the user is feeling. All are **bounded** (no leak) but heavy and run **on the event loop**.

| file:line | Row bound | Python work per request |
|-----------|-----------|-------------------------|
| `app/services/readout.py:108-117` (`_sqlite_ranked`) | **unbounded** (`FROM findings` + window) | `pd.DataFrame([dict(r) …])` then `df["matched_patterns"].apply(json.loads)` (`:125-134`) |
| `app/services/readout.py:419-428` (`get_client_policy` path) | **unbounded** (per client + window) | `pd.DataFrame` + `apply(json.loads)` + `explode` (`:436-451`) |
| `app/services/readout.py:514-522` (`get_policy_classes`) | **unbounded** | `for row in rows: json.loads` (`:531-539`); fallback `for pattern: for row: re.search` → **O(patterns × rows)** (`:558-567`) |
| `app/routes/hosts.py:407` (`_fetch_findings_rows`) | **unbounded** | ~5 full passes over `rows` per host request (`:520,522,530,531,536,551`) |
| `app/routes/findings.py:357` | **`LIMIT 100000`** | `re.search` per row (`:361-366`) |
| `app/routes/findings.py:44-64` (`/graph`) | `LIMIT 5000` | `re.search` per row when a non-SQL whitelist regex exists (`:57-64`) |
| `app/routes/client_report.py:126/136` | `LIMIT 20000` | `_build_report_payload` = **~13 passes** over ≤20 000 rows (`:149-276`) |
| `app/services/monitor.py:661-782` (`fetch_logs`) | `es_query_size` (5000, `config.py:27`) | pandas frame + `for pat in block_patterns: any(re.search …, u) for u in urls` — **O(patterns × matched URLs)** (`:671-676`); then groupby/apply (`:769-782`) |
| `app/database.py:88-107` (startup backfill) | all `'[]'` findings | **O(rows × patterns)** `re.search` + per-row `UPDATE` |

`json.loads` / `json.dumps` in hot loops specifically: `readout.py:130,440,535` (per row), `result_processor.py:42` (called per row by `_row_is_risk` when `action` is absent, per its docstring), `database.py:98,106` (per backfilled row).

**Important — the SQL rewrite is correct.** The analytics fallbacks were moved into SQL and I verified each: `_findings_summary` (`analytics.py:319-365`), `_previous_period_summary` (`:436-449`), `_findings_bandwidth` (`:483-520`), `_findings_enforcements` (`:538-568`), `_findings_top_domains` (`:582-606`), `_findings_top_enforced` (`:622`). Each computes COUNT/SUM/GROUP BY in SQLite (C, off the loop). **The only remaining Python row loops in that module are the `_fixed_offset_minutes() is None` (DST) fallbacks** — `analytics.py:388-397` and `:506-520`, `:557-568` — which iterate the same ≤20 000-row window calling `local_day`/`local_hour_bucket` per row. For the default `DISPLAY_TZ=UTC` (a fixed offset) those branches are **not taken** (verified: `_fixed_offset_minutes()` returns an int for UTC/`+07:00`), so the analytics rewrite did its job. Under a *named DST zone* the per-row fallbacks return.

### 2.6 CPU conclusion

No spin, no busy-wait, no backoff-less retry, no sub-second rescheduling. The CPU cost is **per-request Python work** (items 3–7 in §1) on a single event loop. With `UNETWATCH_WORKERS=1` this serializes every request and pins a core under load; the fix is to bound/offload these queries (see §6), not to hunt a loop — there is no loop.

---

## 3. Part 2 — Memory: unbounded growth

### 3.1 Confirmed unbounded: `_query_cache` (`app/services/monitor.py:95`)

```python
_query_cache: dict[str, tuple[float, dict]] = {}
_QUERY_TTL_S = 2.0
```

Written at **three** sites, one per query runner:
```python
# monitor.py:245  (run_client_query)      finally: _query_cache[cache_key] = (time.monotonic(), result)
# monitor.py:404  (run_query)
# monitor.py:546  (run_all_query)
```
Read with a TTL check at `:188`, `:297`, `:453`:
```python
hit = _query_cache.get(cache_key)
if hit is not None and time.monotonic() - hit[0] < _QUERY_TTL_S:
    return dict(hit[1])
```
**The TTL never evicts.** A 2-second-old entry is simply treated as a miss — the key and its full result payload **stay in the dict forever**. There is no `del`, no size cap, no sweep. The only clear is `_invalidate_query_cache()` (`:122-124`), called **only from tests** (verified: `grep` shows `tests/test_query_cache.py` and `tests/test_url_search_gating.py` are the sole callers).

The key space is **attacker/user-controlled**:
```python
def _query_cache_key(minutes, search, exclude_whitelist, exclude_blacklist,
                     block_patterns, whitelist_patterns, client_ip=None):
    return "|".join([str(minutes), search or "", str(exclude_whitelist),
                     str(exclude_blacklist), client_ip or "",
                     "|".join(block_patterns), "|".join(whitelist_patterns)])
```
`search` is free text and `client_ip`/`ip` is unbounded. **Measured** (read-only simulation of the key function):
```
100000 distinct user queries -> 100000 permanent dict entries (no TTL eviction)
```
Each entry holds the entire result dict (up to 20 000-row-derived URL lists for the client path). **Severity: unbounded-growth. Steady-state, driven by ordinary use of the Query page.** A long-lived admin session issuing varied searches, or a client-list drill-down across many IPs, grows this dict without limit until the process restarts.

### 3.2 Confirmed unbounded: `_session_tokens` (`app/auth_store.py:4`)

```python
_session_tokens: dict[str, float] = {}
TOKEN_TTL = 86400  # 24 hours

def add_token(token: str) -> None:
    _session_tokens[token] = time() + TOKEN_TTL          # grows on every login

def is_valid_token(token: str) -> bool:
    exp = _session_tokens.get(token)
    if exp is None: return False
    if time() > exp:
        _session_tokens.pop(token, None)                 # only evicted IF re-checked AFTER expiry
        return False
    return True
```
`add_token` is called once per successful `POST /api/auth/login` (`routes/auth.py:35-36`, token = `token_hex(32)` → always unique). An entry is removed **only** if that same token is presented again *after* it expires. A token that is never used again — the overwhelmingly common case — **stays in the dict for the process lifetime**. There is no periodic sweep, no cap. **Severity: unbounded-growth (slow). Triggered: one entry per login.** Small per entry (~token string + float), but strictly monotonic. Note `_session_tokens` lives in the process that also owns the scheduler; with multiple workers each worker has its own copy and a login lands on one of them, so the growth is per-worker.

### 3.3 `_RUNS` / `_TASKS` (`app/routes/redirects.py:25,29`) — BOUNDED (previous concern fixed)

The task brief flagged a prior audit's worry that the redirect run store never evicts. It **does**:
```python
_RUNS: dict[str, dict] = {}          # :25
_TASKS: set[asyncio.Task] = set()    # :29

def _spawn_check(run_id, urls):
    # Prune finished runs (keep the latest 20) so _RUNS never grows unbounded.
    finished = [rid for rid, r in _RUNS.items() if r["status"] in ("done", "error")]
    for rid in sorted(finished)[:-20]:
        _RUNS.pop(rid, None)
    task = asyncio.create_task(_run_check(run_id, urls))
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)     # strong ref released on completion
```
**Measured** (read-only simulation of the exact eviction logic, runs marked finished — worst case for retention):
```
runs=    10 -> _RUNS size=10
runs=    25 -> _RUNS size=20
runs=   100 -> _RUNS size=20
runs=  1000 -> _RUNS size=20
runs= 50000 -> _RUNS size=20
```
`_RUNS` is capped at **20**; `_TASKS` self-prunes via the done-callback. **Not a leak.**

Two caveats worth recording (not leaks):
- The cap is enforced by `sorted(finished)[:-20]` — it sorts **random hex run-ids lexicographically, not by time**, so it keeps "the last 20 by id string", not by recency. Because `_spawn_check` runs before inserting the new run, the maximum sustained size is **21**, and the eviction can in principle drop a *newer* finished run while keeping an *older* one. Functionally bounded; the selection is arbitrary. Cosmetic.
- A run whose task is stuck in `"running"` (never reaches `done`/`error`) is **not** in `finished` and is never pruned. Since `_run_check` wraps `check_all` in try/except/finally (`:36-45`) and always sets a terminal status, this requires the task to be cancelled/never scheduled (e.g. loop shutdown). Bounded by real concurrency in practice.

### 3.4 Caches with no max size / no TTL

| Cache | file:line | Bounded? |
|-------|-----------|----------|
| `_query_cache` | `monitor.py:95` | **NO** — see §3.1 |
| `_session_tokens` | `auth_store.py:4` | **NO** — see §3.2 |
| `_RUNS` | `routes/redirects.py:25` | Yes (20) |
| `get_settings` `@lru_cache` | `config.py:101-103` | Yes — maxsize default 128, key is no-arg |
| `_field_inventory` / `_last_failure` | `es_fields.py:40-42` | Yes — single payload, success cached for process lifetime, failure throttled 30 s (`:44,90-92`); **never accumulates** |
| `_warned` (bad-TZ set) | `timeutil.py:27` | Yes — bounded by distinct bad `DISPLAY_TZ` values (effectively 1) |
| `_LAST_SYNC` | `upstream_blacklist.py:55`, `upstream_jaillist.py:35` | Yes — fixed-shape dict, `_deleted_sample` truncated to `_DELETED_SAMPLE_CAP` (100) |
| `_SKIPPED_RDAP` | `enrich.py:25` | Yes — literal set |
| `_TIME_RANGE_MAP`, `_TABLES`, `_NATURAL_KEYS`, `_FIELD_RESOLVERS`, etc. | various | Yes — literal/constant dicts |

No `@cache` (unbounded) usage anywhere; only the no-arg `@lru_cache` on `get_settings`.

### 3.5 Accumulating whole result sets in memory before writing

- `_do_sync` (`upstream_blacklist.py:202-413`) builds `seen`, `feed_seen`, `errors`, `keep_by_kind`, `stale` for the whole feed before commit. **Bounded by `MAX_UPSTREAM_BYTES = 1_048_576`** (~50 k lines) — the explicit cap at `:30` is what makes this safe. `errors` is *not* separately capped (it can hold one dict per unparseable line, ≤~50 k) but is inside the same 1 MiB ceiling.
- `readout.py` / `client_report.py` / `hosts.py` / `findings.py` accumulate `rows` lists — **unbounded** in the no-LIMIT cases (§2.5 items 1–4), bounded (5000/20000/100000) in the others.
- `backup.export` (`routes/backup.py:88-104`) serializes the whole DB — inherent and bounded by DB size.
- `fetch_logs` builds `df` from ≤`es_query_size` (5000) hits — bounded.

### 3.6 SQLite connections — always closed?

`app/database.py:12-15` `get_db()` opens a **new aiosqlite connection per call**, so every call site must close it. I traced **all 30+ manual `get_db()` sites** and the DI dependency:

- **DI path** — `get_db_conn` (`database.py:495-501`):
  ```python
  db = await get_db()
  try:
      yield db
  finally:
      await db.close()
  ```
  Closes on **both** success and the error path. Every `Depends(get_db_conn)` route (logs, backup, jaillist, analytics reads, triage, findings, patterns, monitor, redirects, client_report, blacklist, hosts) inherits this.

- **Manual path** — every `db = await get_db()` is in a `try/finally: await db.close()`. Spot-verified the nested/awkward ones: `attck_mapping.py:1853-1869`, `findings.py:221-226`, `readout.py:546-553`, `hosts.py:637-644`, `analytics.py:695-701, 891-896, 1017-1021`, `monitor.py:619,828`, `upstream_blacklist.py:220,366`, `upstream_jaillist.py:96,160`, `attck_fleet.py:254-299`, `seed.py:37-52`, `logs.py:18-74,100-126`.

**One exception (item 9 in §1):** `init_db()` (`database.py:18-479`) opens `db` at `:19` and closes at `:479` **without a `try/finally`**. Any exception in the ~460 lines between (a DDL failure, an ALTER failure, the `_json`/`_re` imports) skips the close. This runs **once per process at startup**, so it is at most **one leaked connection per failed boot**, not per request. **Severity: minor fd-leak, startup-only.** (The backfill block at `:73-108` is separately wrapped in `try/except: pass` and *cannot* raise out, but it also does not close on its own internal error — the connection is still the same one closed at `:479`.)

**No per-request connection leak.** This is clean.

### 3.7 HTTP clients (aiohttp) — created per call, always closed?

`grep` for `ClientSession` returns **6 construction sites**, each inside `async with`:

| site | code |
|------|------|
| `services/delivery.py:18` | `async with aiohttp.ClientSession() as session:` |
| `services/upstream_blacklist.py:118` | `async with aiohttp.ClientSession() as session:` |
| `services/redirects.py:210` | `async with aiohttp.ClientSession() as session:` (one session reused across all URL checks in `check_all`) |
| `services/msteams.py:188` | `async with aiohttp.ClientSession() as session:` |
| `routes/logs.py:145` | `async with aiohttp.ClientSession() as session:` (n8n retry) |
| `routes/logs.py:173` | `async with aiohttp.ClientSession() as session:` (Teams retry) |

Every one closes the pool on exit via the context manager. **No unclosed connection-pool leak.** (A per-call session is a minor efficiency cost — no connection reuse — but not a leak.)

The non-aiohttp probes in `enrich.py` use sockets/`http.client` with explicit `finally: conn.close()` (`:441-445`) and `sock.close()` (`:356`). Clean.

### 3.8 APScheduler — job store / executor shutdown; jobs added per request?

- `scheduler = AsyncIOScheduler()` (`main.py:37`) is module-level, created once.
- Shutdown: `scheduler.shutdown(wait=False)` (`main.py:209`) — called on the lifespan's normal exit (after `yield`), but **not** wrapped in `try/finally`, so if an exception propagates through the lifespan body after `scheduler.start()` (`:192`), shutdown is skipped. In practice the body after `start()` is the best-effort boot syncs (`:195-206`) which each catch their own exceptions, so the exposure is small. **Minor.**
- **No job is added inside a request.** All five `add_job` calls are in `lifespan` (verified by grep: no `add_job` outside `main.py`). No per-request job accumulation.
- `AsyncIOScheduler` runs on the app's event loop; executor threads are APScheduler-managed. There is no custom executor leak.

### 3.9 ES client construction — per request/job instead of reused?

`build_es_client` (`es_client.py:16-33`) constructs a fresh `AsyncElasticsearch`; `es_client` (`:36-60`) is the context manager that always `await client.close()` in `finally`. Call sites:

| site | wrapped? |
|------|----------|
| `main.py:368` (/health) | `async with AsyncElasticsearch(...)` — closed |
| `routes/hosts.py:679` | `async with es_client(...)` — closed |
| `routes/analytics.py:730,918,1040` | `async with es_client(...)` — closed |
| `services/attck_mapping.py:1458,1941` | `async with es_client(...)` — closed |
| `services/es_fields.py:126` | `async with es_client(settings)` — closed |
| `services/monitor.py:45-55` (`_es_client_context`) | `finally: await client.close()` — closed |
| `services/readout.py:73` (`_es_client`) | delegates to the same context manager — closed |

**A new client is built per request/job by design (short-lived, request-scoped) and every one is closed.** No per-call client leak. A reused long-lived client would be more efficient, but this is not a leak.

---

## 4. Part 3 — Verify the recent changes didn't introduce a leak

### 4.1 The singleton lock (`_acquire_singleton_lock`, `main.py:62-95`)

```python
_singleton_lock = None                       # module global (:41)

def _acquire_singleton_lock() -> bool:
    global _singleton_lock
    try:
        import fcntl
        lock_path = f"{get_db_path()}.instance-lock"
        handle = open(lock_path, "a+")       # one handle per call
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()                   # loser closes, returns False
            return False
        _singleton_lock = handle             # winner KEEPS it open (intended)
        return True
    except Exception:                        # pragma: no cover
        return True                          # fail-open
```

- **Handle lifetime:** exactly **one** open file handle per process that wins, held for the process lifetime so `flock` stays held. Called **once** from `lifespan` (`:106`), never per-request. **Not leaked per call.**
- **Released on shutdown?** No — the handle is never closed and the lock is never explicitly `LOCK_UN`. This is **correct and expected**: the OS releases the `flock` when the process exits (including on crash), which is the documented rationale (`:76-79`). No fd leak beyond the single intended handle.
- **Measured** (read-only): the second `flock` attempt on the same path is blocked (`OSError`), so only ONE process owns the scheduler. Confirmed:
  ```
  second lock: blocked (correct) -> only ONE process owns scheduler
  ```
- **The loser** calls `handle.close()` before returning `False` — no fd leak on the losing path. **Clean.**
- **Fail-open** (`except Exception: return True`, `:94-95`) means on a filesystem without `flock` **every** process thinks it won and starts a scheduler. That is the intended documented trade-off ("a redundant poller is better than an app that will not boot"), not a leak.
- **`init_db()` throws before the lock is taken?** `init_db()` is at `:100`, the lock at `:106`. If `init_db()` raises, `lifespan` propagates, the app fails to start, and **no lock is taken** — correct (no stale lock: flock is per-open-fd and the process dies). Conversely the lock file itself persists on disk (harmless, `a+` reopens it). **Clean.**

### 4.2 `UNETWATCH_WORKERS` — do API-only workers still allocate the scheduler/ES client?

`run()` (`main.py:433-450`) clamps `workers = max(1, int(env))` and hands it to `uvicorn.run(..., workers=workers)`.

Each worker process runs the **full** `lifespan`. The order is:
```python
async def lifespan(app):
    await init_db()                        # :100  ← runs in EVERY worker
    if not _acquire_singleton_lock():      # :106  ← gate
        log.warning(...)                   # :107
        yield                              # :111  ← API-only worker
        return
    await seed_defaults()                  # :113  ← owner only
    ... feed regen, scheduler.add_job ×5, scheduler.start() ...  # :115-192
    ... boot syncs, warm_field_inventory ...                     # :194-206
    yield
    scheduler.shutdown(wait=False)         # :209
```

- **After the gate**, a non-owner worker does **nothing but `yield`** — it does **not** create the scheduler, does **not** build an ES client, does **not** seed, does **not** regen feeds. **This is correct**: API-only workers do *not* allocate the scheduler/ES.
- **Before the gate**, however, **every** worker runs `await init_db()` (`:100`). `init_db` is idempotent (WAL + `CREATE TABLE IF NOT EXISTS`) **but not free**: it opens a connection, runs DDL, probes columns, and — critically — can run the **O(rows × patterns) `matched_patterns` backfill** (`database.py:73-108`) and `prune_logs()` (`:485`). With `workers = N`, that whole startup cost is paid **N times, concurrently**, even though only one worker then uses the DB as an owner. On a large findings table this is a real (one-time) CPU + DB-lock burst at boot and the concurrency can contend on the SQLite write lock.
  **Severity: redundant startup work, multi-worker only. Not a leak** (it terminates). If `workers > 1` is used, moving `init_db()` *after* the singleton gate (or making it owner-only) would eliminate N−1 redundant inits — but note the comment at `:102-104` says the DDL is intentionally run everywhere so any worker can serve requests; the trade-off is deliberate, only the *backfill* portion is wasteful on non-owners.
- **Each worker also holds its own copy of the unbounded stores** (§3.1 `_query_cache`, §3.2 `_session_tokens`), so memory growth is **per worker** and multiplied by the worker count.

### 4.3 Did the SQL aggregation rewrite add a per-request large allocation?

**No.** Each rewritten `_findings_*` helper (`analytics.py:319, 436, 483, 538`, and `:582, 622`) wraps the row set in a **subquery** and computes COUNT/SUM/GROUP BY **in SQLite**, then `fetchone()`/`fetchall()` only the small aggregate. The Python fallbacks that remain are the DST-zone branches (§2.5) which iterate ≤20 000 rows — and are **not taken for the default fixed-offset (UTC) zone** (verified `_fixed_offset_minutes()` returns an int for UTC and for `+07:00`). The rewrite **reduced** per-request Python allocation; it did not add one. The `LIMIT 10000`/`20000` inside the subqueries bound the intermediate set exactly as the old loops did.

---

## 5. What was checked and found CLEAN (negative results)

- **No spin loops.** Both `while True` sites (`upstream_blacklist.py:129`, `redirects.py:90`) contain `await` I/O and are bounded by a byte cap / a `seen` set. Zero `time.sleep`/`asyncio.sleep` in `app/`.
- **No busy-wait on a task/future.** `_TASKS` uses `add_done_callback(_TASKS.discard)`; nothing polls.
- **No retry-without-backoff.** ES (client backoff / immediate fail + negative throttle), n8n, Teams, and upstream fetches are all single-shot or library-backed.
- **Intervals honoured.** Absolute `interval` triggers, non-zero int defaults, no self-rescheduling-from-wall-clock, no 0/None path to `add_job`.
- **`_RUNS` is bounded to 20** (measured) — the prior audit's concern is fixed; `_TASKS` self-prunes.
- **Every aiosqlite connection on a request path is closed** — DI via `try/finally` (`database.py:495-501`), manual via `try/finally` at ~30 sites. (Only `init_db` lacks `try/finally` — startup-only.)
- **Every `aiohttp.ClientSession` is inside `async with`** (6/6 sites).
- **Every `AsyncElasticsearch` is inside `async with` / a closing context manager** (7/7 sites).
- **APScheduler is created once and shut down**; no `add_job` outside `lifespan`.
- **The singleton lock is correct** (one handle, held for process life, loser closes; measured: second process blocked; fail-open by design; no stale lock).
- **API-only workers under `workers>1` do not create the scheduler or an ES client** (gate at `:106` precedes all of it).
- **The SQL rewrite is semantically faithful and offloads to SQLite**; the DST fallbacks are not taken for fixed offsets.
- **`es_fields` cache is bounded** (single payload + 30 s negative throttle), so a down ES does not cause a per-request ES-client build.
- **`prune_logs` runs on every `write_log`** (`logs.py:78`) but is a bounded DELETE-by-age + DELETE-by-count against ≤`log_max_rows` (1000, `config.py:37`) — a small constant cost per poll, not a leak, and it is exactly what bounds `monitor_logs`.

---

## 6. Top 3 fixes (highest value / lowest risk)

1. **Bound `_query_cache` (`app/services/monitor.py:95`).** Add size/TTL eviction so entries are actually deleted — e.g. evict expired keys on write, or swap the bare dict for an LRU capped at a few dozen entries. This is the one true unbounded-growth store that ordinary use (the Query page's free-text `search`) drives. Also consider dropping the user-text `search` from the key's growth path or capping key length.
2. **Bound `_session_tokens` (`app/auth_store.py:4`).** Sweep expired tokens opportunistically (on `add_token`, drop entries with `exp < time()`), and/or cap the store. One entry per login that is never re-checked currently lives forever.
3. **Bound/offload the no-LIMIT findings scans** — `readout.py:108-117`, `readout.py:419-428`, `readout.py:514-522`, `hosts.py:407`, and reduce `findings.py:357` from `LIMIT 100000`. Push the aggregation into SQL (the pattern the analytics rewrite already proved out) or add a sane LIMIT. These are what actually pin the single worker's CPU (item 5: `client_report`'s ~13 passes over ≤20 000 rows; item 7: the boot backfill's O(rows × patterns) regex + per-row UPDATE).

Secondary: move `init_db()` after the singleton gate (or make the *backfill* owner-only) for `workers > 1`; wrap `init_db`'s body and `lifespan`'s post-`start()` section in `try/finally` so `db.close()`/`scheduler.shutdown()` always run.

---

## 7. Direct answers

**Is there a CPU leak in the backend?**
**No.** There is no spin loop, no busy-wait, no retry loop without backoff, and no sub-second rescheduling. The two `while True` loops both `await` I/O and are bounded (`upstream_blacklist.py:129` by a 1 MiB cap; `redirects.py:90` by a `seen` set); there is not a single `time.sleep`/`asyncio.sleep` in `app/`. **What the user is seeing is not a leak but a throughput hotspot:** bounded but heavy **per-request** Python row processing — up to 20 000 rows iterated 13× in `client_report.py:149-276`, plus unbounded-limit scans in `readout.py:108/419/514` and `hosts.py:407`, all on the single event loop under `UNETWATCH_WORKERS=1`. It pins a core *while requests are in flight* and stops when they stop. Evidence: the enumerated 5 scheduled jobs all have sane cadences and bounded work (§2.1); the two loops (§2.2); zero sleeps; single-shot webhook/ES paths (§2.3); absolute interval triggers with 10/60-minute non-zero defaults (§2.4).

**Is there a memory leak in the backend?**
**Yes — two genuine unbounded in-process stores**, both small-per-entry but strictly monotonic and never released:
1. `_query_cache` (`app/services/monitor.py:95`) — written on every query (`:245,404,546`), read with a TTL that **never evicts** (`:188,297,453`); the only clear is test-only. **Measured:** 100 000 distinct user queries → 100 000 permanent entries, each holding a full result payload, keyed on free-text `search` and per-IP values.
2. `_session_tokens` (`app/auth_store.py:4`) — one entry per successful login (`routes/auth.py:35-36`); removed only if the same token is re-checked *after* expiry, so tokens that are never reused live for the process lifetime.

Both are process-local, so with `workers = N` the growth is per-worker. Everything else that grows is bounded and verified: `_RUNS` is capped at 20 (measured), `_TASKS` self-prunes, `es_fields`'s cache is a single payload with a 30 s failure throttle, `_warned`/`_LAST_SYNC` are fixed-shape, no unbounded `@cache`/`lru_cache` exists, every request-path aiosqlite connection closes (DI and all ~30 manual sites use `try/finally`; only `init_db` lacks one — startup-only, ≤1 connection), and all 6 `aiohttp` sessions and all ES clients are inside context managers. The recent changes did **not** introduce a leak: the singleton lock holds exactly one handle by design (correct, measured), API-only workers allocate no scheduler/ES client, and the SQL rewrite reduced per-request allocation. The two fixes above close both leaks; the top-3 also covers the CPU hotspot.
