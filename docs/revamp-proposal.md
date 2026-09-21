# uNetWatch Revamp Proposal — Aligning the Product to Its Own Goal

**Status:** Proposal for decision
**Date:** 2026-09-21
**Author:** Architecture review
**Scope:** Product surface, risk model, evidence pipeline, feed contract. No application code is changed by this document.
**Supersedes:** Nothing. Challenges `docs/adr/0001-risk-definition.md` (§3).

---

## 0. Executive summary

The product already contains, in working order, every mechanical component the owner's goal requires: a poll that reads the proxy index (`app/services/monitor.py:604`), a block-pattern matcher (`app/services/query_builder.py:32`), a persistence path with a natural dedupe key (`app/database.py:49`), a whitelist/blacklist normalizer (`app/services/blacklist.py:11`), a jail normalizer (`app/services/jaillist.py:11`), four atomic CRLF feed writers (`app/services/feeds.py:52`, `:69`), and two operator-authored list-management pages.

What is missing is not capability. It is **alignment**: several large features were built on top of the same raw data without a shared theory of what the product is for. The result reads as several products sharing a database.

The evidence for "development collapsed" is concrete and measurable:

- The product's only external interface is four text files (`urls.txt`, `ips.txt`, `jail-ips.txt`, plus the same `urls.txt`/`ips.txt` contract) served at `app/routes/blacklist.py:24`, `:38` and `app/routes/jaillist.py:17`. A feature that does not influence those four files, and does not influence the operator's decision to write them, is not part of the product (see §1).
- The findings table — the app's evidence store — is **structurally lossy for the owner's stated intent**: the poll calls `apply_filters(...)` with the default `actions=("ALLOW",)` (`app/services/result_processor.py:76`, used at `app/services/monitor.py:652`), so every `DENY` row is discarded before persistence. The owner explicitly says DENY is worth keeping because *"we want to know who is trying to access it even after the site is blocked in proxy device."* The one row the owner says he wants is the one row the pipeline throws away.
- A 77 KB ATT&CK engine (`app/services/attck_mapping.py`, 1974 lines) plus a fleet aggregate (`app/services/attck_fleet.py`) produces, on the owner's real deployment, **at most two LOW-severity techniques** — a figure the engine's **own review** documented against the owner's verbatim document (`docs/attck-mapping-spec.md:1062-1073`, "the operator's realistic panel is at most two LOW techniques"). None of its output reaches any of the four feed files.
- The host evidence surface displays an **invented number where measured traffic is expected**. `_synthesize_bandwidth` (`app/routes/hosts.py:52-58`) multiplies a request count by a constant and formats it as a data volume, and `admin-ui/src/api.ts:1530-1537` does the same in the browser. This is the third instance of a single fabrication bug class (§9.4) — and the first to sit directly on a surface from which a device can be jailed.

**Recommendation in one line: do not rewrite. Quarantine, extend, and freeze the four files as a versioned contract.** §8 gives the five highest-leverage next builds.

---

## 1. The stated goal, restated as a system contract

### 1.1 The pipeline, precisely

The owner's intent, restated as a pipeline with no interpretive slack:

```
INPUT        raw proxy log document (Elasticsearch, index per settings.elastic_index)
             fields carried by the deployment (docs/attck-mapping-spec.md:778-794):
               @timestamp, client_ip, server_ip, url, category, action,
               duration_seconds, bytes_downloaded, bytes_uploaded, http_status_code,
               country_code, rule_info, rule_name, user_id, host.ip, message

CLASSIFY     a document is CANDIDATE EVIDENCE when its url matches a block pattern
             (url_patterns.pattern_type='block'), and its url does not match a
             whitelist pattern (url_patterns.pattern_type='whitelist')
                 code: app/services/query_builder.py:32 (glob_to_regex)
                       app/services/result_processor.py:121-124 (filters)
             action sub-classifies the candidate:
                 ALLOW  -> REACH   : the client reached a prohibited destination
                 DENY   -> ATTEMPT : the proxy blocked it; the client tried anyway

EVIDENCE     the candidate is frozen as a row with its capture-time fields intact,
             deduplicated on (client_ip, url, log_timestamp)
                 table: findings (app/database.py:41-51)
                 key:   UNIQUE (client_ip, url, log_timestamp) (app/database.py:49)

DECISION     a human operator inspects the destination the row names and records a
             verdict. Concrete verdict states are specified in §6 Stage 2.

OUTPUT       four text files. This is the product's ENTIRE external interface:

             file                     consumed by        orientation   route
             -----------------------  -----------------  ------------  ------------------------------
             urls.txt                 proxy device,      DESTINATION   GET /api/blacklist/urls.txt
             ips.txt                  firewall device    DESTINATION   GET /api/blacklist/ips.txt
             jail-ips.txt             firewall device    SOURCE        GET /api/jaillist/ips.txt
             (same urls.txt/ips.txt   proxy + firewall   DESTINATION   regenerated on every mutation)
              regenerated)
```

### 1.2 The four files are the contract

State this as an architectural rule, because violating it is how the product drifted:

> **A feature earns its place only if it (a) improves the correctness of a row in `findings`, (b) improves the operator's ability to reach a verdict on a destination or a client, or (c) directly produces or validates one of the four feed files. Everything else is a lab experiment living in production.**

Under that rule:

- `urls.txt` and `ips.txt` are written from `blacklist_entries` only — `SELECT value FROM blacklist_entries WHERE kind = ? ORDER BY value` (`app/services/feeds.py:32-36`), atomically, CRLF-terminated with a trailing CRLF (`app/services/feeds.py:61`). Destination-oriented.
- `jail-ips.txt` is written from `jaillist_entries` only — `SELECT value FROM jaillist_entries ORDER BY value` (`app/services/feeds.py:74`). Source-oriented.
- All three are regenerated at startup (`app/main.py:68-69`) and after every mutation (`app/routes/blacklist.py:71-73`, `app/routes/jaillist.py:50-52`), so the DB is authoritative and the files are a projection.
- The routers that serve them are mounted **without** admin auth, deliberately, because external devices fetch them (`app/main.py:227-233`); read/write list routes opt back into `verify_admin` per-route (`app/routes/blacklist.py:49`, `app/routes/jaillist.py:30`).

Double blocking (a destination in both `urls.txt` and `ips.txt`, or a source in `jail-ips.txt` while the destination is also blocked) is expected and desirable. No deduplication or coordination across files should ever be added.

**A second, independent rule follows from the owner's position that logs are captured as evidence:**

> **No value displayed, exported, or placed in an alert may be synthesized, estimated, or derived through a proxy formula. Every value is either a persisted field or an explicit "unavailable".**

This rule is not stylistic. The product's output is used to issue a `client_ip` against a policy violation, which means every number on an evidence surface is potentially contested. The codebase already contains the correct pattern in two places — the `-` NOT-RECORDED sentinel, which carries a missing measurement as *absent* rather than as `0` (`app/services/logline.py:3-6`, `:29`), and `bytes_source = "none"`, which means "nothing present → UNKNOWN, not `0`" (`app/services/attck_mapping.py:648-651`). The failure to generalize that pattern is the subject of §9.4, and it is currently broken on Host Investigation (`app/routes/hosts.py:52-58`).

### 1.3 Explicit boundary — `rule_info` is never decoded

`rule_info` carries a comma-separated code set (observed value `"RN190,SNI,BS"`, `docs/attck-mapping-spec.md:783`). The repository contains no decoder, no enum, and no documentation for it (`docs/attck-mapping-spec.md:873-882`). The ATT&CK spec labels it the single highest-value handover item *if* a code table is supplied (`docs/attck-mapping-spec.md:1157-1159`).

**By owner decision, decoding is out of scope permanently.** `rule_info` is stored (`app/services/result_processor.py:105`, `app/database.py:144`) and displayed as opaque context. No predicate, score, verdict, or feed line may ever be derived from it. This boundary lives in §7 and in the new ADR in §3.5. The ATT&CK spec's "handover item 1" should be struck.

---

## 2. Goal alignment audit

Every nav item from `admin-ui/src/components/Sidebar.tsx:129-160`, every route module under `app/routes/`, and every service under `app/services/`. Verdicts: **KEEP** (serves the goal, invest), **QUARANTINE** (keep running, remove from the product surface, stop investing), **CUT** (delete).

### 2.1 Navigation items (`Sidebar.tsx:129-160`)

