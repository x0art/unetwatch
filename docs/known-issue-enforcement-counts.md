# Known issue: enforcement counts derived from a pattern-filtered ES frame

Status: **known issues, NOT a specification.** Nothing in this document is fixed
yet. No code change accompanies it. It is a work list: each entry names the call
site, what it computes, how it is wrong on real traffic, whether an operator can
see the wrong number, and whether the fix pattern already in the tree addresses
it directly.

## Shared root cause

The Elasticsearch query built by `build_logs_query` (in
`app/services/query_builder.py`) appends a `url` block-pattern clause, so the
frame it returns contains only rows whose URL matches a configured block
pattern. The proxy, however, records a DENY against the destination it refused —
and that destination URL need not contain any block pattern (a plain HTTP
`Host:` header, an IP literal, an SNI name, and so on). DENY rows recorded
against a patternless URL are therefore never returned, and any count taken from
that frame reads 0. The same clause also means a DENY row that *does* match a
pattern is the only kind that can ever arrive, which is why a frame-wide count is
wrong in both directions wherever it is used to split ALLOW from DENY.

The fix pattern now exists in the same module:
`build_logs_query(..., actions=None)` gained an optional `actions` parameter.
Passing `actions=["DENY", "FLAG"]` OMITS the pattern clause entirely and appends
a `terms` filter on the `action` field instead; the two are mutually exclusive by
construction because they answer questions about two different row populations
(a REACH is a block-pattern match; an ENFORCEMENT is an action). When `actions is
None` the built query is byte-identical to the previous behaviour, so this is a
strict addition.

The defect was confirmed for `GET /api/hosts/{ip}`, which was fixed with a
two-query split (`app/routes/hosts.py:574` reach query, `:579` action query).
The sites below are the **remaining** call sites still deriving an enforcement
count from the pattern-filtered frame.

---

## 1. Tier 1 — `app/routes/analytics.py:660` (`_es_enforcements`)

- **Computes:** daily allow-vs-deny buckets — for each local day, a count of
  `DENY`/`FLAG` rows into `deny` and everything else into `allow`.
- **Wrong on real traffic:** missing DENYs make the `deny` series read ~0, and
  because the classifier is `deny if action in (DENY, FLAG) else allow`, the very
  rows that should have been denials are also counted into `allow`. The chart is
  wrong in two directions at once, not merely short.
- **Displayed:** yes, on screen. It is the primary "Daily policy enforcements"
  stacked bar chart (frontend `admin-ui/src/components/AnalyticsPage.tsx`: the
  series is derived at `:252-253`, exported to CSV at `:532`, and rendered from
  `:681-691`).
- **Does `actions=` fix it directly?** Not with one broadened query. The fix
  needs **two queries**: keep the existing pattern query for the ALLOW series and
  add an action query (`actions=["DENY","FLAG"]`) for the DENY series. Broadening
  the single query to an action query would change the meaning of both series.

## 2. Tier 1 — `app/routes/analytics.py:525` (`_es_summary`)

- **Computes:** `totalEnforcements` — the headline enforcement figure over the
  window, from `df["action"].isin(["DENY","FLAG"]).sum()`.
- **Wrong on real traffic:** reads ~0, because the frame never contains the
  patternless-URL DENY rows. The legacy/else branch (no `action` column,
  COLLAPSED docs) additionally hardcodes `total_enforcements = 0`
  (`app/routes/analytics.py:596-599`); now that DENY rows are persisted, that
  branch is doubly wrong.
- **Displayed:** yes, on screen. It is the "Enforcements (DENY — handled)" stat
  card (value derived at `admin-ui/src/components/AnalyticsPage.tsx:217`, CSV
  column at `:520`), and the number is also aliased to the back-compat key
  `totalBlocked` at `app/routes/analytics.py:839`.
- **Does `actions=` fix it directly?** Yes — a count-only action query
  (`actions=["DENY","FLAG"]`, `size: 0`) supplies the correct total.

## 3. Tier 2 (derived) — `app/routes/analytics.py:734` (`_es_top_enforced`)

- **Computes:** the top enforced target domains — groups the frame by domain and
  counts `DENY`/`FLAG` rows per domain.
