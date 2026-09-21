# Graded, dynamic host risk score — design (2026-09-21)

**Status:** Proposed
**Supersedes the scoring branch of:** `app/routes/hosts.py` `_risk_from_shares`
(commit `18f41f6`, which made the score *state its reason* but deliberately
left the model unchanged).
**Related:** ADR `0001-risk-definition.md`, `CONTEXT.md` §"No synthesized
measurements", `docs/attck-mapping-spec.md` §j.

## The problem

The current model escalates every host that reaches **even one** blacklisted
destination to `max(92, share_score)`:

```python
if blacklisted_risk > 0:
    floored = max(92, score)          # FLAT — one hit == five hundred hits
```

An operator cannot triage with this: a single stray hit and a host that has
hammered a prohibited destination five hundred times both read "HIGH 92/100".
The owner's decision: **the score must be graded and dynamic.**

## Step 1 — Measured distribution (MEASURE FIRST)

Measured directly against `DATABASE_URL` (default `sqlite:///./unetwatch.db`)
with a throwaway script (`/tmp/measure_findings.py`, not committed):

| Metric | Value |
|---|---|
| total `findings` rows | **2** |
| rows by `action` | ALLOW 2, DENY 0 |
| rows by `intent` | **column does not exist** on this file (migration never ran) |
| distinct `client_ip` | 2 |
| distinct `base_url` | 1 |
| `blacklist_entries` (kind=url) | 0 |
| per-host reach counts | 1, 1 |
| hosts tripping ≥1 / ≥3 / ≥10 blacklisted reaches | 0 / 0 / 0 |

**Conclusion: the production DB is UNMEASURABLE.** Two rows, one distinct
destination, zero blacklist entries, and no `intent` column materialised. There
is no distribution to calibrate against. Per the brief, the model is therefore
built with **every threshold as a named constant in one place**, documented as
*provisional*, with an explicit note that it must be recalibrated once real
volume exists. No threshold below is claimed to be measured.

## Step 2 — The model

### Inputs (all persisted / explicitly-unavailable — none synthesized)

The score consumes five counts, all real fields on the aggregate the route
already computes from the live ES block-pattern window:

| Input | Source | Meaning |
|---|---|---|
| `total` | `len(df)` | block-pattern matches in window |
| `risk_requests` | `action ∈ {ALLOW, ""}` | **REACH** — the client got through |
| `enforcements` | `action ∈ {DENY, FLAG}` | **ATTEMPT** — proxy blocked it |
| `blacklisted_risk` | REACH rows whose `base_url ∈ blacklist` | reached an operator-flagged destination |
| `blacklisted_distinct` | **new**: `nunique` of `base_url` over those rows | how many *distinct* prohibited destinations were reached |

`blacklisted_distinct` is a **real persisted field** (`base_url`), not a proxy.
Per `CONTEXT.md` §"No synthesized measurements" the model uses **no**
`duration_seconds × N`, **no** `bytes_downloaded` on DENY rows (structurally 0 —
spec §j / `logline.py` docstring), and **no** synthesized figure of any kind.

### Vocabulary (unchanged — ADR 0001)

- **REACH** (`ALLOW`) is the strong signal.
- **ATTEMPT** (`DENY`) is intent evidence: it **ranks below any REACH** but
  **contributes** rather than being ignored.
- The ES-unavailable state stays distinct and carries **no score**.

### Scale and bounds

**0–100**, with a stated floor and ceiling (constants below). Justification:
the frontend renders `{score}/100` and a top-of-scale HIGH; a 0–100 scale keeps
the additive contract intact and needs no frontend rescale. The **floor is 0**
(a host with no signals scores 0), and the **ceiling is 100** (clamped).

### Why not a pure share

A share is length-blind: 5 reaches out of 5 looks identical to 500 out of 500.
The owner acts on *volume and breadth of confirmed reaches*, so the model uses a
**volume × breadth multiplier** on top of a share component, then adds a
subordinate ATTEMPT term.

### Constants (single source of truth: `app/routes/hosts.py`)

| Constant | Value | Represents / justification (**provisional — recalibrate**) |
|---|---|---|
| `RISK_SCALE_MAX` | `100` | scale ceiling; clamp bound |
| `RISK_SCALE_MIN` | `0` | floor; a no-signal host is 0, not 12 |
| `NO_TRAFFIC_SCORE` | `0` | empty window baseline (was 12 — 12 was a magic number implying risk; 0 is honest "no evidence") |
| `REACH_BASE` | `20` | a single confirmed reach is already non-trivial: the client **got through** |
| `REACH_PER_HIT_WEIGHT` | `3` | each additional reach adds this, so volume grades |
| `REACH_HIT_SATURATION` | `20` | reaches beyond this add nothing to the volume term (provisional plateau) |
| `DISTINCT_DEST_WEIGHT` | `7` | each **distinct** prohibited destination adds this — breadth grades above repeats |
| `DISTINCT_DEST_SATURATION` | `5` | ≥5 distinct destinations are treated as maximally broad |
| `RECENCY_BONUS` | `10` | added when the most recent reach is within `RECENCY_WINDOW_MIN` |
| `RECENCY_WINDOW_MIN` | `60` | "current behaviour" horizon (the default poll interval × 6) |
| `ATTEMPT_WEIGHT` | `2` | per DENY; subordinate — capped below any reach |
| `ATTEMPT_CAP` | `20` | ATTEMPT total can never exceed this; kept below the minimum possible reach (`REACH_BASE + REACH_PER_HIT_WEIGHT = 23`) so a reach always outranks intent alone |
| `LEVEL_HIGH_MIN` | `70` | HIGH at ≥70 |
| `LEVEL_MEDIUM_MIN` | `45` | MEDIUM at ≥45, else LOW |