| Nav item | What it does | Serves the goal? | Verdict | Evidence |
|---|---|---|---|---|
| **Dashboard** | Aggregate metrics over the block-pattern window | Adjacent — aggregate risk counts, no per-client verdict path | KEEP, scoped | `Sidebar.tsx:133`; `app/routes/analytics.py` summary endpoints |
| **Query** | Single live/traffic surface; full stream incl. DENY, row inspection, Sankey, blacklist/whitelist badges | **Core** — this is where the operator sees a DENY attempt, which the owner says matters | KEEP | `Sidebar.tsx:134`; `app/routes/query.py:6`; `admin-ui/src/components/QueryPage.tsx:329-341` |
| **Host Investigation** | Per-IP profile: risk vs enforcement split, ranked URLs, risk level | **Core** — recidivism lives here; this is the client_ip surface | KEEP, extend | `Sidebar.tsx:140`; `app/routes/hosts.py:1-11`, `:24-49` |
| **URL Investigation** | Paste a URL → every client that hit it, whitelist/blacklist actions | **Core** — this is exactly the operator workflow ("manually checks the URL") | KEEP, extend to carry verdict | `Sidebar.tsx:141`; `app/routes/findings.py:196-321`; ADR 0002 `:16` |
| **Analytics** | Range-scoped trends, bandwidth, enforcements, top domains/clients, raw table | Adjacent — reporting, not decisioning; several sub-panels (bandwidth) are unrelated | QUARANTINE (sub-panels) | `Sidebar.tsx:142`; `app/routes/analytics.py:1-54` |
| **ATT&CK Coverage** | Fleet-wide technique aggregate over findings | **Unrelated** — see §9; produces no feed line and ≤2 LOW techniques on real data | CUT (from nav; QUARANTINE the code) | `Sidebar.tsx:143`; `app/routes/attck.py:56`; `docs/attck-mapping-spec.md:1062-1073` |
| **Patterns** | CRUD over `url_patterns` (block/whitelist globs) | **Core** — patterns define what becomes candidate evidence | KEEP | `Sidebar.tsx:149`; `app/routes/patterns.py:1-14` |
| **Findings** | Persisted evidence rows + row actions | **Core** — this is the evidence ledger | KEEP, extend (§6 Stage 1) | `Sidebar.tsx:150`; `app/routes/findings.py:528-565` |
| **Redirects** | Hop-by-hop HTTP checks of tracked URLs; **auto-blacklists every tracked host** with `source='redirect'` | Adjacent-to-core: the auto-blacklist write reaches `urls.txt`, but the HTTP crawl itself is a different product | QUARANTINE the crawler; KEEP the blacklist write path audit | `Sidebar.tsx:151`; `app/services/redirects.py:22-34`; `app/main.py:70-81` |
| **Blacklist** | `urls.txt` / `ips.txt` management + feed cards | **Core** — destination feed is a product output | KEEP | `Sidebar.tsx:152`; `app/routes/blacklist.py:24-46` |
| **Jaillist** | `jail-ips.txt` management; jail-a-client action from Findings | **Core** — source feed is a product output | KEEP, extend (§5) | `Sidebar.tsx:153`; `app/routes/jaillist.py:17-53`; ADR 0004 `:12-19` |
| **Logs** | `monitor_logs` audit trail: ES DSL, match counts, webhook outcome | Adjacent — operational health; but it is the only audit surface for pipeline correctness | KEEP | `Sidebar.tsx:158`; `app/routes/logs.py:25-59`; `app/database.py:229-253` |

### 2.2 Route modules (`app/routes/`)

| Module | What it does | Serves the goal? | Verdict | Evidence |
|---|---|---|---|---|
| `blacklist.py` | Public `urls.txt`/`ips.txt` + admin CRUD + upstream sync | **Core** | KEEP | `:24`, `:38`, `:58`, `:149` |
| `jaillist.py` | Public `jail-ips.txt` + admin CRUD + upstream sync | **Core** | KEEP | `:17`, `:37`, `:139` |
| `findings.py` | Evidence ledger: list, graph, per-URL/per-client breakdown, delete | **Core** | KEEP, extend | `:196`, `:324`, `:391`, `:528` |
| `query.py` | Live ES query surface (full stream + flagged) | **Core** | KEEP | `:6`, `:60` |
| `hosts.py` | Per-IP profile aggregation for Host Inspector | **Core** | KEEP, extend | `:1-49` |
| `patterns.py` | Block/whitelist pattern CRUD | **Core** | KEEP | `:1-12` |
| `monitor.py` | Status counters (pattern counts, ES state) | Adjacent | KEEP (trivial) | `:8-13` |
| `logs.py` | `monitor_logs` read/delete + webhook retry | Adjacent (operational) | KEEP | `:25`, `:62` |
| `backup.py` | JSON export/import of operator data | Adjacent (data safety) — but it is the only backup for the evidence ledger | KEEP | `:1-12` |
| `analytics.py` | Metrics/trends/aggregations; risk vs enforcements split; ES-or-findings fallback | Adjacent — reporting, several no-op params | QUARANTINE sub-panels | `:1-54`, `:383`, `:648` |
| `client_report.py` | Per-client findings-scoped report + CSV export | Adjacent — duplicates `hosts.py` framing over the same table | QUARANTINE (candidate merge with `hosts.py`) | `:1-16`, `:430-434` |
| `redirects.py` | Redirect crawl orchestration + tracked-URL CRUD | **Unrelated** to the goal (it is a crawler) | QUARANTINE; CUT the nav entry | `:12`, `:28-63`; `app/services/redirects.py:1-7` |
| `readout.py` | Ranked clients by weighted risk score | Adjacent — a second ranking model competing with `hosts.py` | QUARANTINE | `:8-18`; `app/services/readout.py:1-10` |
| `enrich.py` | DNS/RDAP/TLS/HTTP enrichment of hosts and URLs | Adjacent — **partially useful**: reverse DNS and RDAP org are genuine triage aids for an operator deciding "is this harmful?" | KEEP the triage use; CUT the rest | `:1-14`; `app/services/enrich.py:1-6` |
| `attck.py` | ATT&CK host/URL/fleet endpoints | **Unrelated** | CUT from nav; QUARANTINE endpoints | `:26`, `:42`, `:56` |
| `backup.py`, `auth.py`, `timezone.py` | Infrastructure (backup, session auth, display TZ) | Infrastructure — required | KEEP | `app/main.py:224-250` |

### 2.3 Services (`app/services/`)

| Service | What it does | Serves the goal? | Verdict | Evidence |
|---|---|---|---|---|
| `monitor.py` (800 ln) | Poll orchestrator: ES query → filter → store → webhook | **Core** — the only ingest path | KEEP, extend | `:604-734` |
| `query_builder.py` | Glob→regex, ES DSL, source projection | **Core** | KEEP | `:23-29`, `:32`, `:94` |
| `result_processor.py` | `apply_filters` (whitelist + action gate), `store_findings`, UI builders | **Core** — and the exact place the DENY loss occurs | KEEP, change §3 | `:71-125`, `:128-229` |
| `feeds.py` | Atomic CRLF writers for all three files | **Core** — the product's output layer | KEEP, freeze §7 | `:39-49`, `:52-61`, `:69-76` |
| `blacklist.py` | Normalize input → bare FQDN / IPv4 | **Core** | KEEP | `:11-35` |
| `jaillist.py` | Normalize input → single-host CIDR (`ip/32`, `ip/128`) | **Core** | KEEP | `:11-61` |
| `upstream_blacklist.py` | Periodic mirror of remote block lists, `source='upstream'`, prunable | **Core-adjacent** — an external block-list feed is a legitimate destination source | KEEP | `:1-13`, `:177-199` |
| `upstream_jaillist.py` | Periodic mirror of a remote jail list | Core-adjacent | KEEP | `:1-8` |
| `delivery.py` + `msteams.py` | n8n webhook + Teams Adaptive Card alerting | **Core** — the alert that starts the owner's workflow | KEEP | `delivery.py:1-6`, `:16`, `:35`; `msteams.py:1-6` |
| `logs.py` | `monitor_logs` audit writes + pruning | Adjacent (operational) | KEEP | `:1-6` |
| `es_fields.py` | Field inventory + UC-A/UC-B/COLLAPSED mode resolver | Adjacent — real value is the mode gate; the mode vocabulary only matters to ATT&CK | KEEP (minimal) | `:60`, `:164-196`, `:246-249` |
| `logline.py` | Raw-line recovery parser (positional fields, NOT-RECORDED sentinel) | Adjacent — it exists to serve ATT&CK's byte-share honesty | QUARANTINE | `:1-38` |
| `redirects.py` | Redirect chain crawler + `blacklist_tracked_hosts` | **Unrelated** as a crawler; the auto-blacklist call is a real feed writer | QUARANTINE crawler; audit the write | `:1-7`, `:22-34` |
| `attck_mapping.py` (1974 ln) | Technique heuristics over findings/ES | **Unrelated** | CUT from product; QUARANTINE code | `:1-40`; spec `:1062-1073` |
| `attck_fleet.py` (385 ln) | Fleet technique aggregate over findings | **Unrelated** | CUT from product | `:1-37` |
| `readout.py` (594 ln) | Alternate client risk ranking with env-tunable weights | Adjacent — second, competing risk model | QUARANTINE | `:1-10`, `:169-198` |
| `enrich.py` (771 ln) | DNS/RDAP/TLS/HTTP lookups | Adjacent — triage aid only | KEEP (triage subset) | `:1-6` |
| `seed.py` | Seeds default block patterns incl. `*porn*`, `*bokep*`, `*nonton*` | **Core** — the initial pattern set is the product's premise | KEEP | `:1-8` |
| `timeutil.py` | Operator-timezone conversions | Adjacent (display) | KEEP | `:1-6` |

### 2.4 The headline audit finding

Nine of the eleven nav entries are KEEP or KEEP-with-scoping. **The drift is concentrated in four surfaces**: ATT&CK (nav + 2 services + 1 route + 2 UI pages), Redirects (nav + route + service), the second risk-ranking model (`readout.py`), and the reporting duplication (`analytics.py` vs `client_report.py`). That is a quarantine problem, not a rewrite problem.

---

## 3. Does the risk model need to change? — ADR 0001 challenged

### 3.1 The tension, stated precisely

| Source | Claim |
|---|---|
| `docs/adr/0001-risk-definition.md:12` | "**Risk = a request whose URL matched a block pattern, with proxy action `ALLOW`, and that is not whitelisted.**" |
| `docs/adr/0001-risk-definition.md:14` | "`DENY` is **not** a risk — the proxy enforced the policy; the request was handled. Denied requests are reported separately as **'Enforcements (handled)'**." |
| `CONTEXT.md:12` | "**Not risk** = **DENY** (the proxy already enforced it — 'handled')" |
| `CONTEXT.md:40` | "`enforcement` — a DENY … *not* a risk" |
| **Owner (verbatim intent)** | *"why the DENY is not really necessary but worth keeping — **we want to know who is trying to access it even after the site is blocked in proxy device**."* |

The conflict is not about whether DENY is *risk*. The owner agrees it is not. The conflict is about whether DENY is **evidence**, and ADR 0001 quietly answers "no" by not persisting it.

The ADR's own framing reveals the gap: it says DENY is "handled". But the owner's question is *who tried*. A "handled" enforcement is, in the owner's terms, a **detection of intent by an identified source** — the exact artifact he wants to keep and to escalate from.

### 3.2 The consequence in code

