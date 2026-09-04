# Action Field Filter (ALLOW/DENY) + Larger Query Windows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Query Page show and filter by action (ALLOW/DENY) instead of being limited to ALLOW-only results, and extend the query time window beyond 24h.

**Architecture:** The backend `apply_filters()` currently hard-codes `df["action"] == "ALLOW"`, which the poll/findings flow intentionally relies on. We add an `actions` parameter (default `("ALLOW",)`, `None` = keep all) so only `run_query` opts out — the Query page then receives both ALLOW and DENY rows and filters them client-side. The `minutes` ceiling on `/api/query/run` is raised from 1440 to 20160 (14 days) and the UI window options are replaced with larger presets.

**Tech Stack:** Python 3 / FastAPI / pandas (backend), React + TypeScript / Radix `Select` (frontend). Backend verified with pytest; frontend verified with `tsc` build + oxlint (no vitest exists in the repo — do not add it).

## Global Constraints

- `apply_filters(df, whitelist_regex, *, exclude_whitelist=True)` — new keyword arg `actions: tuple[str, ...] | None = ("ALLOW",)`. Default keeps ALLOW-only (existing poll/metrics behavior unchanged); `actions=None` returns every row regardless of action.
- `/api/query/run` `minutes` validation: `ge=1, le=1440` → `ge=1, le=20160`.
- The Query page UI action filter is a **client-side** filter over rows the backend already returns; it does NOT re-query ES.
- Frontend verification is `npm run build` (runs `tsc -b`) + `npm run lint` (oxlint) + manual browser check — **no vitest/jsdom**, the repo has none and none should be added.
- Copy/terminology: window options are labeled "Last N hours/days"; action filter options are "All actions", "ALLOW", "DENY".
- All existing tests must stay green; `fetch_logs`/`fetch_metrics` must keep ALLOW-only filtering (findings/webhook semantics unchanged).

---

### Task 1: Add `actions` parameter to `apply_filters`

**Files:**
- Modify: `app/services/monitor.py:210-228` (the `apply_filters` function)
- Test: `tests/test_monitor_patterns.py` (near the existing `apply_filters` tests, after line 156)

