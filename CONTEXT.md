# uNetWatch — Project Context

Single-context file for the whole project. Companion ADRs live in `docs/adr/`; design specs and plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Purpose

uNetWatch (rebranded from "ELK Monitoring") watches **user internet behaviour related to prohibited sites** through Elasticsearch proxy logs. It polls ES for URLs matching **block patterns**, turns the hits that the proxy *let through* into **risk findings**, and manages block/whitelist patterns. It is a monitoring/observability console, not an identity system: a host is an IP + hostname, and nothing maps an IP to a person, department, or asset owner.

## Risk model

- **Risk** = a request whose URL matched a **block pattern**, with proxy action **ALLOW**, and **not whitelisted**.
- **Not risk** = **DENY** (the proxy already enforced it — "handled") or **whitelisted** (explicitly allowed).
- **FLAG** is absent from the proxy data — ignored; risk is effectively ALLOW-only.
- **Findings** = risk only. Whitelisted traffic is fully excluded from Findings and risk counts but remains visible in the raw stream (Query).
- **Analytics / Dashboard**: risk metrics count ALLOW pattern-matches only. Denied requests are reported as a separate **"Enforcements (handled)"** number, never as risk.
- ADR: `docs/adr/0001-risk-definition.md`.

### Alert suppression (what may reach a webhook)

An alert is about what needs **action**. A row is **suppressed** — persisted as
evidence, but withheld from *both* the n8n webhook and the MS Teams card — when
either holds:

- **`action == "DENY"`** — the proxy already enforced the policy (ADR 0001, the
  request is "handled"); it never reached the destination, so alerting on it
  double-counts a stop the operator already made. It stays in `findings` as an
  ATTEMPT.
- **the destination host is already in `blacklist_entries`** — the alert would
  ask the operator to re-block what is already blocked.

Suppression is **delivery-only**: suppressed rows are still persisted (the DENY
ledger is the evidence of clients trying to bypass policy) and still visible in
Monitor / Query / Findings. It is a pure function of the row's own action plus
current blacklist membership — **there is deliberately no `suppressed` column
and no suppression table**, because a stored flag would be a second source of
truth about what is blocked.

- Counts are **measured row counts** (`monitor_logs.suppressed_rows` /
  `suppressed_enforced` / `suppressed_blacklisted`), never estimated.
  `suppressed_rows` counts distinct suppressed rows and the two sub-counts
  **overlap** on a row that is both DENY and blacklisted — never sum them.
- The skip reason is written to `monitor_logs.webhook_reason` and is prefixed
  with the literal **`suppressed:`**. That prefix is a contract with the Logs
  page badge; the prose after it is display-only and must not be parsed.
- `payload.summary.total_matches` still counts **all** filtered rows, not just
  the alertable subset.
- Implementation: `app/services/result_processor.py::alertable_check` (the rule),
  applied in `app/services/monitor.py::fetch_logs` (the only call site).
  Rationale, and the rejected alternatives (jaillist client-IP membership, a
  stored flag, a cooldown): `docs/known-issue-alert-suppression.md`.

### New findings vs enforcement findings

`intent` says what the client **did** (REACH for ALLOW, ATTEMPT for DENY); it
does **not** say how a row counts. Those are different questions, so every
persisted row also carries `accounting_tag`, derived from the same `action` at
store time:

- **`"enforcement"`** — a DENY. The proxy already handled it, so it is evidence
  the policy worked, **not** a new finding. Subordinately counted, never
  alerted on.
- **`"new"`** — everything else (ALLOW, FLAG, blank/unknown). It surfaced on
  this poll and the operator has not seen policy dispose of it.

Because both columns are pure functions of `action`, they are recomputed at
store time rather than stored as independent assertions — they can never drift
from the action they describe, and legacy rows (`action = ''`) need no backfill
(they tag as `"new"`, matching their empty `intent`). Implementation:
`app/services/result_processor.py::accounting_tag_for_action`, persisted in
`store_findings`; surfaced as a **Type** column in Findings and Query.

## Stack & architecture

