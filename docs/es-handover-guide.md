# ES Field Handover Guide

> **Audience:** the operator who owns the Elasticsearch proxy logs.
> **Goal:** collect a single, reviewable JSON snapshot of the REAL ES field
> data so the ATT&CK mapping in uNetWatch can be finalised against it.
> **Related:** `docs/field-sample-report.md` (inventory template),
> `docs/adr/0001-risk-definition.md` (why `action` matters).

---

## 1. What to run, in what order

Run everything from the repo root, with the app's `.env` in place
(`ELASTIC_HOST`, `ELASTIC_USER`, `ELASTIC_PASS`, `ELASTIC_INDEX`).

**Step 1 — collect the handover report (read-only, ES direct):**

```bash
python scripts/collect_es_fields.py --out docs/es-field-handover.json
```

This never writes to ES. It exits `0` even if ES is unreachable — check
`es_reachable` and the `notes` array in the output before trusting anything.

**Step 2 — cross-check against the running app's own view:**

```bash
curl -H "X-API-Key: $TOKEN" http://localhost:8000/api/es/fields
```

> **Header name:** the app authenticates admin requests with **`X-API-Key`**
> (`app/config.py` `verify_admin`; the SPA sends the same header in
> `admin-ui/src/api.ts`). Preemptive `Authorization: Basic` is also accepted,
> but `Bearer` is **not** — the `WWW-Authenticate: Bearer` challenge in the
> 401 response is only there to stop browsers popping a native Basic dialog.
> Generate `$TOKEN` from the login flow and export it:
> `export TOKEN="$(curl -s -X POST http://localhost:8000/api/auth/login \
>   -H 'Content-Type: application/json' \
>   -d '{"username":"admin","password":"<ADMIN_PASS>"}' | jq -r .token)"`

The two artifacts should agree on which baseline fields exist and on the
resolved mode. Disagreement means the app is pointed at a different index or
has a stale cached inventory (restart the app and re-run Step 2).

---

## 2. Pre-sharing checklist

| Artifact | What it proves | How to sanity-check by eye |
|----------|----------------|----------------------------|
| `es_reachable` | The collector actually reached ES | Must be `true`; if `false`, stop — nothing else is trustworthy |
| `es_version` | Cluster is a real ES the app can talk to | A version string, not `null`/`{error}` |
| `mapping` | The raw field tree actually stored in the index | Non-empty `properties`; nested `keyword`/`text` subfields look right |
| `field_caps` | Authoritative "which fields exist" + searchability | Both expected IP fields (`client_ip`, `server_ip`) are `searchable: true` |
| `sample` (`_source`) | Real documents, verbatim — **nothing redacted** | Read every URL/IP/username; confirm you are allowed to share them |
| `field_presence` | Each tracked field's presence + observed type | `@timestamp` type is `date`; `client_ip`/`server_ip` are `ip` or `keyword` |
| `mode` | Resolved readout mode (UC-A / UC-B / COLLAPSED / UNKNOWN) | Must match the mode `/api/es/fields` reports |
| `cardinality` | Rough distinct counts (client_ip, base_url, category, http_method, action) | Bucket counts are plausible, not `0` across the board |

> **The `WARNING` key is not decoration.** The sample documents contain
> verbatim URLs, IPs, usernames and session identifiers. Review before you
> attach the file to anything.

---

## 3. Red flags

- **`action` missing entirely.** `action` is the six-baseline field that the
  risk model depends on: per `docs/adr/0001-risk-definition.md`, *Risk = a
  request whose URL matched a block pattern, with proxy action `ALLOW`, and
  that is not whitelisted*, and `DENY` is reported separately as
  "Enforcements (handled)". Without `action` the ADR 0001 risk definition
  **cannot be applied** — every match would have to be assumed `ALLOW`, which
  would count enforced blocks as risk.
- **`@timestamp` type is not `date`.** Timeline and periodicity analysis
  (`build_timeline`, windowed queries) assume a sortable date. A `keyword` or
  `long` timestamp makes trend/periodicity output meaningless.
- **`user_agent` absent.** The mode collapses: no UA lens means the readout
  drops to `COLLAPSED` (client_ip-only grouping) or `UNKNOWN`. See §4 of
  `docs/field-sample-report.md` for the cheapest un-collapse path.
- **`username` *and* `session` both absent.** Even with `user_agent`, the mode
  cannot reach UC-A/UC-B — durable identity grouping is impossible.
- **`mode` disagrees with `/api/es/fields`.** Stale cache or wrong index; do
  not finalise the ATT&CK mapping until they agree.
- **`es_reachable: false`.** The report is a shell. Fix connectivity
  (`ELASTIC_HOST`, credentials, index pattern) and re-run.

---

## 4. Changelog

| Date | Operator | Notes |
|------|----------|-------|
| <<DATE>> | <<OPERATOR>> | Initial handover capture |