The loss is mechanical and total:

- `apply_filters` defaults to `actions=("ALLOW",)` — `app/services/result_processor.py:76`.
- `fetch_logs` calls it with the default — `app/services/monitor.py:652`.
- `store_findings` is therefore only ever handed ALLOW rows — `app/services/result_processor.py:128`.
- `analytics.py` documents the resulting hole explicitly: *"The persisted `findings` table only ever contains ALLOW rows (the poll stores through `apply_filters(actions=("ALLOW",))`), so real enforcement counts only exist in the live Elasticsearch window"* — `app/routes/analytics.py:6-8`.
- Enforcement data therefore **evaporates when the ES window rolls over**. `GET /api/analytics/enforcements` prefers live ES and falls back to `enforcements = 0` — `app/routes/analytics.py:648-653`, `:914-921`.
- The Owner's stated desire — "who is trying to access it **even after** the site is blocked" — is precisely a claim about history, and history is exactly what is not stored.

This is the single highest-severity finding in this review. The product discards the one signal the owner asked to keep, and then builds a fallback ladder (`readout.py` sqlite/es/auto, `analytics.py` ES-or-findings) to compensate for the hole it created.

### 3.3 Recommendation: YES — DENY becomes first-class intent evidence

Adopt the REACH / ATTEMPT model:

| Concept | Action | Meaning | Priority | Evidence table row? |
|---|---|---|---|---|
| **REACH** | `ALLOW` | The client reached a prohibited destination. Policy failed at enforcement. | **P1** — always outranks ATTEMPT for the same `(client_ip, base_url)` | Yes |
| **ATTEMPT** | `DENY` | The client tried; the proxy blocked it. No content reached the client. | **P2** — never below "not risk"; it is *intent evidence* | Yes |
| **WHITELISTED** | either | Explicitly allowed by the operator. | Not evidence | No (visible in Query only) |

Non-negotiable rules:

1. **REACH outranks ATTEMPT for the same `(client_ip, base_url)`.** A client that both reached and attempted the same destination is a REACH case. This preserves ADR 0001's correct instinct that reaching is worse than being blocked.
2. **ATTEMPT is evidence of intent, not of exposure.** Its severity is capped below REACH forever. It drives the *jaillist* and the alert, never the blacklist-on-its-own.
3. **ATTEMPT > 0 with REACH = 0 is a real finding.** It is the owner's "trying even after blocked" case, and it is the strongest available recidivism signal (§5).
4. **Whitelisting still removes a row from both classes** — `apply_filters`' whitelist branch (`app/services/result_processor.py:121-122`) is untouched in behaviour.
5. **The existing dedupe key stands.** `UNIQUE (client_ip, url, log_timestamp)` (`app/database.py:49`) already allows both an ALLOW and a DENY row for the same client+URL in the same second, because they are different documents with different timestamps; if the proxy ever emits both actions with an identical timestamp, the action must be added to the key. **This is an open risk to verify against the real index.**

### 3.4 Exact changes required

**`apply_filters` (`app/services/result_processor.py:71-125`):** do not change the function. Change the *call site*. The `actions` parameter is already correct as a mechanism (its docstring at `:83-85` documents `actions=None` as "keep every row"). The fix is at the ingest call:

- `app/services/monitor.py:652` — the poll calls `apply_filters(df, whitelist_regex)`, inheriting `actions=("ALLOW",)`. Change to `actions=("ALLOW", "DENY")` (never `None`, which would also admit `FLAG` and any future unknown value).
- Add a derived column at store time: `intent ∈ ("REACH", "ATTEMPT")` computed from `action`, persisted into `findings`. `findings.action` already exists (`app/database.py:125-128`), so this can be a derived read rather than a new column; a stored column is preferable for index-based escalation queries in §5.

**Every consumer of `action` must be audited.** The ones that are correct-by-construction today and stay correct:

| Consumer | Current behaviour | After change |
|---|---|---|
| `app/routes/analytics.py:151-163` `_row_is_risk` | `action == "ALLOW"` → risk; `DENY`/`FLAG` → enforcement | Correct as-is; now it reads persisted DENY rows instead of an empty set |
| `app/routes/client_report.py:74-87` | same split | Correct as-is |
| `app/routes/hosts.py:124-137` | `risk_requests = ALLOW`, `enforcements = DENY` | Correct as-is; now populated from the DB in the offline path |
| `app/routes/query.py` + `QueryPage.tsx:77-80` | client-side ALLOW/DENY filter over live rows | Correct as-is |
| `admin-ui/src/lib/logRow.ts:54-57` | action → badge variant | Correct as-is |
| `admin-ui/src/api.ts:1552-1554` | comment "Findings store ALLOW risk rows only (ADR 0001) — … enforcements are 0 from this source" | **Comment becomes false**; the derived `riskRequests`/`enforcements` split at `:1551-1558` must be updated |
| `admin-ui/src/components/AnalyticsPage.tsx:755` | renders "Findings are ALLOW risk rows only (ADR 0001)" | **Copy becomes false**; must change |
| `app/services/attck_fleet.py:284-287` | `SUM(CASE WHEN action IN ('ALLOW','') …)` | Quarantined with ATT&CK (§9); no work |

**Tests that assume ALLOW-only.** These were verified by search and will need updating:

| Test | Assertion that breaks |
|---|---|
| `tests/test_monitor_patterns.py:225-233` | "Default keeps the old ALLOW-only behaviour" — explicit assertion on the default |
| `tests/test_monitor_patterns.py:196-208` | "pins whitelist exclusion + ALLOW filtering end to end" |
| `tests/test_analytics.py:3-7` | module docstring: "The findings table only ever holds ALLOW rows in production" |
| `tests/test_analytics.py:89-91` | `totalRisk == 2`, `totalEnforcements == 2` from a hand-seeded table (seeding still works; the *production claim* in the docstring is what changes) |
| `tests/test_logs.py:396-438` | `test_query_run_returns_allow_and_deny` — asserts the Query page sees both; still passes, and becomes the template for the new poll test |
| `tests/test_readout.py:228-445` | seeds `ALLOW` fixtures only |
| `tests/test_attck_fleet.py:87-160` | quarantined with ATT&CK |

The change is additive for every reader and breaking for exactly one writer plus one docstring-level production claim.

### 3.5 ADR 0001 should be SUPERSEDED

Do not amend it. `docs/adr/0001-risk-definition.md:12` is a complete, coherent, wrong-for-now definition, and its reasoning ("the proxy already stopped it" ≠ "the user reached a prohibited site", `:8`) remains valid. What changed is the owner's requirement: risk was never the only thing that mattered, and the ADR silently turned "not risk" into "not stored". Add `docs/adr/0005-intent-evidence.md` and mark 0001 superseded.

**Draft Decision section for ADR 0005:**