- **Backend**: Python / FastAPI, single process, SQLite storage (`app/`). Pure-function service modules: `result_processor.py` (filtering, findings, items), `query_builder.py` (ES DSL), `monitor.py` (orchestrator: poll, query, store, webhook), `readout.py` (per-client risk ranking), `blacklist.py`, `jaillist.py` (client-IP jail list), `upstream_jaillist.py` (gist sync). Routes under `app/routes/` (`findings`, `query`, `analytics`, `patterns`, `blacklist`, `jaillist`, `redirects`, `readout`).
- **Frontend**: React + Vite + TypeScript (`admin-ui/`), ECharts for charts. State-driven routing — `App.tsx` view switch over `Sidebar.tsx` `NAV_GROUPS`. Shared workspace state in `FilterContext` (globalFilter, timeRange, actionFilter, viewMode), persisted to localStorage + URL params.
- **Theme**: Notion-style uNetWatch — white `#FFFFFF`, ink `#37352F`, single blue accent `#2383E2` (+ warm-charcoal dark mode).

## Pages (redesign 2026-09-04)

- **Monitor**: Dashboard, **Query** (single live/traffic surface — auto-refresh, 4-column flow Sankey, row inspection)
- **Deep Dive**: **Host Inspector**, **URL Investigation** (new), Analytics
- **Management**: Patterns, Findings, Redirects, Blacklist, Jaillist
- **System**: Logs

Removed: **Live Monitor** (folded into Query), **Traffic/Graph** (aggregate diagram superseded; its URL drill-down became the URL Investigation page). Client drill-down removed — superseded by Host Inspector. ADR: `docs/adr/0002-page-consolidation.md`.

## Domain vocabulary

| Term | Meaning |
|---|---|
| `finding` | persisted risk row (block-pattern URL + ALLOW + not whitelisted), deduped by `(client_ip, url, log_timestamp)` |
| `pattern` | substring glob (`*` any run, `?` single char); `pattern_type ∈ block, whitelist` |
| `action` | proxy disposition: `ALLOW` / `DENY`; `FLAG` unused |
| `enforcement` | a DENY — the proxy handled a prohibited request; *not* a risk |
| `whitelist` | URLs the operator explicitly allows; excluded from Findings + risk counts |
| `blacklist` | bare hosts (`kind ∈ url, ip`) served at `/api/blacklist/urls.txt` / `ips.txt` for nginx/fail2ban |
| `jaillist` | client IPs (sources) to jail, served at `/api/jaillist/ips.txt` for firewall/fail2ban; manual + Findings action + gist upstream |
| `client_ip` | source host; `base_url`/`domain` = destination |
| `host` | an IP + optional hostname; no dept/user/MAC identity |
| `evidence` / measured value | a persisted field; never a synthesized, estimated, or proxy-derived number (see *No synthesized measurements*) |

## Storage (SQLite, inline migrations in `app/database.py init_db`)

`findings` (rich flat fields incl. `action`, `duration_seconds`, `matched_patterns`), `url_patterns`, `blacklist_entries`, `jaillist_entries` (flat client IPs, `UNIQUE(value)`), `tracked_urls` + `redirect_edges`, `monitor_logs`. No settings table (env/pydantic `Settings`); no IP→person/department/host-group table anywhere.

## Conventions

- Verification = `pytest` (backend) + `npm run build` (`tsc`) + lint (`oxlint`) (frontend). No vitest.
- Minimal new deps (only `lucide-react`, `framer-motion` were ever added; ECharts reused). `prefers-reduced-motion` is the single source of truth for animation.
- Commits are authored solely by the human owner — **no AI co-author attribution** (enforced by `.git/hooks/commit-msg` too).
- Decisions get an ADR in `docs/adr/`; design docs go in `docs/superpowers/`.

### No synthesized measurements

**No value displayed, exported, or placed in an alert may be synthesized, estimated, or derived through a proxy formula. Every value must come from a persisted field, or be shown explicitly as unavailable.** Two things make this non-obvious:

- **`0` is ambiguous here.** The flat `bytes_downloaded` collapses the raw `-` NOT-RECORDED sentinel to `0` (spec §j.5, `app/services/logline.py` docstring), so a `0` must never be shown as a confident measured zero — "absent" and "measured zero" are different states and must be distinguishable.
- **There is no placeholder escape hatch.** An unbadged placeholder is a violation, not an exception, and no code path may invent one: a value that is not measured must be rendered as unavailable, not filled with a plausible figure.

Known trap: this class has shipped four times — a flat 8192-bytes-per-request proxy derived from `duration_seconds` (see `app/services/result_processor.py` `_volume_for_bytes`); a vacuous `upload/(upload+download)` share reading `1.0`; `synthesizeBandwidth` faking MB/GB from a request count; a hardcoded `"420 MB"` fallback. Treat it as a recurring defect, not a style preference.