**Interfaces:**
- Consumes: nothing new.
- Produces: `apply_filters(df, whitelist_regex, *, exclude_whitelist=True, actions: tuple[str, ...] | None = ("ALLOW",)) -> pd.DataFrame`. When `actions is None`, no action filter is applied. When it is a tuple, rows are kept where `df["action"].isin(actions)`.
- Later consumers: `run_query` (Task 2) passes `actions=None`; `fetch_logs` (line 310) and `fetch_metrics` (line 667) are untouched and keep the default ALLOW-only behavior.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_monitor_patterns.py`:

```python
def test_apply_filters_actions_param():
    df = pd.DataFrame(
        [
            {"url": "http://allow.example/a", "action": "ALLOW",
             "@timestamp": "2026-01-01T00:00:00Z"},
            {"url": "http://deny.example/b", "action": "DENY",
             "@timestamp": "2026-01-01T00:00:00Z"},
        ]
    )
    # Default keeps the old ALLOW-only behavior.
    out = apply_filters(df, "")
    assert out["action"].tolist() == ["ALLOW"]
    # actions=None keeps every row.
    out_all = apply_filters(df, "", actions=None)
    assert out_all["action"].tolist() == ["ALLOW", "DENY"]
    # A specific action filters to that action.
    out_deny = apply_filters(df, "", actions=("DENY",))
    assert out_deny["action"].tolist() == ["DENY"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_monitor_patterns.py::test_apply_filters_actions_param -v`
Expected: FAIL — `apply_filters()` raises `TypeError: apply_filters() got an unexpected keyword argument 'actions'`.

- [ ] **Step 3: Write minimal implementation**

In `app/services/monitor.py`, change the signature and the final return of `apply_filters`:

```python
def apply_filters(
    df: pd.DataFrame,
    whitelist_regex: str,
    *,
    exclude_whitelist: bool = True,
    actions: tuple[str, ...] | None = ("ALLOW",),
) -> pd.DataFrame:
    """Apply whitelist and action filters, and derive base_url.

    Missing columns are tolerated (filled with empty strings) so a single odd
    document can never crash a whole poll. ``exclude_whitelist=False`` keeps
    whitelisted matches so the Query page can badge them in the UI instead of
    silently dropping them. ``actions`` restricts to the given actions
    (default ALLOW-only, which the findings/webhook flow relies on); pass
    ``actions=None`` to keep every row regardless of action.
    """
    df = df.copy()
    for col in ("url", "client_ip", "action", "@timestamp"):
        if col not in df.columns:
            df[col] = ""
    df["base_url"] = df["url"].astype(str).apply(_extract_base_url)
    if whitelist_regex and exclude_whitelist:
        df = df[~df["url"].astype(str).str.contains(whitelist_regex, case=False)]
    if actions is not None:
        df = df[df["action"].isin(actions)]
    return df
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_monitor_patterns.py -v`
Expected: PASS (the two pre-existing `apply_filters` tests still pass because the default `actions=("ALLOW",)` preserves ALLOW-only behavior).

- [ ] **Step 5: Commit**

```bash
git add app/services/monitor.py tests/test_monitor_patterns.py
git commit -m "feat: add actions param to apply_filters so the query page can see DENY rows"
```

---

### Task 2: Return all actions from `run_query` and raise the minutes ceiling

**Files:**
- Modify: `app/services/monitor.py:569` (the `apply_filters` call inside `run_query`)
- Modify: `app/routes/query.py:8` (the `minutes` query param validation)
- Test: `tests/test_logs.py` (append near `test_query_run_annotates_lists`)

**Interfaces:**
- Consumes: `apply_filters(..., actions=None)` from Task 1.
- Produces:
  - `run_query(...) -> dict` now returns `items`/charts that may contain both ALLOW and DENY rows (`action` field already flows through `_build_items`).
  - `/api/query/run` accepts `minutes` up to `20160` and rejects `> 20160` with 422.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_logs.py`:

```python
async def test_query_run_returns_allow_and_deny(client, monkeypatch):
    """The Query page sees both ALLOW and DENY rows, not just ALLOW."""
    from app.services import monitor as svc

    assert (
        client.post(
            "/api/patterns/",
            json={"pattern": "*flagged.example*", "pattern_type": "block"},
        ).status_code
        in (200, 201)
    )

    docs = [
        {
            "@timestamp": "2026-08-07T10:00:00Z",
            "client_ip": "10.0.0.1",
            "server_ip": "10.9.9.9",
            "url": "http://flagged.example/allow",
            "action": "ALLOW",
        },
        {
            "@timestamp": "2026-08-07T10:00:01Z",
            "client_ip": "10.0.0.2",
            "server_ip": "10.9.9.9",
            "url": "http://flagged.example/deny",
            "action": "DENY",
        },
    ]

    class FakeES:
        async def search(self, **kwargs):
            return {"hits": {"hits": [{"_source": d} for d in docs]}}

        async def close(self):
            pass

    monkeypatch.setattr(svc, "build_es_client", lambda *a, **k: FakeES())

    resp = client.get("/api/query/run?minutes=60")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_requests"] == 2
    assert {i["action"] for i in body["items"]} == {"ALLOW", "DENY"}
    assert body["items"][0]["blocked_by"] == ["*flagged.example*"]


def test_query_run_minutes_ceiling(client):
    """minutes beyond 20160 (14 days) is rejected; 20160 is accepted."""
    assert client.get("/api/query/run?minutes=20160").status_code == 200
    assert client.get("/api/query/run?minutes=20161").status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_logs.py::test_query_run_returns_allow_and_deny tests/test_logs.py::test_query_run_minutes_ceiling -v`
Expected: FAIL — `body["total_requests"] == 1` (DENY row filtered out) and `minutes=20160` returns 422.

- [ ] **Step 3: Write minimal implementation**

In `app/services/monitor.py`, inside `run_query` (around line 569), pass `actions=None`:

```python
        df = apply_filters(
            pd.DataFrame([h["_source"] for h in hits]),
            whitelist_regex,
            exclude_whitelist=exclude_whitelist,
            actions=None,
        )
```

In `app/routes/query.py`, change the `minutes` ceiling:

```python
    minutes: int = Query(60, ge=1, le=20160),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_logs.py -v`
Expected: PASS — including the pre-existing `test_query_run_annotates_lists` (its docs are all `ALLOW`, so `total_requests == 4` still holds with `actions=None`).

- [ ] **Step 5: Commit**

```bash
git add app/services/monitor.py app/routes/query.py tests/test_logs.py
git commit -m "feat: query page returns ALLOW and DENY rows; window ceiling raised to 14 days"
```

---

### Task 3: Query Page action filter + larger window options (frontend)

**Files:**
- Modify: `admin-ui/src/components/QueryPage.tsx` (constants, state, header, filtering, table data prop)
- Modify: `admin-ui/src/api.ts` (no signature change needed — `runQuery(minutes)` already accepts any number; verify the `QueryResult.action` type is `string`)

**Interfaces:**
- Consumes: `runQuery(minutes, { q, excludeWhitelist })` from `../api`; `Select` from `./ui`.
- Produces: `QueryPage` with an action filter dropdown and larger window presets.

- [ ] **Step 1: Replace the window options**

Replace `WINDOW_OPTIONS` (currently lines 41-46) with larger presets:

```tsx
const WINDOW_OPTIONS = [
  { value: "30", label: "Last 30 minutes" },
  { value: "60", label: "Last hour" },
  { value: "360", label: "Last 6 hours" },
  { value: "720", label: "Last 12 hours" },
  { value: "1440", label: "Last 24 hours" },
  { value: "2880", label: "Last 2 days" },
  { value: "4320", label: "Last 3 days" },
  { value: "10080", label: "Last 7 days" },
  { value: "20160", label: "Last 14 days" },
]
```

- [ ] **Step 2: Add the action filter options constant**

Add next to `WHITELIST_OPTIONS`:

```tsx
const ACTION_FILTER_OPTIONS = [
  { value: "all", label: "All actions" },
  { value: "ALLOW", label: "ALLOW" },
  { value: "DENY", label: "DENY" },
]
```

- [ ] **Step 3: Add state and client-side filtering**

Inside `QueryPage`, add state next to `whitelistMode` (line ~228):

```tsx
const [actionFilter, setActionFilter] = useState<"all" | "ALLOW" | "DENY">("all")
```

Add the action filter on top of the existing `visibleItems` memo (after line 425):

```tsx
const actionFilteredItems = useMemo(() => {
  if (actionFilter === "all") return visibleItems
  return visibleItems.filter((d) => d.action === actionFilter)
}, [visibleItems, actionFilter])
```

- [ ] **Step 4: Add the dropdown to the header**

In the `PageHeader` (between the whitelist `Select` and the `Window` label), add:

```tsx
<Select
  value={actionFilter}
  onChange={(v) => setActionFilter(v as "all" | "ALLOW" | "DENY")}
  options={ACTION_FILTER_OPTIONS}
  className="w-40"
  aria-label="Filter by action"
/>
```

- [ ] **Step 5: Use the filtered list in the table + counts**

- In the "Matching documents" summary block, replace every `visibleItems` reference with `actionFilteredItems` (the counts at lines 573-589, the summary text `visibleItems.length`, and the `DataTable` `data={...}` prop and its `empty` description).
- Keep `handleBulkBlacklist`/`handleBulkCopy` operating on the full `result.items` (unchanged) so bulk actions are not silently limited to the visible subset.

- [ ] **Step 6: Verify with build + lint + manual check**

```bash
cd admin-ui && npm run build   # tsc -b && vite build — must pass
npm run lint                    # oxlint — must pass
```

Then run the backend and app, open the Query page, and confirm:
1. The window dropdown lists the 9 new presets up to "Last 14 days".
2. The action filter dropdown shows "All actions / ALLOW / DENY".
3. With a block pattern configured and live data, "All actions" shows both ALLOW and DENY rows; selecting ALLOW or DENY filters the table and the counts; bulk actions still work.

- [ ] **Step 7: Commit**

```bash
git add admin-ui/src/components/QueryPage.tsx
git commit -m "feat: add action field filter (ALLOW/DENY) and larger query windows to the Query page"
```

---

## Test Plan

- **Task 1** — `uv run pytest tests/test_monitor_patterns.py -v`: new `test_apply_filters_actions_param` plus both pre-existing `apply_filters` tests pass (default behavior preserved).
- **Task 2** — `uv run pytest tests/test_logs.py -v`: new `test_query_run_returns_allow_and_deny` and `test_query_run_minutes_ceiling` pass; existing `test_query_run_annotates_lists` still passes.
- **Task 3** — `npm run build` and `npm run lint` pass; manual browser verification of the two new controls and their filtering.

## Self-Review

- **Spec coverage:** Action filter (client-side dropdown) → Task 3; backend must return DENY rows → Tasks 1+2; larger windows → Tasks 2 (ceiling) + 3 (presets). "All time" explicitly not wanted → not implemented.
- **Type consistency:** `actionFilter` is `"all" | "ALLOW" | "DENY"` and is compared against `d.action` (the `QueryDoc.action: string` field). `actions=None` in Task 1 maps to the `run_query` call in Task 2. No name drift.
- **Placeholder scan:** No TBD/TODO; every step has concrete code or commands.
- **Existing-test safety:** `apply_filters` default stays ALLOW-only; `fetch_logs`/`fetch_metrics` are untouched. `test_query_run_annotates_lists` uses only ALLOW docs so `total_requests == 4` is unchanged.
