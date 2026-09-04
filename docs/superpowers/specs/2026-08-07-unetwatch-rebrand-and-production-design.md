# uNetWatch — Rebrand, Layered Redirect Flow, and Production Readiness

Date: 2026-08-07

## Overview

Turn the app currently named **ELK Monitoring** into an OSS/FOSS-ready project:

1. **Rebrand** every user-facing surface to **uNetWatch** (package slug `unetwatch`).
2. **Fix the Redirect Flow** to show full redirect *chains* as a layered alluvial diagram (currently collapsed to `url → final_url`).
3. **Production readiness**: Docker packaging, CI + PyPI publish, config/secrets hardening, structured logging, and a dependency-aware health endpoint.
4. **Rewrite the README** for an OSS audience.

---

## 1. Rebrand to uNetWatch

### Naming convention
- **Display / docs / UI title:** `uNetWatch`
- **Python package / repo slug:** `unetwatch` (PyPI requires lowercase)

### Scope of the rename

| Surface | Current | New |
|---|---|---|
| `pyproject.toml` `[project].name` | `elk-monitoring` | `unetwatch` |
| FastAPI `title` | `ELK Monitoring` | `uNetWatch` |
| FastAPI `description` | URL pattern monitoring… | uNetWatch description |
| FastAPI `version` | `0.2.0` | `1.0.0` |
| `index.html` `<title>` | `ELK Monitoring` | `uNetWatch` |
| `App.tsx` header title | `ELK Monitoring` | `uNetWatch` |
| `Sidebar.tsx` brand | `ELK Monitor` / `Pattern console` | `uNetWatch` / tagline |
| `LoginPage.tsx` heading | `ELK Monitoring` | `uNetWatch` |
| `DashboardPage` subtitle | ELK monitoring system overview | uNetWatch overview |
| localStorage token key | `elk_token` | `unetwatch_token` |
| localStorage theme key | `elk-theme` | `unetwatch-theme` |
| Default SQLite db | `elk_monitoring.db` | `unetwatch.db` |
| User-Agent header (redirect checker) | `elk-monitor/0.1` | `unetwatch/1.0.0` |

**Backward-compat reads:** when reading the token / theme from localStorage, check the new key first, fall back to the old `elk_*` key so existing sessions survive the upgrade.

**Version bump:** `1.0.0` (first OSS release; also stamped into the built UI if a version constant is surfaced).

**Not renamed:** historical design docs under `docs/superpowers/specs/*` (design history, not user-facing); internal `app.*` module names keep their descriptive routing names (`app.routes.redirects` etc.) — renaming Python modules adds churn for zero user value.

**`pyproject.toml` also needs:** a `[build-system]` (`hatchling`) and a `[project.scripts]` console entry (`unetwatch = app.main:...`) so `pip install .` / `python -m build` produce an installable, runnable package — required for PyPI publishing.

---

## 2. Layered alluvial redirect flow

### Current behavior (the bug)
`toSankey()` in `RedirectsPage.tsx` collapses every chain to a single edge
`tracked_url → final_url`, so a chain like `url2 → url2_1 → url2_2 → final_url2`
renders as just `url2 → final_url2` — the intermediates vanish and the
diagram loses the actual hop structure.

### New behavior
Build the Sankey input from the **real hop edges** (`graph.links`, which come
from `redirect_edges`) and lay them out by chain depth:

1. **Directed graph** from `graph.links` (only `active === true` edges — history is hidden from the live flow).
2. **Layer = longest path depth**: roots (no incoming edge) at layer 0; each hop advances a layer; terminals (no outgoing edge) land on the last layer. This handles chains of any length:

```
[] url1  final_url1 []
[] url2  [] url2_1  [] url2_2  final_url2 []
```

3. **Nodes** get `layer: depth`; **links** are the real hop edges, `value: 1` each.
4. **Edge tooltip** shows the HTTP status (`302 →`) via `http_status` on each link.

### Why the frontend only
The backend `/api/redirects/graph` already returns every hop as a `links`
entry (`source → target`, `http_status`, `active`). The data is complete;
only the frontend build collapses it.