- **Wrong on real traffic:** returns `[]` when no DENY row is in the frame, which
  is indistinguishable from "no enforcements occurred". A caller cannot tell an
  empty result from a broken one.
- **Displayed:** **CORRECTION to the prior investigation.** The prior list said
  this is displayed as a "Top enforced target domains" panel. As of this writing
  there is no such panel: `admin-ui/src/api.ts:2042`
  (`getAnalyticsTopEnforced`) has **no caller** in `admin-ui/src/`, so the
  `/api/analytics/top-enforced` and `/api/analytics/top-denied` endpoints are
  currently not surfaced by the admin UI (the top-clients panel replaced the
  old top-enforced panel per the comment at `admin-ui/src/api.ts:1956`). The
  defect is real and the endpoint is public API, but it is not on screen today.
- **Does `actions=` fix it directly?** Partially. The action query supplies the
  rows to group by, but the `primaryRule` field currently reads
  `matched_patterns`, which is app-derived and only populated for pattern
  matches. For a patternless DENY there is no `matched_patterns`, so the field
  would come back empty. It should read the proxy's own `rule_name`/`rule_info`
  (both PRESENT in the inventory — see `app/services/attck_mapping.py:113-114`
  and the rule-code reader at `:1611-1615`), or emit an explicit "no rule
  attributable" marker.

## 4. Tier 3 (internal, silently WITHHOLDS detection) — `app/services/attck_mapping.py:1402` (`map_host`)

- **Computes:** `signals.enforcements`, set at
  `app/services/attck_mapping.py:1562` from
  `actions.isin(["DENY","FLAG"]).sum()` over the frame fetched at `:1402`.
- **Wrong on real traffic:** the wrong 0 is a GATE in three host technique
  predicates — `:910` (`enforcements > risk_requests * 0.5`), `:1024`
  (`enforcements > 0`), `:1173` (`enforcements < 3`). A wrong 0 therefore
  withholds techniques with no visible wrong number: a silent blind spot, not a
  visible error.
- **Displayed:** internal-only. The per-host ATT&CK panel has been removed. NOTE:
  this engine is deliberately quarantined — the ATT&CK UI was removed, the
  per-host panel is gone, but the fleet endpoint and
  `admin-ui/src/components/AttckFleetPage.tsx` remain and consume this path.
- **Does `actions=` fix it directly?** Yes.

## 5. Tier 3 — `app/services/attck_mapping.py:1841` (`map_url`)

- **Computes:** the URL-side twin of #4 — the same pattern-filtered frame, the
  same `signals.enforcements`.
- **Wrong on real traffic:** same silent withholding as #4.
- **Displayed:** internal-only, same quarantine as #4.
- **Does `actions=` fix it directly?** Yes.

---

## Newly found

None confirmed beyond the five above. `app/services/monitor.py`,
`app/routes/findings.py` and `app/services/readout.py` also call
`build_logs_query`, but none of them derives an enforcement count from the
returned frame, so they are not instances of this defect.

## Verified line map

Every `file:line` above was re-checked against the working tree at the time of
writing. Where the number points at a call inside a function, the function's
`def` line is noted for orientation:

- `app/routes/analytics.py:525` — `build_logs_query` inside `_es_summary`
  (`def _es_summary` at `:485`).
- `app/routes/analytics.py:596-599` — legacy `total_enforcements = 0` branch.
- `app/routes/analytics.py:660` — `build_logs_query` inside `_es_enforcements`
  (`def _es_enforcements` at `:625`).
- `app/routes/analytics.py:734` — `build_logs_query` inside `_es_top_enforced`
  (`def _es_top_enforced` at `:698`).
- `app/routes/analytics.py:839` — `agg["totalBlocked"] = agg.get("totalEnforcements", 0)`.
- `app/services/attck_mapping.py:1402` / `:1562` / `:910` / `:1024` / `:1173` —
  `map_host` query, the `enforcements` assignment, and the three gate predicates.
- `app/services/attck_mapping.py:1841` — `map_url` query.

The already-fixed reference site is `app/routes/hosts.py:574` (reach query) and
`:579` (count-only action query).
