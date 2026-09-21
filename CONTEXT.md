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

Known trap: this class has shipped four times — a flat 8192-bytes-per-request proxy derived from `duration_seconds` (see `client_report.py` `_volume_for_bytes`); a vacuous `upload/(upload+download)` share reading `1.0`; `synthesizeBandwidth` faking MB/GB from a request count; a hardcoded `"420 MB"` fallback. Treat it as a recurring defect, not a style preference.