### What stays the same
- The `SankeyDiagram` component (already supports `layer`, per-layer colors, left-pointing last-layer labels).
- The "direct / unresolved URLs" chips below the flow (unchanged).
- History stays in the table + per-URL history drawer (not in the live flow).

---

## 3. Production readiness

### 3a. Docker + CI + PyPI publish

**Dockerfile** (multi-stage):
- Stage 1: `node:22-alpine` → `cd admin-ui && npm ci && npm run build`
- Stage 2: `python:3.12-slim` → install package (`pip install .`), copy built `dist/` from stage 1, non-root user, `HEALTHCHECK` → `/health`.

**docker-compose.yml**: app service + optional Elasticsearch service behind a compose **profile** (`es`), so `docker compose up` runs against external ES by default and `docker compose --profile es up` brings a bundled ES for a turnkey demo.

**.dockerignore** (exclude `.venv`, `node_modules`, `dist`, caches, `.git`, `.omc`).

**CI** (`.github/workflows/ci.yml`): on push/PR —
- Python: `ruff check` + `pytest`
- Node: `cd admin-ui && npm ci && tsc -b && vite build`

**Publish** (`.github/workflows/publish.yml`): on version tags → `python -m build` → upload to PyPI using a `PYPI_TOKEN` secret (documented).

### 3b. Config / secrets / observability

- **`APP_ENV`** setting: `development` (default) | `production`.
- **Fail-fast in production:**
  - refuse to boot if `ADMIN_PASS` is `changeme` or empty;
  - refuse to boot if `API_KEY` is empty (API-key auth becomes a hard requirement in prod);
  - validate `ELASTIC_HOST` / `ELASTIC_INDEX` non-empty.
- **Structured logging:** configure Python `logging` with a structured formatter; add a request-logging middleware that emits one line per request with method, path, status, duration, and a **request ID** (generated per request, echoed in the response header `X-Request-ID`).
- **`/health`:** return `{status, version, dependencies: {elasticsearch, database}}`, each dependency with an async reachability check (ES ping, DB query). Keeps the current simple liveness (`{status: "ok"}`) as a `/-/live` or the same endpoint's basic form.
- **CORS origins** become env-configurable (`CORS_ORIGINS`, comma-separated), defaulting to the current dev origins.

### 3c. Auth / CSP
Kept as-is (already decent: session tokens, API key, Basic Auth; CSP with inline-script hash; security headers). Only verify it still passes after renames — the inline script hash in `main.py` must be regenerated if `admin-ui/index.html` changes.

---

## 4. README rewrite (OSS)

Sections for the new README:

- **Title + one-liner**: uNetWatch — URL pattern monitoring and redirect tracking for Elasticsearch proxy logs.
- **Features** (from current README, refreshed + redirect chain visualization).
- **Screenshots placeholder** (diagram + dashboard).
- **Architecture overview** (backend/FastAPI + admin UI/React, one-process serving, SQLite).
- **Quickstart**: Docker one-liner (with bundled ES via profile) + manual setup (venv, `.env`, build UI, run).
- **Configuration reference** (full table incl. new `APP_ENV`, `CORS_ORIGINS`, auth-required vars).
- **API overview** (endpoints table: patterns, monitor, findings, redirects, blacklist, query, logs, health).
- **Security notes** (default creds must be changed in production, CSP, API-key/Basic auth).
- **Contributing** (dev setup, running tests, lint).
- **License** (MIT — already present).
- **CI / PyPI badges** (placeholders until the workflows run).

`admin-ui/README.md` updated to match (uNetWatch admin console).

---

## Scope guardrails
- Renaming is surface-level + package metadata + storage keys; **no** Python module renames.
- No unrelated refactors (the layered flow is the only behavior change to RedirectsPage).
- Auth/CSP behavior unchanged.

## Verification
- `pytest` (all existing tests pass)
- `ruff check`
- `cd admin-ui && tsc -b && vite build`
- `docker build` succeeds
- Manual: run app, confirm uNetWatch branding, redirect diagram shows chains, `/health` reports deps