The recency input is computed from the max `@timestamp` in the window versus
`now` — a real timestamp, not a synthesized figure.

### Formula (monotonic, explainable)

```
reach_volume   = REACH_BASE + REACH_PER_HIT_WEIGHT · min(reaches, REACH_HIT_SATURATION)
reached = min(blacklisted_distinct, DISTINCT_DEST_SATURATION)
breadth        = DISTINCT_DEST_WEIGHT · reached
recency        = RECENCY_BONUS if newest_reach_age_min <= RECENCY_WINDOW_MIN else 0
attempt_term   = min(ATTEMPT_CAP, ATTEMPT_WEIGHT · enforcements)
score          = clamp(RISK_SCALE_MIN, RISK_SCALE_MAX,
                       reach_volume + breadth + recency + attempt_term)
```

- **More reaches ⇒ higher** (volume term, until saturation).
- **More distinct destinations ⇒ higher** (breadth term).
- **Recency matters** (bonus only for current behaviour).
- **ATTEMPT-only host** can reach at most `ATTEMPT_CAP = 20` ⇒ always **LOW**
  and always **below any REACH host** (a single reach alone is ≥20, but the
  first reach's total — 20 + breadth + recency — is what must dominate; the
  cap guarantees it: max ATTEMPT-only = 30 < min REACH-only-with-breadth... see
  the level table below for the exact ordering, which the tests assert).

### `riskReason` contract (extended, not broken)

The four existing keys the frontend reads are preserved; new fields are
**additive**:

```
{"rule", "level", "score", "floored", "inputs", "text"}
```

- `rule` — now names the graded branch: `"graded_reach"` (any reach) or
  `"graded_attempt_only"` (no reach, some DENY) or `"no_traffic"`.
- `floored` — **kept for wire compatibility, now always `false`.** The flat
  floor is gone, so nothing can set it true; the field stays so older readers
  don't key-error. (Frontend handling updated — see below.)
- `inputs` — retains `totalRequests`, `riskRequests`, `blacklistedRequests`,
  `riskShare`; **adds** `blacklistedDistinct`, `enforcements`, `reachCount`,
  `attemptCount`, `newestReachAgeMinutes` (nullable — `null` when no reach).
- `text` — states the graded inputs verbatim.
- `level` — HIGH / MEDIUM / LOW by the thresholds above.

The ES-unavailable reason (`_unavailable_risk_reason`) is **untouched** and
still carries no `score`.

## Step 3 — Frontend

- `ReportPage.tsx` `RiskSummaryBody` only (lines 131–231; `remove-attck` owns
  the rest): the `floored ? "FLAT FLOOR — not a measurement" : "rule"` badge at
  ~197–199 is replaced. Since `floored` can no longer be true, a floor badge
  would be dead code; the badge becomes a plain `rule` badge and the input line
  gains the distinct-destination count.
- `api.ts` `hostRiskFromShares` — the client-side duplicate. It is **drifted**:
  it never modelled the blacklist signal at all. It is updated to mirror the
  graded model so the two paths cannot give two answers.

## Recalibration note

Every constant above is **provisional**. With 2 rows and 0 blacklist entries in
the production DB, no threshold is measured. Once real volume exists, re-run the
Step-1 measurement and adjust `REACH_HIT_SATURATION`, `DISTINCT_DEST_SATURATION`
and the level cut-offs to the observed p90/max.

## Verified scores (monotonicity, ceiling collision)

Grid of reaches × distinct destinations (all recent, `total = reaches`):

| reaches \ distinct | 1 | 2 | 5 |
|---|---|---|---|
| 1 | 40 | 47 | 68 |
| 5 | 52 | 59 | 80 |
| 20 | 97 | 100 | 100 |

The score is non-decreasing in both axes. It saturates at the 100 ceiling: 20
reaches to 2 distinct destinations and to 5 both clamp to 100 — a deliberate
ceiling collision (both are maximally bad), documented rather than hidden. The
grading is strict below the ceiling. A DENY-only host caps at 20, strictly below
the weakest reach host (23).

The owner's case — 10 requests, all ALLOW, 3 to blacklisted destinations over 2
distinct hosts, newest reach 10 min ago — scores **74 (HIGH)**, where the old
model returned a flat 92. Reason text:

> Graded from 10 reach(es) (ALLOW, the client got through) over 10 request(s),
> 2 distinct blacklisted destination(s), newest reach 10 min ago, and 0
> enforcement(s) (DENY) → HIGH 74/100.

## Verification performed

- `uv run pytest -q` → **6 failed, 407 passed** (baseline 6 failed, 403 passed;
  the 6 are the pre-existing ATT&CK failures, +4 new passing host tests).
- `uv run ruff check app/ tests/` → **Found 91 errors** (unchanged baseline; the
  two errors in `hosts.py` — N803/N841 — are pre-existing at HEAD).
- `cd admin-ui && npm run build` → **green**.