> ## Decision
>
> **Evidence = a request whose URL matched a block pattern and is not whitelisted. Every such request is persisted, regardless of proxy action.**
>
> - `action` classifies evidence into **intent**, not into "risk" vs "not risk":
>   - **`REACH`** — `action = ALLOW`. The client reached a prohibited destination. Severity **P1**.
>   - **`ATTEMPT`** — `action = DENY`. The proxy blocked the request before any content reached the client. Severity **P2**.
> - **`REACH` outranks `ATTEMPT` for the same `(client_ip, base_url)`.** A client that reached a destination is a REACH case whatever else it attempted.
> - **`ATTEMPT` is evidence of intent toward an identified `client_ip`.** It is never counted as exposure and never as a block-list candidacy on its own; it is jaillist candidacy and alert priority only.
> - `FLAG` remains absent from the proxy data and is still ignored (`CONTEXT.md:13`).
> - **Whitelisted URLs are excluded from evidence entirely**, unchanged from ADR 0001. They remain visible in the raw stream (Query).
> - The persisted `findings` table is the **evidence ledger** and stores both intents. The poll calls `apply_filters(..., actions=("ALLOW", "DENY"))`.
> - The plain-text feeds are unchanged by this ADR: `urls.txt`/`ips.txt` are destination block lists; `jail-ips.txt` is a source block list. Intent classification affects the *decision* to write them, never their format.
> - `rule_info` (the proxy's rule numbering) is **never decoded** and no intent, severity, or feed line may be derived from it.
>
> ## Consequences
>
> - The persisted evidence ledger is now the authoritative source for enforcement counts; `analytics.enforcements` (`app/routes/analytics.py:648`) no longer degrades to zero when Elasticsearch is offline.
> - The "Enforcements (handled)" label survives as a count, but is reframed: an enforcement is a *recorded attempt by an identified client*, not a discarded non-event.
> - Every consumer that assumed an ALLOW-only `findings` table must be reviewed: `app/routes/analytics.py:6-8`, `app/routes/client_report.py:9-10`, `admin-ui/src/api.ts:1551-1558`, `admin-ui/src/components/AnalyticsPage.tsx:755`.
> - `ADR 0001` is superseded. The definition of *risk* it established (REACH) survives verbatim as the P1 class.
> - Existing ALLOW-only rows remain valid REACH evidence; no migration of intent is required beyond `action=''` legacy rows, which are treated as REACH (the current behaviour at `app/services/analytics.py:154-156`).

---

## 4. The unauthenticated-traffic dimension

### 4.1 What the repo actually says

`app/services/logline.py:25` documents the raw-line grammar's second slot:

```
slot  0  client_ip
slot  1  user_id        (an IP when the request is unauthenticated)
```

That grammar is authoritative for the operator's format: it was written from a verbatim document the operator supplied (`docs/attck-mapping-spec.md:778-794`, reproduced below):

```json
"user_id": "172.21.122.6",
"client_ip": "172.21.122.6",
```

**In the observed document, `user_id` is character-for-character identical to `client_ip`.** The ATT&CK spec reached the same conclusion independently and reversed its earlier reading:

- `docs/attck-mapping-spec.md:803-810` — "In the sample, `user_id == client_ip == '172.21.122.6'`, character-for-character."
- `docs/attck-mapping-spec.md:812-813` — "In this deployment `user_id` is a **second spelling of `client_ip`**, not an identity lens."
- `docs/attck-mapping-spec.md:1146` — correction #1: "`user_id` is a **`client_ip` alias** here; context-only".

The app already surfaces it, and already describes it with the right words, in exactly one place — `admin-ui/src/components/EventInspectorSidebar.tsx:236-240`:

> label: `User ID (proxy)` — title: *"The proxy's user slot — carries the client IP when there is no authenticated user."*

That title is a correct statement of the grammar. It is not verified against the index.

### 4.2 Is "unauthenticated traffic" detectable? — the honest answer

**Not from this repository, and not reliably from the field as currently written.** Three separate problems:

1. **The grammar's parenthetical is a hypothesis about the format, not an observed invariant.** `app/services/logline.py:25` is a comment in a parser; the parser does not act on it. There is no code anywhere that compares `user_id` to `client_ip` or derives an authentication state. Grep for `unauth` across `app/` and `admin-ui/src` returns nothing.
2. **The observed document is consistent with two opposite readings.** `user_id == client_ip` is exactly what you see when (a) the request is unauthenticated and the proxy falls back to the source IP, **or** (b) the proxy is deployed in a mode where no user-auth integration exists at all and the slot is simply never populated with a principal. The document set is one line. It cannot distinguish them.
3. **Authenticated user identity is explicitly out of scope for the product.** `CONTEXT.md:45` — "`host` — an IP + optional hostname; no dept/user/MAC identity". ADR 0002 `:19` — "no IP→person/department/MAC attribution anywhere". `docs/attck-mapping-spec.md:1160-1161` records that `username`/`session` do not exist in the schema and are on a "fields to request" list.

### 4.3 Conclusion: the "unauthenticated" dimension is NOT detectable from this data

**State the strongest form of the finding, because it is stronger than "unvalidated".** `user_id == client_ip` for every observed row (`docs/attck-mapping-spec.md:803-806`, `:812-813`; corroborated by the second fixture at `tests/test_patterns.py:802`). Therefore any test of the form *"is `user_id` an IP?"* is **trivially true for 100% of rows**. Such a test has **zero discriminating power**: it cannot separate authenticated from unauthenticated traffic because it separates nothing from anything. This is not a heuristic that needs validation on the owner's index — it is **structurally incapable of discriminating**, whatever the index contains. A heuristic with a constant output is not a weak signal; it is the absence of one.

**Therefore: the "unauthenticated" dimension in the owner's goal is NOT detectable from this data, and the product is IP-only for enforcement purposes.** Say this plainly and stop. "Unauthenticated traffic" and "traffic" are the same set here. The owner's goal sentence — "detect unauthenticated traffic that accessed prohibited sites, and capture the `client_ip`" — is **fully satisfied by the pipeline in §1 without any authentication dimension at all**, because `client_ip` is the only identity this deployment carries.

The only sound reading of the goal's word "unauthenticated" is the one the deployment actually supports: the traffic is unauthenticated *by nature*, which is precisely why `client_ip` is the enforcement key. Do not attempt to recover a distinction that does not exist.

**Note on the parallel review.** A sibling document (`docs/raw-data-capability-inventory.md` §2.1, §3 item 2) reaches the same conclusion by a shorter route. One draft of its §3 item 2 retained the reasoning "parses as an IP is a candidate signal" — reasoning from the grammar comment alone. That framing is **superseded**: the alias identity was already settled from a verbatim real document (`docs/attck-mapping-spec.md:803-813`), which the grammar comment alone does not reveal. §4.1 above is the correct reading; the grammar at `app/services/logline.py:25` describes a *format capability* the proxy has, not a fact about this deployment's data.

**Confirm before ever revisiting — not dependencies for a design.** These are demoted from blockers to a checklist that must be answered *before anyone proposes reopening this dimension*:

1. Does `user_id` ever contain a value that is **not** an IP and **not** equal to `client_ip`? (If never — as the evidence indicates — the dimension is not merely uniform but structurally absent.)
2. Is `username` or `session` ever present in the index? (`docs/attck-mapping-spec.md:1004-1027` says no, which is why the deployment is permanently `COLLAPSED`; if either appears, this entire section is void and UC-A/UC-B unlock — `docs/field-sample-report.md:76-81`.)
3. Is the proxy configured with any user-identity integration today?

Until (1) is answered with measured evidence, **build nothing** on this dimension. No filter, no label, no column, no alert field. If (1) is answered "no" as expected, close the question permanently and record it in `CONTEXT.md` so it is not reopened by a future contributor reading the grammar comment.


---

## 5. The repeat-offender / escalation model

### 5.1 What data actually exists

Ground every input in a real field. No invented data.

| Input | Source field | Exists? | Evidence |
|---|---|---|---|
| Client identity | `findings.client_ip` | Yes | `app/database.py:43` |
| Destination | `findings.base_url` (derived, port-stripped) | Yes | `app/database.py:46`; derivation at `app/services/result_processor.py:117-120` |
| Full URL | `findings.url` | Yes | `app/database.py:45` |
| Event time | `findings.log_timestamp` | Yes | `app/database.py:47` |
| Intent | `findings.action` (`ALLOW`/`DENY`) | Yes, currently ALLOW-only — fixed by §3 | `app/database.py:125-128` |
| Which policy class fired | `findings.matched_patterns` (JSON array) | Yes | `app/database.py:62-65`; `app/services/result_processor.py:156` |
| Destination already blocked? | `blacklist_entries` membership | Yes | `app/database.py:169-179` |
| Client already jailed? | `jaillist_entries` membership | Yes | `app/database.py:184-193` |
| Byte volume (per event) | `findings.bytes_downloaded` / `bytes_uploaded` | Yes, but **near-vacuous on DENY** — download is always 0 | `docs/attck-mapping-spec.md:911-928` |
| Proxy node that saw it | `host.ip` (not persisted to `findings`) | Present in ES, **not in the DB** | `docs/attck-mapping-spec.md:970-981` |
| MAC address | — | **Does not exist. Do not design for it.** | `CONTEXT.md:45` |

**Do not use `duration_seconds` for any escalation.** It is `0.01` on real traffic and the `×8192` byte proxy overstates by 38× (`docs/attck-mapping-spec.md:943-968`). This review found that bug pattern already caused one shipped defect; do not reintroduce it in the escalation layer.

### 5.2 The escalation model

**Two candidacy queues, not one.** The rules below divide by which side of the traffic they act on, and the two sides write **different artifacts**. State this before the table because it is the structural point, and §6 Stage 2's verdict states depend on it:

| Queue | Question it answers | Signal | Artifact |
|---|---|---|---|
| **Source-side** (client candidacy) | Which `client_ip` should be jailed? | One client misbehaving across destinations | `jail-ips.txt` ← `POST /api/jaillist/` |
| **Destination-side** (blacklist candidacy) | Which `base_url`/host should be blocked for everyone? | One destination attracting misbehaviour from many clients | `urls.txt` (and `ips.txt` for IP destinations) ← `POST /api/blacklist/` |

These queues are independent. A destination can be blacklisted because many clients reached it (R6) while none of those clients is jailed; a client can be jailed for reaching destinations that are not blacklisted at all (R1/R3). Neither implies the other, and neither artifact may substitute for the other.

**Definition — a repeat offender is a `client_ip` whose evidence ledger, over a rolling window, satisfies *any* of the source-side rules below; a repeat destination is a `base_url` satisfying the destination-side rule.**

| Rule | Side | Condition | Computed from | Why this rule |
|---|---|---|---|---|
| **R1 — Volume** | Source | ≥ 3 distinct REACH events to ≥ 2 distinct `base_url` | `COUNT(DISTINCT url)`, `COUNT(DISTINCT base_url)` where `action='ALLOW'` | One blocked-then-reached porn site can be a mistyped URL; three across two domains is a habit |
| **R2 — Persistence** | Source | ≥ 1 REACH **and** ≥ 3 ATTEMPT to the *same* `base_url` | `action` split per `base_url` | **The owner's exact stated case**: the destination is already blocked and the client keeps trying anyway |
| **R3 — Recidivism** | Source | ≥ 2 REACH events on ≥ 2 distinct **local calendar days** | `findings.log_timestamp` bucketed by `Settings.display_tz` via `app/services/timeutil.py:1-6` | Same-day bursts are one incident; two days is a pattern |
| **R4 — Class breadth** | Source | `matched_patterns` (flattened) matches ≥ 2 distinct policy classes | `findings.matched_patterns` | One category can be a false-positive pattern; two categories is intent |
| **R5 — Blocked-then-reached** | Source | ≥ 1 REACH where `base_url` is in `blacklist_entries` | `findings` ⋈ `blacklist_entries` | The proxy's enforcement was defeated; already implemented as a per-host HIGH escalation at `app/routes/hosts.py:47-48` |
| **R6 — Destination consensus** | **Destination** | ≥ N distinct REACH clients to the same `base_url` in the window (propose N=3) | `COUNT(DISTINCT client_ip)` grouped by `base_url` where `action='ALLOW'` | **The correct ranking for a policy-violation tool.** Independently, several devices reaching the same host is evidence about the *destination*, not about any one device |

**R6 must not be mixed into the source-side queue.** Its product is a **blacklist suggestion** — "host X was reached by 5 distinct clients in 30 days; block it?" — with a one-click action wired to `POST /api/blacklist/` (`app/routes/blacklist.py:58`). Its artifact is a `urls.txt` line, never a `jail-ips.txt` line. R1–R5 produce source-side suggestions writing `jail-ips.txt`. §6 Stage 2 already separates these as `HARMFUL_DESTINATION` vs `HARMFUL_SOURCE`; §5 must say the same or the model cannot state which file to write.

**The existing destination ranking answers a different question.** Destination aggregation already exists (`app/routes/analytics.py:420-453`) but ranks by volume/bytes — "where is the traffic?" — not by distinct violating client count — "what is attracting many violators?". For a policy tool the second is the correct ranking and it is not implemented today (`docs/raw-data-capability-inventory.md` §3 item 4). R6 is that ranking, scoped to evidence rows rather than to all traffic.

**Window:** default **30 days**, configurable, evaluated over the persisted ledger — not over the live ES window.

**R2 is INOPERABLE until build #1 ships, and every poll interval in the meantime permanently destroys evidence.** This is not a footnote; it is the urgency argument for build #1. R2 reads `action='DENY'` rows, and no DENY row is persisted today: the poll calls `apply_filters(...)` with the default `actions=("ALLOW",)` (`app/services/result_processor.py:76`, used at `app/services/monitor.py:652`). The consequence is not a degraded R2 — it is **history that cannot be backfilled**, because the only other source is the live Elasticsearch window and that window rolls over. This is the identical evaporation already documented at `app/routes/analytics.py:6-8`: enforcement counts "only exist in the live Elasticsearch window", and when it passes they are gone. Every day build #1 is not shipped, that day's R2 history is destroyed and no later migration can recover it. R2 encodes the owner's own stated case; it is currently uncomputable, and the data that would compute it is being discarded in real time.

**Conjunction — three outcomes, not one:**

- **Any single rule firing is an escalation** — the client or the destination appears in its queue.
- **Source-side jaillist candidacy requires R5, or R2, or ≥ 2 source-side rules.** A single R1 alone is a habit worth watching, not a device worth jailing.
- **Destination-side blacklist candidacy requires R6 alone.** R6 is already a consensus signal; demanding a conjunction would defeat its purpose.

Do not auto-jail and do not auto-blacklist. See §5.4 and §9.8.

**Products of the model** — exactly four, no more:

1. **A priority on the alert** — `P1` (any R5, or ≥2 rules, or R6 with a large distinct-client count), `P2` (one rule), `P3` (single event). Consumed by `app/services/delivery.py:35` / `app/services/msteams.py:35`, so the operator's triage order is computed rather than guessed.
2. **Source-side jaillist candidacy** — a queued suggestion on the Findings and Host pages: "this client has 7 REACH events across 3 domains in 30 days — jail?" One click calls `POST /api/jaillist/` (`app/routes/jaillist.py:37`) carrying `finding_id` (already supported: `app/routes/jaillist.py:45-47`), writing `jail-ips.txt`.
3. **Destination-side blacklist candidacy** — a queued suggestion on the URL Investigation page and in a new Destinations queue: "this host was reached by 5 distinct clients in 30 days — block it?" One click calls `POST /api/blacklist/` (`app/routes/blacklist.py:58`), writing `urls.txt`.
4. **A recidivism count on the host profile** — one integer on `GET /api/hosts/{ip}` (`app/routes/hosts.py:61`).

**What the model must NOT produce:** an automatic jaillist or blacklist write. Jailing a static-IP device is an operational event with real human cost, and a blacklist line is enforced by two devices at once. ADR 0004 `:25` already ruled the jail feed "enforcement-intent only"; keep the human in the loop and make the suggestion loud.

### 5.3 Where it lands in code

- **NEW**: `app/services/escalation.py` — pure functions over the `findings` table. Mirrors the shape of `app/services/readout.py` (`:85-198`) but with the R1–R6 rules instead of env-weighted pattern scores. Two SQL queries, not per-entity ones: one `GROUP BY client_ip` for R1–R5 and one `GROUP BY base_url` for R6.
- **REUSED**: `app/services/timeutil.py:1-6` for local-day bucketing (R3), `app/services/readout.py:128-134` for the `matched_patterns` JSON parse idiom, `app/routes/analytics.py:420-453` for the destination `GROUP BY base_url` shape — re-pointed from volume ordering to `COUNT(DISTINCT client_ip)` ordering (R6).
- **EXTENDED**: `app/routes/hosts.py:61` (add the source-side count and the R2 persistence count); `app/routes/findings.py:196` (URL Investigation) for the destination-side R6 suggestion. `app/routes/attck.py` is **not** the place — do not put this in the quarantined engine.
- **REPLACES**: `app/services/readout.py`'s env-tuned `compute_risk` (`:169-176`). Two competing risk scores is exactly the "collapsed development" symptom. R1–R6 is grounded in the owner's rules; `RISK_WEIGHT_*` env weights are not.

---

## 6. Target architecture — the revamp, without a rewrite

### Stage 0 — Stop the bleed (do this week; touches no logic)

**Goal:** the sidebar reads as one product with one purpose.

| Action | Exact change | Code touched |
|---|---|---|
| Remove ATT&CK from nav | Delete `{ view: "attck-fleet", label: "ATT&CK Coverage", icon: ShieldAlert }` at `admin-ui/src/components/Sidebar.tsx:143` | One line |
| Remove Redirects from nav | Delete `{ view: "redirects", label: "Redirects", icon: GitBranch }` at `Sidebar.tsx:151` | One line |
| Remove Analytics sub-panels that do not decision anything | Bandwidth and top-domains panels on `AnalyticsPage.tsx` | UI only |
| Keep the `View` union and stored-view allowlist intact | `admin-ui/src/App.tsx:97` lists `"attck-fleet"` and `"redirects"`; leave it so deep links and stored localStorage views do not 404 | One list, unchanged |
| Keep every route mounted | `app/main.py:234`, `:238` — untouched | — |

**What stays untouched in Stage 0:** every backend service, every route, every table, the `AttckFleetPage.tsx` and `RedirectsPage.tsx` components, `app/services/redirects.py` (including its auto-blacklist write at `:22-34`, which is a real feed writer and must not silently stop), and the daily redirect scheduler job (`app/main.py:98-102`).

**Why quarantine rather than delete:** the ATT&CK engine is 2359 lines of tested, honest, field-gated code (`app/services/attck_mapping.py` + `attck_fleet.py`, plus `tests/test_attck_mapping.py`, `tests/test_attck_fleet.py`). It is not wrong; it is aimed at a different question. Deleting it destroys salvageable value (the field-availability gate in `es_fields.py` is genuinely useful and is used by `hosts.py:81`) and costs a week of git archaeology if the owner ever revisits it. Hiding it costs one line.

**Acceptance criterion:** the sidebar contains exactly Monitor (Dashboard, Query), Deep Dive (Host Investigation, URL Investigation, Analytics), Management (Patterns, Findings, Blacklist, Jaillist), System (Logs). No dead nav entry, no broken deep link, `npm run build` clean.

### Stage 1 — The evidence spine

**Goal:** every row in `findings` is usable as evidence without qualification.

**What must be true for a row to be evidence:**

| Property | Requirement | Status |
|---|---|---|
| **Complete** | Carries `client_ip`, `url`, `base_url`, `log_timestamp`, `action`, `server_ip`, `matched_patterns`, `rule_info`, `user_id`, `category`, `duration_seconds` | **Already true** — `app/services/result_processor.py:164-188` writes all of them |
| **Frozen at capture** | The fields above are written once and never recomputed | **Already true** — `INSERT OR IGNORE` (`app/services/result_processor.py:225`); the startup backfill at `app/database.py:73-110` is the one exception and only touches the legacy `'[]'` sentinel |
| **Deduplicated** | `(client_ip, url, log_timestamp)` | **Already true** — `app/database.py:49` |
| **Intent-classified** | `action` distinguishes REACH from ATTEMPT, both persisted | **BROKEN** — §3, the required fix |
| **Auditable** | A row can be traced to the poll that produced it and to the ES DSL used | **Already true** — `monitor_logs.es_query`, `.matches`, `.filtered`, `.stored` (`app/database.py:229-253`), written at `app/services/monitor.py:733` |
| **Immutable after capture** | No update path exists for findings except the legacy backfill | **Already true** — the only writes are the insert (`:225`) and the deletes (`app/routes/findings.py:499`, `:513`, `:522`) |
| **Not fabricated** | Every value displayed, exported, or alerted is either a persisted field or an explicit "unavailable" — never synthesized, estimated, or derived through a proxy formula | **BROKEN** — `app/routes/hosts.py:52-58` fabricates a bandwidth figure from a request count, and `admin-ui/src/api.ts:1530-1537` duplicates it client-side. See §1.2 and §9.4 |

**This stage is 90% done.** The evidence spine exists; it has exactly two holes — the ALLOW-only gate and fabricated display values — plus one structural weakness: the findings table has no notion of *which finding was actioned*, the link the owner needs from a verdict back to the row that caused it.

**NEW:**
- A derived `intent` value (`REACH`/`ATTEMPT`) with an index on `(client_ip, intent, log_timestamp)` — the query shape §5 needs.
- The evidence anchor. `docs/specs/blacklist-metadata.md:474-485` documents that `blacklist_entries.finding_id` exists (`app/database.py:175`), is accepted by the API (`app/models.py:56`), and is populated by **no caller**. The jaillist has the same dead column (`app/database.py:189`, `app/models.py:94`). Wiring the Findings row action to send `finding_id` (the UI call at `admin-ui/src/api.ts:1267-1275` currently sends `{ value }` only) is the single change that makes the whole decision loop auditable.
- An honest bandwidth figure, or none. Delete `_synthesize_bandwidth` (`app/routes/hosts.py:52-58`) and its client-side twin (`admin-ui/src/api.ts:1530-1537`), and render measured bytes from the persisted `bytes_downloaded`/`bytes_uploaded` columns — which the evidence row already carries (`app/database.py:142-143`, written at `app/services/result_processor.py:167-168`) — with `"—"` where no measurement exists. `app/routes/hosts.py:198` currently calls the fabricator.

**REUSED:** the `findings` table and its constraints (`app/database.py:41-51`), `store_findings` (`app/services/result_processor.py:128`), the `monitor_logs` audit trail (`app/database.py:229-253`), the backup section machinery (`app/routes/backup.py:1-12`).

**DELETED:** nothing in this stage.

**Order:** (1) the `actions=("ALLOW","DENY")` change at `app/services/monitor.py:652`; (2) the `intent` column + index; (3) delete the two bandwidth fabricators; (4) `finding_id` write-back from the Findings row action. Do (1) first — it is one argument, and every later stage depends on ATTEMPT rows existing. Do (3) early: it is a deletion, and until it lands the surface §5 operates on displays an invented number.

**Acceptance criterion:** after one poll interval with a DENY-producing pattern, `SELECT action, COUNT(*) FROM findings GROUP BY action` returns both values, and `GET /api/analytics/enforcements` returns non-zero with Elasticsearch stopped. **Plus:** `grep` for `synthesize` across `app/` and `admin-ui/src/` returns no producer, and every bandwidth string rendered in Host Investigation comes from a persisted byte column or reads `"—"`.

### Stage 2 — The decision workflow (this is the loop the owner described)

**Goal:** close the loop from alert to feed.

```
ALERT        poll matches block pattern → evidence row persisted → teams/n8n card
             (app/services/monitor.py:720-724 → app/services/delivery.py:35)
             card carries: client_ip, url, base_url, intent, rule_info (opaque),
                            recidivism count (§5), one-click deep links
   ↓
TRIAGE       operator opens URL Investigation (app/routes/findings.py:196) and
             Host Investigation (app/routes/hosts.py:61) for the row
   ↓
VERDICT      four states, each with exactly one artifact:
   ↓
   ┌────────────────────────┬──────────────────────────────────────────────────┐
   │ VERDICT                │ ARTIFACT (and only this)                         │
   ├────────────────────────┼──────────────────────────────────────────────────┤
   │ HARMFUL_DESTINATION    │ POST /api/blacklist/ → normalize_blacklist_value │
   │                        │ → blacklist_entries (kind='url') → urls.txt      │
   │                        │ (app/routes/blacklist.py:58; feeds.py:52)        │
   ├────────────────────────┼──────────────────────────────────────────────────┤
   │ HARMFUL_SOURCE         │ POST /api/jaillist/ → normalize_jaillist_value   │
   │                        │ → jaillist_entries → jail-ips.txt                │
   │                        │ (app/routes/jaillist.py:37; feeds.py:69)         │
   ├────────────────────────┼──────────────────────────────────────────────────┤
   │ NOT_HARMFUL            │ whitelist pattern → url_patterns                 │
   │                        │ (pattern_type='whitelist') → removes the         │
   │                        │ destination from ALL future evidence             │
   │                        │ (app/routes/patterns.py; result_processor.py:121)│
   ├────────────────────────┼──────────────────────────────────────────────────┤
   │ INCONCLUSIVE           │ no artifact. Row stays in the ledger with no     │
   │                        │ verdict recorded — distinct from NOT_HARMFUL.    │
   └────────────────────────┴──────────────────────────────────────────────────┘
   ↓
WRITE-BACK   the verdict is recorded on the blacklist block-event row with the
             full URL and the finding_id (docs/specs/blacklist-metadata.md:199)
   ↓
FEED         every write regenerates the file atomically
             (app/routes/blacklist.py:71-73; app/routes/jaillist.py:50-52)
```

**Why four states and not three.** The owner described three actions ("if genuinely harmful → blacklist; if not → whitelist; maybe"). The "maybe" is the important one: an operator who cannot record "I looked and I genuinely don't know" will either whitelist something harmful or leave the row ambiguous. INCONCLUSIVE must be a first-class stored value that resolves nothing.

**Verdict storage.** `docs/specs/blacklist-metadata.md` already designs the table that carries the harmful cases: `blacklist_events(id, kind, value, source, finding_id, url, category, note, created_at)` (`:199`), append-only, one row per block, with the operator's free-text reasoning and the evidence anchor (`:221-242`). **Note this table does not exist yet** — grep confirms `blacklist_events` appears in no source file; the spec is unimplemented. Implement it as designed. It is the correct store for HARMFUL_DESTINATION and carries the audit trail Stage 1 asks for.

**The one gap in that spec:** it has no state for NOT_HARMFUL or INCONCLUSIVE. Add a `verdict TEXT` column to `blacklist_events` (or a sibling `triage_events` table) with the four states above, and emit a whitelist pattern write for NOT_HARMFUL. The spec's own honesty rule supports this — `docs/specs/blacklist-metadata.md:757-761` requires the app never to assert a judgement the operator has not made, and INCONCLUSIVE is the state that makes that rule enforceable.

**How this closes the owner's loop.** Today: an alert fires, the operator investigates the URL manually, and the conclusion is written nowhere (`docs/specs/blacklist-metadata.md:12-25`). Next week, the same URL is investigated again by the same or a different operator. After Stage 2: the alert carries the client and the URL; the operator's verdict writes exactly one of four artifacts; the block event retains the full URL, the free-text reason, and a foreign key back to the evidence row (`finding_id`). The manual inspection habit the owner already has is now the labelling signal, at zero extra effort.

**REUSED:** every normalizer and feed writer verbatim (`app/services/blacklist.py:11`, `app/services/jaillist.py:11`, `app/services/feeds.py:52`, `:69`), all three public feed routes, the `FeedCard` component (ADR 0004 `:23`), the upstream syncs (`upstream_blacklist.py`, `upstream_jaillist.py`).
**NEW:** the `blacklist_events` table (per the existing spec), its `verdict` state, the write-back of `finding_id`, the four-state UI.
**DELETED / DEAD-ENDED:** nothing; but see §9 for what stops receiving investment.

**Order:** implement `blacklist_events` as specced → add `verdict` → wire `finding_id` from the Findings row action → surface the verdict history on URL Investigation.

**Acceptance criterion:** from a Findings row, an operator can reach a verdict in one click; the corresponding file on disk changes within the same request; the block event records the URL, the reason, and the `finding_id`; unblocking a destination removes its feed line and preserves its event history.

### Stage 3 — The behaviour layer

**Goal:** the product answers "which client_ip has a pattern of prohibited behaviour?" without the operator running queries.

- **NEW:** `app/services/escalation.py` (R1–R6 from §5.3) — the source-side recidivism count on `GET /api/hosts/{ip}`, the jaillist-candidacy queue, and the destination-side R6 blacklist-candidacy queue.
- **NEW:** pattern-based search *across* a client's history — the owner's literal ask ("pattern based search on client_ip internet behaviour"). The mechanism is `matched_patterns` (already persisted, `app/database.py:62-65`): group a client's evidence by policy class over the window and show the class mix. This is 80% built inside `app/services/readout.py:151-176` already — reuse that aggregation, drop the env-weight scoring (`:169-176`) in favour of the R1–R6 rules.
- **REUSED:** `app/services/timeutil.py:1-6` (R3 local-day bucketing), the Findings/Query filter infrastructure, `app/routes/hosts.py:24-49` (the risk-level helper the escalation count extends).
- **REPLACES:** `app/services/readout.py`'s `compute_risk` and the `RISK_WEIGHT_*` env contract (`:40-59`). One ranking model, owned by one module.
- **DELETED:** nothing until the replacement is proven in production; then `app/routes/readout.py:8-18` and `app/services/readout.py` are removed or reduced to the shared aggregation.

**Order:** per-client policy-class mix (cheap, reuses `readout.py`) → R1/R5 (single-table counts) → R2 (requires Stage 1's intent) → R3/R4 (requires the `timeutil` local-day plumbing) → candidacy queue UI last.

**Acceptance criterion:** the Host Investigation page shows, for any `client_ip`, a recidivism count, the policy-class mix, and — when the rules fire — a jail-candidacy prompt whose one-click action produces a `jail-ips.txt` line.

---

## 7. Feed contract (freeze it)

This is the contract the outside world depends on. Freeze it as **v1** and never break it.

### 7.1 The four artifacts

| # | File on disk | HTTP route | Consumed by | Orientation | Source table | Format |
|---|---|---|---|---|---|---|
| 1 | `urls.txt` | `GET /api/blacklist/urls.txt` | proxy device | **DESTINATION** (block what clients reach) | `blacklist_entries WHERE kind='url'` | bare FQDN, one per line, CRLF |
| 2 | `ips.txt` | `GET /api/blacklist/ips.txt` | proxy device, firewall device | **DESTINATION** (block IPv4 destinations) | `blacklist_entries WHERE kind='ip'` | bare IPv4, one per line, CRLF |
| 3 | `jail-ips.txt` | `GET /api/jaillist/ips.txt` | firewall device (fail2ban) | **SOURCE** (block the offending client) | `jaillist_entries` | single-host CIDR (`ip/32`, `ip/128`), one per line, CRLF |
| 4 | `urls.txt` + `ips.txt` (same two files) | regenerated on every mutation | proxy + firewall | DESTINATION | — | — |

Evidence for each row: paths at `app/services/feeds.py:27-28` and `:64-66`; public routes at `app/routes/blacklist.py:24-46` and `app/routes/jaillist.py:17-27`; auth exemption at `app/main.py:227-233`.

### 7.2 Invariants

1. **One entry per line. No header, no footer, no comments, ever.** `"\r\n".join(values) + "\r\n"` — `app/services/feeds.py:61`, `:76`.
2. **Line terminator is CRLF, including the trailing line.** Verified byte-for-byte via `newline=""` (`app/services/feeds.py:42-45`). Pinned by the regression tests specified at `docs/specs/blacklist-metadata.md:644-651`.
3. **Deduplicated, by construction.** `blacklist_entries` declares `UNIQUE (kind, value)` (`app/database.py:177`); `jaillist_entries` declares `UNIQUE (value)` (`app/database.py:191`). Therefore `SELECT value … ORDER BY value` emits each entry exactly once. **Do not add `DISTINCT`** — the guarantee is the table, and adding `DISTINCT` would paper over a broken constraint instead of failing loudly.
4. **Sorted by value, byte-order.** `ORDER BY value` — `app/services/feeds.py:33`, `:74`. This is what makes diffing two syncs meaningful.
5. **Atomic replacement.** Temp file in the same directory, `fsync`, then `os.replace` — `app/services/feeds.py:39-49`. A device can never read a half-written feed.
6. **Only `value` ever reaches a feed.** No metadata column, no id, no source, no timestamp may ever appear. `docs/specs/blacklist-metadata.md:493-497` makes this an explicit invariant with a test.
7. **Regenerated on startup and on every mutation.** `app/main.py:68-69`; `app/routes/blacklist.py:71-73`; `app/routes/jaillist.py:50-52`. The DB is authoritative; the file is a projection. A crash between commit and regeneration leaves the DB correct and the feed stale-but-valid.
8. **Normalization is closed and strict.** A blacklist value becomes a bare FQDN or IPv4, or raises `ValueError` → HTTP 400 (`app/services/blacklist.py:11-35`). A jaillist value becomes a single-host CIDR or raises (`app/services/jaillist.py:11-61`). **CIDR ranges are rejected by design** (`app/services/jaillist.py:57-60`) because the consumers act on addresses; **hostnames are rejected on the jail side** because sources are always IPs (ADR 0004 `:16`).
9. **Cross-file duplication is correct and expected.** A destination may appear in both `urls.txt` and `ips.txt`; a source may be jailed while its destination is blocked. Changing this would require the two device teams to coordinate — never do it.
10. **The files are public; the list APIs are not.** The `.txt` routes carry no `verify_admin` (`app/routes/blacklist.py:10-13`); `GET /entries` and all writes do (`:49`).

### 7.3 The `rule_info` boundary

**Frozen rule: `rule_info` and the proxy's rule numbering are never decoded, never scored, never used to derive severity, and never appear in any feed file.**

- It is captured: `app/services/result_processor.py:105`, column added at `app/database.py:144`.
- It is displayed as opaque text for the operator's own reference.
- The repo contains no code that interprets it (`docs/attck-mapping-spec.md:873-882`).
- The ATT&CK spec's "handover item 1" — obtaining the code table to unlock `rule_info` as "the strongest signal in the document" (`docs/attck-mapping-spec.md:1157-1159`) — is **withdrawn by owner decision**. Strike it so no future contributor re-opens it.

**Where the boundary lives in code:** the boundary is enforced by *absence*. The `rule_info` column is written and read by no predicate. If a future contributor needs a single place to read the rule, put it in §9's anti-goals, not in code.

### 7.4 Version stamp

Write a `FEEDS.md` (or a section in `CONTEXT.md`) recording v1 of the table in §7.1. Any change to a file name, terminator, orientation, or the "one entry per line" rule is v2 and requires the consuming devices to be redeployed. **No such change is proposed by this document.**

---

## 8. Verdict on "revamp everything?"

### 8.1 Answer: No. Quarantine and extend.

The owner's instinct — "I kept pushing features that might have a relation with the raw data" — is correct as a diagnosis and wrong as a prescription. The evidence:

**Against a rewrite:**

1. **The spine is already correct and already matches the goal.** Poll → pattern match → whitelist filter → atomic dedupe → persist → alert → three feed writers. Every one of those steps is implemented, tested, and aligned with the owner's intent. A rewrite would rebuild them and reintroduce the bugs they have already fixed — including the 38× byte-proxy defect (`docs/attck-mapping-spec.md:943-968`) and the vacuous-share defect (`:911-941`), both of which are documented and pinned by tests.
2. **The feed contract is already frozen in behaviour but not in writing.** §7 costs a document, not code. Rewriting would put that contract at risk for zero gain.
3. **The drift is four surfaces, not the whole app.** ATT&CK, Redirects, `readout.py`'s second scoring model, and the `analytics.py`/`client_report.py` duplication (§2.4). Three of the four can be fixed by hiding a nav entry or repointing a function.
4. **The critical defect is one argument.** `apply_filters(...)` at `app/services/monitor.py:652` needs `actions=("ALLOW","DENY")`. The owner's entire DENY concern — the thing that made him say development "collapsed" — is addressed by changing a default and auditing six readers.
5. **A rewrite would not fix the fabrication problem, because fabrication is a practice, not a module.** The bandwidth figure invented on the Host Investigation page (`app/routes/hosts.py:52-58`, mirrored at `admin-ui/src/api.ts:1530-1537`) is the third instance of one bug class, after the 38× byte proxy (`docs/attck-mapping-spec.md:943-968`) and the vacuous upload share (`:920-928`). Rebuilding the app would rebuild the habit unless the rule in §1.2/§9.4 is adopted as a constraint. Fixing forward, on a codebase that has already learned to represent "not measured" honestly in two other places, is cheaper and more durable.

**For targeted extension:** the goal names two capabilities the product does not have — (a) *intent* evidence (ATTEMPT rows) and (b) *recidivism* (a client's behaviour over time). Both are missing because of the same root cause: the pipeline was optimized for "what is a risk right now" instead of "what happened, to whom, and what did we decide". §3, §5 and §6 Stages 1–3 add exactly those two, on top of what exists.

**The reframe that resolves the owner's frustration:** stop treating `findings` as a *risk dashboard feed* and start treating it as an **evidence ledger**. Every symptom the owner describes downstream of that — the competing risk scores, the ES-or-SQLite fallback ladders, the "Enforcements (handled)" dead-end, the analytics panels nobody acts on — is a consequence of a ledger being read as a scoreboard.

### 8.2 The five highest-leverage things to build next, in priority order

| # | Build | Why it is first | Acceptance criterion |
|---|---|---|---|
| **1** | **Persist both intents.** Change `app/services/monitor.py:652` to `actions=("ALLOW", "DENY")`; add a derived `intent` column + `(client_ip, intent, log_timestamp)` index to `findings`. | It is the owner's explicit ask, it is one argument, and Stages 1–3 are all blocked without ATTEMPT rows. Every week of delay is enforcement history lost forever. | With Elasticsearch stopped, `GET /api/analytics/enforcements` returns non-zero for a window in which deny-only traffic occurred; `SELECT action, COUNT(*) FROM findings GROUP BY action` returns both `ALLOW` and `DENY`. |
| **2** | **Wire `finding_id` from the Findings row action** into the blacklist and jaillist writes (`admin-ui/src/api.ts:1267-1275` sends `{ value }` today; the columns already exist at `app/database.py:175`, `:189`). | It is the audit trail. Without it the evidence ledger cannot answer "why is this blocked?" and the operator re-inspects the same site — the exact waste `docs/specs/blacklist-metadata.md:12-25` diagnoses. Six lines of caller change. | Blacklist a domain from a Findings row; `SELECT finding_id, url FROM blacklist_entries WHERE value=?` returns the row's id and full URL. |
| **3** | **Implement `blacklist_events` as specced, plus a four-state `verdict`.** | It is the decision ledger. The spec is complete and design-reviewed (`docs/specs/blacklist-metadata.md:193-503`); it needs building, and it needs the INCONCLUSIVE state it lacks. | Block one destination from three different URLs: three event rows each with its own URL, exactly one `urls.txt` line. Unblock it: the line disappears, all three events survive. Record NOT_HARMFUL: a whitelist pattern is created and the destination drops out of future findings. |
| **4** | **Ship `app/services/escalation.py` with rules R1/R5/R6.** | These three are computable from data that exists *today* (R5 in miniature already at `app/routes/hosts.py:47-48`; R6 needs only a `GROUP BY base_url` re-pointed from volume to distinct clients), so both queues can start before Stage 1 lands. **R2 cannot start until build #1 lands, and its history is being destroyed every interval it does not** — see §5.2. | `GET /api/hosts/{ip}` returns a recidivism count; a client with ≥3 REACH events across ≥2 domains in 30 days shows a jail-candidacy prompt; a host reached by ≥3 distinct clients shows a blacklist-candidacy prompt; each one-click produces a line in the correct file (`jail-ips.txt` vs `urls.txt`). |
| **5** | **Stage 0 nav quarantine + freeze the feed contract in writing (§7).** | Cheapest change in the document, and it converts the owner's "collapsed" feeling into a product that reads as one thing. The contract freeze protects the device integrations from every later change. | Sidebar has 12 items in four groups, no dead entries; `git log` shows the nav change touches one file; a `FEEDS.md`-style v1 record exists and matches §7.1 byte-for-byte against the disk files. |

If only one ships, ship **#1**. It is the difference between a product that records the owner's goal and one that discards it.

---

## 9. Anti-goals

Explicit list of things to stop building, funding, and defending. Each has a reason grounded in evidence.

### 9.1 ATT&CK mapping — STOP

**Argument for keeping it (stated honestly, then rejected):** the engine is unusually careful work. It refuses to emit a technique whose fields are absent (`docs/attck-mapping-spec.md:13-17`), it treats missing fields as `UNKNOWN` rather than `ABSENT` when the inventory is silent (`:1100-1113`), it reports suppression reasons structurally (`:36-39`), and it fixed two real fabrication bugs rather than hiding them (`:1079-1140`). It is 2359 lines of code plus two test files, built by someone who cared about honesty. That is a real asset.

**Why it does not serve this goal:**

1. **Its output does not reach any feed file.** No ATT&CK technique feeds `urls.txt`, `ips.txt`, or `jail-ips.txt`. Verified: `app/routes/attck.py:26-76` reads findings and ES; no write path. `docs/attck-mapping-spec.md` never mentions a feed.
2. **The engine's own review documented its irrelevance on this deployment.** This is not an outside judgement imposed on the module — it is the ATT&CK spec's self-assessment, written by the same author, against the owner's verbatim document. Executed, the host catalogue emits `T1053.005 (LOW)` and `T1204.002 (LOW)`, and "everything else declines in its predicate — correct behaviour" (`docs/attck-mapping-spec.md:1062-1073`); the URL catalogue "emits **nothing**". The spec's summary: "the operator's realistic panel is **at most two LOW techniques**." A module whose own field-by-field reconciliation concludes it produces at most two low-severity labels on the production data does not need an external verdict retired against it.
3. **The deployment is permanently COLLAPSED.** `username` and `session` do not exist in the schema and are on a "fields to request" list — `docs/attck-mapping-spec.md:1023-1027`. Most of the catalogue is gated off forever.
4. **Its core input — the ATT&CK catalogue — is irrelevant to the owner's threat model.** The goal is *prohibited sites* (piracy, adult content, gambling) accessed by devices on a corporate network. That is a policy-compliance problem. ATT&CK is an adversary-tactics taxonomy built for intrusion analysis. Mapping "a device reached a gambling site" onto `T1071.001 Application Layer Protocol` produces a low-confidence label that no operator can action.
5. **The `duration_seconds × 8192` byte proxy already caused one shipped defect** (`docs/attck-mapping-spec.md:943-968`) and its repair is now dead code if the feature is quarantined.

**Action:** remove `Sidebar.tsx:143`; stop investment in `app/services/attck_mapping.py`, `attck_fleet.py`, `app/routes/attck.py`, `AttckFleetPage.tsx`, `AttckPanel.tsx`. Keep the code and routes mounted (§6 Stage 0) so nothing 404s. **Salvage one thing**: `app/services/es_fields.py:164-196`'s mode resolver is genuinely useful and is already used by `app/routes/hosts.py:81`; keep it and reduce the mode vocabulary to "do we know the schema".

**Strike handover item 1** (`rule_info` code table, `docs/attck-mapping-spec.md:1157-1159`) — it directly contradicts the owner's "do not decode `rule_info`" instruction.

### 9.2 Redirect crawling — STOP investing, keep running

`app/services/redirects.py` performs hop-by-hop HTTP requests against tracked URLs, records `redirect_edges`, and auto-discovers further targets (`:1-7`). This is a live-web crawler inside a log-monitoring product. It has one genuine connection to the goal: `blacklist_tracked_hosts` (`:22-34`) writes to `blacklist_entries` with `source='redirect'`, which reaches `urls.txt`.

**Action:** keep the service and its scheduler job (`app/main.py:98-102`) — the write path is real. Remove `Sidebar.tsx:151`. Do not extend the crawler; if the auto-blacklist behaviour is genuinely wanted, it should be a consequence of a *verdict* (§6 Stage 2), not of an HTTP check that never consulted the operator.

### 9.3 A second risk-scoring model — STOP

`app/services/readout.py:169-176` computes a client risk score from `RISK_WEIGHT_*` env variables; `app/routes/hosts.py:24-49` computes a different risk level from share brackets. Two models, two answers, same data. `admin-ui/src/api.ts:1520-1525` implements a third in the browser.

**Action:** keep `hosts.py`'s model (it is grounded in REACH/ATTEMPT shares and block-list membership), replace `readout.py`'s scoring with §5's R1–R6, delete the client-side duplicate at `api.ts:1520-1525`. One model, one owner.

### 9.4 Fabricated values in evidence surfaces — STOP

**Named instance: `app/routes/hosts.py:52-58`, `_synthesize_bandwidth`.** The Host Investigation bandwidth figure is **not measured bytes**. The function multiplies a request count by a constant and formats it as a data volume:

```
return f"{(total_requests * 0.12):.1f} MB"    # hosts.py:57
return f"{(total_requests / 1024):.1f} GB"    # hosts.py:58
```

Its own docstring admits the substitution — "Byte accounting not yet on the host profile — scale a placeholder" (`:53`). It is called from `app/routes/hosts.py:198` and rendered by `admin-ui/src/components/HostEntityCard.tsx:70` as an ordinary bold figure. The defect is **duplicated client-side** in `admin-ui/src/api.ts:1530-1537` (`synthesizeBandwidth`), whose comment is more candid still: *"Until byte accounting lands, synthesize a plausible display value so the card matches the wireframe ('4.2 GB')"* (`:1531-1532`) — a value chosen to match a design mockup, presented where the operator reads measured traffic.

**Why this ranks with the byte-proxy bug, and higher in one respect.** (a) The Host Investigation page is a **KEEP/extend** surface (§2.1) — it is the `client_ip` evidence surface, and a verdict reached on it can jail a device. (b) The owner's stated position is that logs are captured **as evidence** so the `client_ip` can be issued; a number invented to match a wireframe is indefensible the first time it is challenged. (c) It violates §1.2's entry rule directly: the value improves neither a row's correctness nor the operator's ability to reach a verdict. (d) The placeholder is **unmarked** at the point of display — unlike the demo path, which at least sets an explicit `placeholder: true` flag with the comment "MUST NOT be treated as evidence" (`admin-ui/src/api.ts:1514-1516`, set at `:1675`). The bandwidth figure carries no such flag, so the operator has no way to tell an invented value from a measured one.

**The rule, stated as a product constraint:**

> **No value displayed, exported, or placed in an alert on Findings, Host Investigation, URL Investigation, or any CSV/JSON export may be synthesized, estimated, or derived through a proxy formula. Every such value must come from a persisted field, or be shown explicitly as unavailable.**

**This is the third instance of one bug class — treat it as a class, not three accidents.** (1) The `duration_seconds × 8192` byte proxy invented ~8 KiB per row against a real 215 B — a 38× overstatement, reaching a 1 MiB threshold on 122 ordinary denied requests (`docs/attck-mapping-spec.md:943-968`). (2) The vacuous share, where `upload/(upload+download)` read `1.0` on an all-DENY stream because the denominator was structurally zero — arithmetic presented as evidence (`docs/attck-mapping-spec.md:920-928`). (3) This bandwidth figure. The codebase already knows the correct representation: the `-` NOT-RECORDED sentinel, where a missing measurement is carried as *absent* rather than as `0`, precisely so it cannot be mistaken for a measured zero (`app/services/logline.py:3-6`, `:29`), and `bytes_source = "none"` is already used to mean "nothing present → total_bytes is UNKNOWN, not 0" (`app/services/attck_mapping.py:648-651`). The pattern to generalize is that one.

**Action:** delete `_synthesize_bandwidth` (`app/routes/hosts.py:52-58`) and `synthesizeBandwidth` (`admin-ui/src/api.ts:1530-1537`); render `bytes_downloaded`/`bytes_uploaded` from the evidence row (both columns already exist and are already written — `app/database.py:142-143`, `app/services/result_processor.py:167-168`), with `"—"` when no measurement exists. The `analytics.py` 8 KiB fallback (`:18-20`, `:75`, `:185-187`) is **not** covered by this item: it is a documented, labelled ranking heuristic, disclosed in the UI (`admin-ui/src/components/AnalyticsPage.tsx:222`, `:481`), and it never appears on an evidence surface. That distinction — labelled and disclosed versus unmarked — is the boundary of this anti-goal.

### 9.5 Identity enrichment — STOP (already out of scope; make it non-negotiable)

`CONTEXT.md:45` and ADR 0002 `:19` already rule out IP→person/department/MAC. The owner confirms no MAC exists and IP-to-detail lives in another app that will not be integrated.

**Action:** no new work. Additionally, do **not** integrate the other app "just for triage" — the moment a name attaches to a `client_ip`, the feed contract (§7) becomes a privacy surface and the jailed-IP decision acquires a different review process. Keep the boundary.

### 9.6 Decoding `rule_info` — STOP (permanent)

See §7.3. No decoder, no enum, no code table, no derived severity. Strike the ATT&CK handover item that proposes acquiring the table.

### 9.7 Bulk data-plane features without a consumer — STOP

The pattern to reject in future: a Dashboard card, an analytics panel, or a page whose output no operator action and no feed line depends on. The existing instances are the bandwidth panels and top-domains tables in `app/routes/analytics.py` and the `enrich.py` TLS/HTTP probes (`app/services/enrich.py:1-6` — keep only the reverse-DNS/RDAP org lookups, which an operator genuinely uses to judge a destination).

**Action:** before building any surface, answer in one sentence which of the four feed files it improves, or which verdict it makes easier to reach. If neither, it does not ship.

### 9.8 Auto-jailing — STOP (not proposed anywhere, but name it)

§5 produces *candidacy* — jaillist candidacy (source-side, `jail-ips.txt`) and blacklist candidacy (destination-side, `urls.txt`) — never an automatic write to either feed. Jailing a static-IP device has real operational cost, and a blacklist line is enforced by two devices simultaneously. ADR 0004 `:25` already frames the jail feed as enforcement-intent only. Any future proposal to auto-write either file from a threshold must come with a named owner and a rollback path, or be rejected.

---

## Appendix A — Documents this proposal touches

| Document | Relationship |
|---|---|
| `docs/adr/0001-risk-definition.md` | **Superseded** by the new ADR 0005 in §3.5 |
| `docs/adr/0002-page-consolidation.md` | Consistent; §6 Stage 0 is a second consolidation pass on the same principles |
| `docs/adr/0004-jaillist.md` | Consistent; §5 extends it with a candidacy queue, adds nothing to the feed |
| `docs/specs/blacklist-metadata.md` | **Adopt as-is**, plus the `verdict` state §6 Stage 2 requires. Note: `blacklist_events` does not exist in the codebase yet — the spec is unimplemented |
| `docs/attck-mapping-spec.md` | Quarantine per §9.1; strike handover item 1 (`:1157-1159`) per §7.3 |
| `docs/raw-data-capability-inventory.md` | Parallel review, largely consistent. §4.3 above supersedes its §3 item 2 on `user_id` (the alias identity was settled at `docs/attck-mapping-spec.md:803-813`); its §3 item 4 (destination-first blacklist candidates) is adopted as rule R6 in §5.2 |
| `CONTEXT.md` | Needs four edits: Purpose (`:7`) to name the four files as the interface; Risk model (`:11-15`) per §3.5; Pages (`:24-29`) per §6 Stage 0; vocabulary (`:39-40`) to reframe `enforcement` as ATTEMPT evidence. Record the closed `user_id`/unauthenticated question (§4.3) so it is not reopened |
