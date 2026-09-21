# Raw-Data Capability Inventory

> **Audience:** the network operator / product owner who owns the proxy (logstash)
> index that uNetWatch reads.
> **Question answered:** "How much more can an app be built on just the raw
> proxy log data I already have?"
> **Rule applied throughout:** every claim about the code carries a `file:line`
> citation. A field name is only listed if it literally appears in the repo.
> Nothing aspirational.
> **Method:** code archaeology only. No live ES access was available, so any
> field whose *population* could not be proven from the repo is called out in
> §5 with the exact command to verify it.

---

## 1. Field inventory

Source legend:

- **baseline** — one of the six fields every supported deployment must carry
  (`scripts/collect_es_fields.py:51-58`, `app/services/es_fields.py` mode gate).
- **rich** — a richer flat proxy field that the logstash-proxy index is
  documented to carry (`scripts/collect_es_fields.py:66-78`,
  `app/services/result_processor.py:135-138`).
- **raw-line-only** — a positional fact that exists only in the raw `message`
  line; the flat schema collapses it and the recovery parser in
  `app/services/logline.py` must re-derive it.
- **app-derived** — computed by uNetWatch from other fields, not read from ES.

| field | source | declared where (file:line) | persisted in `findings`? | consumed by app code? |
|---|---|---|---|---|
| `@timestamp` | baseline | `scripts/collect_es_fields.py:52`; `app/services/query_builder.py:24`; `app/services/logline.py:23` (bracket block) | yes, as `log_timestamp` (`app/services/result_processor.py:176`) | yes — `normalize_timestamp` (`app/services/result_processor.py:20-53`), timelines, windows |
| `url` | baseline | `scripts/collect_es_fields.py:53`; `app/services/query_builder.py:24` | yes | yes — findings, pattern match, blacklist badge (`app/services/result_processor.py:319`, `app/routes/client_report.py:400`) |
| `client_ip` | baseline | `scripts/collect_es_fields.py:54`; `app/services/query_builder.py:24`; `app/services/logline.py:24` (slot 0) | yes | yes — every per-client aggregation (`app/services/attck_fleet.py:265`, `app/routes/client_report.py:158`) |
| `server_ip` | baseline | `scripts/collect_es_fields.py:55`; `app/services/query_builder.py:24`; `app/services/logline.py:26` (slot 2) | yes | partially — stored (`app/services/result_processor.py:149`) and aggregated as `distinct_dest_ips` (`app/services/attck_fleet.py:267`); exported raw (`app/routes/client_report.py:471`) |
| `duration_seconds` | baseline | `scripts/collect_es_fields.py:56`; `app/services/query_builder.py:25`; `app/services/logline.py:28` (slot 4) | yes | yes — bytes fallback proxy (`app/routes/client_report.py:108-115`), Query table (`app/services/result_processor.py:361`) |
| `action` | baseline | `scripts/collect_es_fields.py:57`; `app/services/query_builder.py:24`; `app/services/logline.py:34` (slot 10) | yes | yes — risk/enforcement split (`app/routes/client_report.py:74-87`, `app/services/attck_fleet.py:285-287`) |
| `user_agent` | rich (mode-gated) | `scripts/collect_es_fields.py:61`; `app/services/query_builder.py:27` | only in UC-A/UC-B (`app/database.py:118-121`) | partially — Query table (`app/services/result_processor.py:94`), UC-B grouping; not used by any risk predicate |
| `username` | rich (un-collapse) | `scripts/collect_es_fields.py:62`; `app/services/attck_mapping.py:122` | no | no — resolver only (`app/services/attck_mapping.py:122`) |
| `session` | rich (un-collapse) | `scripts/collect_es_fields.py:63`; `app/services/attck_mapping.py:123` | no | no — resolver only |
| `domain` | rich | `scripts/collect_es_fields.py:67`; `app/services/query_builder.py:25` | yes (`app/database.py:137`) | partially — stored; `base_url` (not `domain`) drives domain analytics (`app/routes/analytics.py:422`) |
| `base_url` | app-derived | not from ES — computed from `url` (`app/services/result_processor.py:118-120`) | yes (`app/database.py:40`) | yes — all domain aggregation (`app/routes/analytics.py:422`, `app/routes/client_report.py:286`) |
| `category` | rich | `scripts/collect_es_fields.py:69`; `app/services/query_builder.py:25`; `app/services/logline.py:31` (slot 7) | yes (`app/database.py:138`) | partially — exported raw (`app/routes/client_report.py:475`) and counted as `distinct_categories` feeding the domain signal (`app/services/attck_fleet.py:268,330`); never drives a risk predicate |
| `http_method` | rich | `scripts/collect_es_fields.py:70`; `app/services/query_builder.py:25` | yes (`app/database.py:139`) | partially — displayed in Query/Host tables (`app/services/result_processor.py:344`); no backend logic reads it |
| `http_status_code` | rich | `scripts/collect_es_fields.py:71`; `app/services/query_builder.py:26`; `app/services/logline.py:32` (slot 8) | yes (`app/database.py:140`) | partially — display only (`app/services/result_processor.py:345`) |
| `country_code` | rich | `scripts/collect_es_fields.py:72`; `app/services/query_builder.py:26`; `app/services/logline.py:36` (slot 12) | yes (`app/database.py:141`) | partially — display only (`app/services/result_processor.py:346`) |
| `bytes_downloaded` | rich (raw-line-only sentinel) | `scripts/collect_es_fields.py:73`; `app/services/query_builder.py:26`; `app/services/logline.py:29` (slot 5, `-` sentinel) | yes (`app/database.py:142`) | yes — bandwidth (`app/routes/client_report.py:250`, `app/services/attck_fleet.py:337`) |
| `bytes_uploaded` | rich | `scripts/collect_es_fields.py:74`; `app/services/query_builder.py:26`; `app/services/logline.py:33` (slot 9 `request_size`) | yes (`app/database.py:143`) | yes — bandwidth (`app/routes/client_report.py:251`, `app/services/attck_fleet.py:337`) |
| `rule_info` | rich (opaque) | `scripts/collect_es_fields.py:75`; `app/services/query_builder.py:27` | yes (`app/database.py:144`) | partially — persisted and displayed (`app/routes/client_report.py:479`, `admin-ui/.../HostInspectorPage.tsx:909-913`); see §2 |
| `rule_name` | rich (opaque) | `scripts/collect_es_fields.py:76`; `app/services/query_builder.py:27` | yes (`app/database.py:145`) | partially — display fallback for `rule_info` (`app/routes/client_report.py:479`) |
| `matched_patterns` | app-derived | computed by uNetWatch, not ES (`app/services/monitor.py:363,663`; `app/services/result_processor.py:156`) | yes, as JSON (`app/database.py:62-64`) | yes — readout policy classes (`app/services/readout.py:134-166`), findings badges; see §2 |
| `host` | baseline-ish | `app/services/query_builder.py:28` | no | no consumer found beyond projection comment (`app/services/query_builder.py:18-20`) |
| `message` | raw-line-only | `app/services/query_builder.py:28`; `app/services/logline.py:8` | no | yes via recovery parser only (`app/services/logline.py`, ATT&CK provenance) |
| `sni_host` | raw-line-only | `app/services/logline.py:27` (slot 3) | no | no — recovery parser field only |

Fields that exist **only** in the raw line and are lost by the flat schema:
`local_timestamp`/`tz_offset` (`app/services/logline.py:23`), `sni_host`
(slot 3), `response_size_recorded` (the `-` sentinel flag, `app/services/logline.py:196`),
`rule_codes` split (`app/services/logline.py:35`), `sni_echo` (slot 13).

---

## 2. Field semantics that matter

### 2.1 `user_id` — a `client_ip` alias, NOT an auth signal

The operator's grammar comment calls slot 1 `user_id (an IP when the request is
unauthenticated)` (`app/services/logline.py:25`); the parser assigns slot 1 to
`user_id` (`app/services/logline.py:180,219`). The real documents resolve this
precisely: it is a copy of `client_ip`.

**(a) What the operator's format asserts.** The grammar comment says slot 1 is
`user_id (an IP when the request is unauthenticated)` (`app/services/logline.py:25`).
In the observed documents this is realised as an **exact copy of `client_ip`**.

**(b) Compiled evidence.**

- `docs/attck-mapping-spec.md:803-806`: "In the sample, `user_id == client_ip ==
  "172.21.122.6"`, character-for-character" (verbatim document at
  `docs/attck-mapping-spec.md:778-794`, §j.0).
- `docs/attck-mapping-spec.md:812-813` (corrected claim): "In this deployment
  `user_id` is a **second spelling of `client_ip`**, not an identity lens."
- Second corroborating fixture, different client:
  `tests/test_patterns.py:802` carries `"user_id": "172.21.26.84"` (an IP) on an
  `"action": "ALLOW"` row (`tests/test_patterns.py:803`).
- No `username`/`session` field exists anywhere in the repo outside
  `_resolve_mode` itself and the *proposed*-fields table in
  `docs/field-sample-report.md:80-81` (`docs/attck-mapping-spec.md:808-810`).

**(c) Operative conclusion.** **`user_id` is a `client_ip` ALIAS in this
deployment. It carries NO authentication information and CANNOT be used to
distinguish authenticated from unauthenticated traffic.**

**(d) Why this is an active reason to refuse the heuristic.** Because
`user_id == client_ip` exactly, the "parses as an IP" test is trivially true for
every row and therefore carries **zero discriminating power** — which is exactly
why it must not be used as an unauth heuristic. The earlier cautious position
was right to refuse to build on it; the reason to refuse is now stronger than
the grammar alone suggested.

**Honest status in app code: not consumed.** `user_id` is projected
(`app/services/query_builder.py:27`), default-filled (`app/services/result_processor.py:107`),
persisted (`app/database.py:146`, `app/services/result_processor.py:168`),
resolved for availability (`app/services/attck_mapping.py:115`), and displayed
as a copyable "User ID (proxy)" cell in the UI
(`admin-ui/src/components/EventInspectorSidebar.tsx:236-241`). **No Python
consumer compares `user_id` to `client_ip` or otherwise uses it as an
auth/unauth signal.** (Note: `username`/`session` in `_resolve_mode`
are what drive UC-A/UC-B — `app/services/es_fields.py` mode resolver — and those
are absent in this deployment; see §5.)

### 2.2 `rule_info` — opaque proxy rule numbering

`rule_info` carries comma-separated proxy rule codes, e.g. `RN190,SNI,BS`.
In the raw line these occupy slot 11 `rule_codes (comma-separated, undecoded
— spec §j.3)` (`app/services/logline.py:35`); the flat field is `rule_info`
(`scripts/collect_es_fields.py:75`). The repo is explicit that the codes are
**not to be decoded** by uNetWatch — the parser keeps them undecoded.

**What an opaque stable key still buys you (no decoding required):**

- **Grouping** — "all requests that hit rule set X" is a valid cohort even when
  you do not know what X means.
- **Dedupe/provenance** — identical `rule_info` strings prove the same proxy
  rule fired; a stable key is a stable join key across rows and time.
- **Same-rule-again detection** — recurrence of the same opaque code for a
  `client_ip` is detectable as a string-equality series.
- **Per-rule volume/drift** — counts per distinct code over time, without
  semantics.

**Honest status (corrected after a full-repo grep).** `rule_info` is **not**
wholly unused by backend logic: the ATT&CK command-context builder reads the
`rule_info` column and folds its comma-split codes into a per-entity code set —
`app/services/attck_mapping.py:1611-1620` (`codes.update(parse_rule_codes(str(v)))`
at line 1617, `signals.rule_codes = sorted(codes)` at line 1620), with the parsed
slot-11 codes as the fallback (line 1619). That is a **set-union aggregation**
"which opaque codes did this entity ever trigger", not a per-client grouping,
per-destination grouping, time-series, or join. So the accurate claim is:
`rule_info` is aggregated into one undecoded code set for context
(and the spec at `docs/attck-mapping-spec.md:998-1000` is explicit that this set
"never feeds a technique predicate"), but **no backend logic groups, joins,
filters, or time-series by `rule_info` per `client_ip` or per destination**.
Beyond that aggregation it is persisted (`app/database.py:144`), type-declared
in the UI (`admin-ui/src/api.ts:69-70`), and shown as a display fallback next to
`rule_name` (`app/routes/client_report.py:479`,
`admin-ui/src/components/HostInspectorPage.tsx:909-913`,
`admin-ui/src/components/EventInspectorSidebar.tsx:298-306`,
`admin-ui/src/components/AnalyticsPage.tsx:567`).
The opaqueness is a deliberate design property, not a gap (spec §j.3).

**`rule_codes` splitter callers.** `parse_rule_codes` is defined at
`app/services/logline.py:96-98`; its only non-test callers are
`app/services/attck_mapping.py:1617` (the aggregation above) and
`app/services/logline.py:230` (inside `parse_line` itself). The only other
references are tests (`tests/test_logline.py:9,111-116`,
`tests/test_attck_mapping.py:1202-1223`). There is no caller that groups by an
individual rule code.

### 2.3 `action` — only ALLOW/DENY exist; FLAG is absent

`docs/adr/0001-risk-definition.md:8` states the proxy records
`ALLOW` / `DENY` and that **`FLAG` is absent from our data**; line 16 repeats
`FLAG` is ignored. Risk is defined as an `ALLOW` request whose URL matched a
block pattern and is not whitelisted (`docs/adr/0001-risk-definition.md:12`),
and `DENY` is reported separately as "Enforcements (handled)"
(`docs/adr/0001-risk-definition.md:14`). The app nonetheless still tests for
`FLAG` in a few places as a defensive branch (`app/routes/client_report.py:77`,
`app/services/attck_fleet.py:286`), but per the ADR it will never appear in real
data. Any new feature must treat the action domain as **{ALLOW, DENY}** only.

### 2.4 `bytes_downloaded` / response size — the `-` NOT-RECORDED sentinel

`app/services/logline.py:3-6` documents the problem: `bytes_downloaded` is `0`
**both** when the response size was genuinely zero **and** when the raw slot
held the `-` NOT-RECORDED sentinel, which logstash collapses to `0`. The
grammar marks slot 5 as `response_size (- = NOT-RECORDED — the §j.5 sentinel)`
(`app/services/logline.py:29`). The same collapse affects
`duration_seconds`/`http_status` (see the flat-vs-parse reconciliation at
`app/services/logline.py:193-211`).

**Why 0 is ambiguous.** A measured zero and a missing measurement are
indistinguishable in the flat field. This poisons any ratio with the byte in
the denominator: a measured `0` makes `upload/(upload+download)` vacuously
`1.0` (`app/services/logline.py:5-6`). The app's response is to (a) keep the
sentinel fact out of the flat schema in the recovery parser
(`response_size_recorded`, `app/services/logline.py:196`), and (b) fall back to a
`duration × 8192` byte proxy when the byte columns are empty
(`app/routes/client_report.py:108-115`, `app/routes/analytics.py:183-186`).
Note the fleet path deliberately does **not** apply that proxy
(`app/services/attck_fleet.py:32-35,332-346`), so byte figures differ by surface
and any new byte-based scoring must pick one convention.

### 2.5 `matched_patterns` vs `rule_info` — conflated in code

`matched_patterns` is computed **by uNetWatch** from its own block patterns at
poll time (`app/services/monitor.py:363,663`; persisted at
`app/services/result_processor.py:156`). `rule_info` comes **from the proxy**.
They are different things. The conflation/mis-statement is in
`app/routes/client_report.py:61-71`:

> `def _primary_rule(matched_patterns: str | None) -> str:`
> `"""First matched pattern, or "" when there is no rule information.`
> `The proxy's documents carry no matched_patterns field at all (the`
> `backend default-fills it with ""), so an empty result is the norm —`
> `never a literal like "matched", which reads as a rule name downstream.`

This docstring claims *"the proxy's documents carry no `matched_patterns` field
at all"* — which is true — but then names the function `_primary_rule`,
treating uNetWatch's own block-pattern match as a proxy "rule". The same
docstring is duplicated in `app/routes/analytics.py:125-131`. The
mis-statement is that a uNetWatch-derived pattern is labelled and reasoned about
as if it were a proxy rule; the two must not be mixed when attributing why a
request was handled. (`rule_name`/`rule_info` are the proxy's own rule
identifiers and live in separate columns.)

---

## 3. What is achievable (derived-value catalogue)

Format per item: **name** — inputs — computable from confirmed data? —
existing partial implementation. (Item 2 is listed here for continuity but its
verdict is **NO**; the full statement is in §4.)

1. **Prohibited-category destination detection.**
   Inputs: `url`, `base_url`, plus your block patterns.
   Computable: **yes.** Evidence: `matched_patterns` computed from block
   patterns (`app/services/monitor.py:363`), risk classification
   (`app/routes/client_report.py:81-87`).
   Implemented in part: yes — `app/services/readout.py:134-166`,
   `app/routes/analytics.py:420-453`.

2. **Unauthenticated-traffic detection.**
   Inputs: `user_id`, `client_ip`.
   Computable: **NO — not achievable with `user_id`.** `user_id` is an exact
   alias of `client_ip` in this deployment (`docs/attck-mapping-spec.md:803-806,812-813`;
   `tests/test_patterns.py:802`), so it carries no auth information. See §4.
   Implemented: **not implemented** (and not implementable from this field).

3. **Repeat-offender / recidivism scoring per `client_ip`.**
   Inputs: `client_ip`, `@timestamp`, `action`, `matched_patterns`.
   Computable: **yes.** A per-client hit count over time already exists.
   Implemented in part: yes — `risk_score` per client from persisted patterns
   (`app/services/readout.py:168-197`) and per-client counters
   (`app/services/attck_fleet.py:315-320`). Recidivism *decay/streak* is not
   implemented.

4. **Destination-first blacklist candidate generation.**
   Inputs: `base_url`, distinct `client_ip`.
   Computable: **yes** — rank hosts by number of distinct violating clients.
   Implemented in part: destination aggregation exists
   (`app/routes/analytics.py:420-453`) but it ranks by volume/bytes, **not** by
   distinct violating client count; that ranking is **not implemented.**

5. **Evidence package per `client_ip`.**
   Inputs: all persisted row columns (chronological).
   Computable: **yes.**
   Implemented: yes — `/api/client-report/{client_ip}` and
   `/export.csv` with a full raw-rows table
   (`app/routes/client_report.py:369-484`, raw header at line 466).

6. **Behavioural baseline per `client_ip` (rate, distinct destinations,
   hours-of-day, bytes).**
   Inputs: `@timestamp`, `base_url`, `server_ip`, `bytes_downloaded`,
   `bytes_uploaded`.
   Computable: **partially** — rate/distinct-destinations/bytes exist; an
   hours-of-day histogram exists only as a single "peak hour"
   (`app/routes/client_report.py:227-237`), not a distribution. A full
   per-client baseline model is **not implemented.**

7. **Same-rule-again detection using `rule_info` as an opaque key.**
   Inputs: `rule_info` (string equality), `client_ip`, `@timestamp`.
   Computable: **yes, if `rule_info` is populated** (§5); no decoding needed.
   Implemented: **not implemented** — no backend logic groups/joins/filters/
   time-series by `rule_info` per client or destination. The only backend read
   is a single undecoded set-union of all codes for one entity
   (`app/services/attck_mapping.py:1611-1620`), which is context, not
   same-rule-again detection. It is persisted (`app/database.py:144`) and
   displayed (`app/routes/client_report.py:479`).

8. **Enforcement feedback (did the DENY rate for a `client_ip` change after it
   was jailed?).**
   Inputs: `action`, `client_ip`, `@timestamp`, jail records
   (`jaillist_entries`, `app/database.py:204-214`).
   Computable: **partially** — DENY/ALLOW per day per client is already bucketed
   (`app/routes/client_report.py:271-277`) and jailing exists, but there is **no
   before/after comparison against jail time**. That correlation is **not
   implemented.**

9. **Per-destination risk profile.**
   Inputs: `base_url`, `action`, `matched_patterns`, `client_ip`.
   Computable: **yes.**
   Implemented in part: yes — top enforced destinations
   (`app/routes/analytics.py:456-487`) and `primaryRule` attribution
   (`app/routes/analytics.py:484`).

10. **Attempt-vs-reach distinction (DENY vs ALLOW for the same `client_ip` +
    `base_url`).**
    Inputs: `client_ip`, `base_url`, `action`.
    Computable: **yes** — a `base_url` seen under both `DENY` (attempted, proxy
    blocked) and `ALLOW` (reached) is the exact signal. `base_url` is computed
    (`app/services/result_processor.py:118-120`); `action` is stored.
    Implemented: **not implemented** as a pairwise comparison — all existing
    views aggregate risk and enforcement totals side-by-side
    (`app/routes/client_report.py:199-200`) but never join them per
    `client_ip`+`base_url`.

11. **Per-`http_status_code` outcome analysis.**
    Inputs: `http_status_code`, `action`.
    Computable: **partially** — the field persists, but `0` is documented to
    mean "no upstream response on DENY" (`app/services/logline.py:32`), so `0`
    rows conflate "blocked" with "no response".
    Implemented: **not implemented** beyond display
    (`app/services/result_processor.py:345`).

12. **Country / geo concentration per client.**
    Inputs: `country_code` (slot 12, `app/services/logline.py:36`),
    `client_ip`.
    Computable: **partially** — field exists in the raw line; whether it is
    populated in your index is unverified (§5).
    Implemented: **not implemented** beyond display
    (`app/services/result_processor.py:346`).

13. **Upload-heavy exfiltration screening.**
    Inputs: `bytes_uploaded`, `bytes_downloaded`.
    Computable: **partially** — depends on the §2.4 sentinel caveat.
    Implemented: yes, in part — the ATT&CK fleet computes `upload_share` and
    gates cloud-storage exfil on ~10 MB (`app/services/attck_fleet.py:337-346`,
    `app/services/attck_mapping.py:1198`).

14. **Proxy-rule provenance (which opaque rule set a row belongs to).**
    Inputs: `rule_info`, `rule_name`.
    Computable: **yes, if populated** (§5); no decoding.
    Implemented: yes, in part — one undecoded set-union per entity
    (`app/services/attck_mapping.py:1611-1620`), plus display
    (`app/routes/client_report.py:479`).

### Volume reality check

Purely arithmetic, to size the review load the above items create:

    (violating findings per day) x (fraction needing manual URL inspection)
      = manual inspections per day

Fields used: a violating finding is one row with `action = ALLOW` not
whitelisted (`docs/adr/0001-risk-definition.md:12`); the row carries its
destination as `base_url` (computed, `app/services/result_processor.py:118-120`)
and its source as `client_ip`. The two levers that reduce the manual-inspection
count without dropping any signal are exactly the dedupe items above:
**dedupe-by-destination** (item 4: one candidate per host, not one per hit) and
**dedupe-by-client** (item 3: one repeat-offender row per `client_ip`, not one
per request). Items that merely re-display rows (5, 9) do not reduce the count.

---

## 4. What is NOT achievable

1. **Per-user identity attribution.**
   Not achievable with the current data. Durable identity requires `username`
   or `session` (and, for UC-A, `user_agent`) to be present — the mode table at
   `docs/field-sample-report.md:27-32` shows `UC-A`/`UC-B` require
   `username`/`session`, and the un-collapse list at
   `docs/field-sample-report.md:76-81` names exactly the fields that must be
   added (`username`/`cs_username` or `session`/`cookie`). Those fields are
   **absent**: `_resolve_mode` only awards UC-A/UC-B when
   `{username, session}` (plus `user_agent` for UC-A) are confirmed
   (`app/services/es_fields.py` mode resolver), and `username`/`session` have
   no persistence path (`app/database.py` findings migration adds neither).
   The only identity-ish slot is the proxy `user_id`, which is an exact alias of
   `client_ip` in this deployment (`docs/attck-mapping-spec.md:803-806,812-813`;
   `tests/test_patterns.py:802`) — it attributes traffic to a **machine**, not a
   person (and even that is only because `client_ip` already says it).

2. **MAC-address attribution.**
   Not achievable and by design. There is no MAC field anywhere in the repo —
   not in `QUERY_SOURCE_FIELDS` (`app/services/query_builder.py:23-29`), not in
   the tracked field sets (`scripts/collect_es_fields.py:51-78`), not in the
   grammar (`app/services/logline.py:23-37`). The app is IP-centric: every
   grouping is `client_ip` (`app/routes/client_report.py:158`,
   `app/services/attck_fleet.py:265`). This is acceptable given the owner uses
   **static IPs**, where one IP maps to one known machine — the same
   attribution goal is met without L2 identity.

3. **Decoding proxy rule numbers.**
   Not achievable, and deliberately not attempted. The grammar labels the slot
   "comma-separated, undecoded — spec §j.3" (`app/services/logline.py:35`); no
   decoder exists. The codes are usable only as opaque keys (§2.2).

4. **Response-size / duration values as *measured* facts.**
   Not fully achievable: the `-` NOT-RECORDED sentinel is collapsed to `0` in
   the flat schema (`app/services/logline.py:3-6,29`), so a `0` cannot be
   asserted to be a measured zero. Only the recovery parser's
   `response_size_recorded` flag (`app/services/logline.py:196`) can tell them
   apart, and that flag is not persisted.

5. **Distinguishing authenticated vs unauthenticated — per *person* OR per
   *machine*.**
   Not achievable at all. Per-person is impossible without `username`/`session`
   (§4 item 1). Per-machine is **also** unavailable: there is no field whose
   value distinguishes an authenticated from an unauthenticated request — the
   only candidate, `user_id`, is an exact copy of `client_ip` and therefore
   carries zero discriminating power (`docs/attck-mapping-spec.md:803-806,812-813`).
   The auth dimension does not exist in this data.

---

## 5. Confidence and gaps

Nothing in this document depends on a field name that is not in the repo. The
following **data-population** facts could not be verified from code — they are
properties of *your* index, not of the app. Each has a command to confirm it.

| Unverified assumption | Why it matters | Confirm with |
|---|---|---|
| **Is there ANY field that distinguishes authenticated from unauthenticated traffic?** (the auth dimension) | §2.1, §3 item 2, §4 item 5: the auth dimension is entirely unavailable if no such field exists, making the product IP-only. | **Procedure:** run the field inventory (`/api/es/fields`, or `python scripts/collect_es_fields.py --out docs/es-field-handover.json`), then for a sample of rows list every field whose value *differs from* `client_ip`. If none exists, state plainly that the auth dimension is unavailable and the product is IP-only. (Expected shape: `user_id` will be identical to `client_ip` — see `docs/attck-mapping-spec.md:803-806`.) |
| `category` carries meaningful values (not always `""` or just the SNI echo) | §3 item 12 and the `distinct_categories` signal (`app/services/attck_fleet.py:268`) are meaningless if empty | same endpoint: check `sample.category` and the `category` bucket count in the handover `cardinality` block (`docs/es-handover-guide.md:58`) |
| `rule_info` / `rule_name` are populated | §2.2, §3 items 7 and 14 depend on it | same endpoint: `sample.rule_info` / `sample.rule_name`; handover `field_presence` |
| `country_code` is populated | §3 item 12 | same endpoint: `sample.country_code` |
| `http_status_code` is populated and not uniformly `0` | §3 item 11; `0` also means "no upstream response on DENY" (`app/services/logline.py:32`) | same endpoint: `sample.http_status_code` |
| `bytes_downloaded`/`bytes_uploaded` are real numbers, not all sentinel `0` | §2.4, §3 item 13 | same endpoint: `sample.bytes_downloaded`; compare against the raw `message` line with the `logline.py` parser for a few rows |
| Resolved `mode` matches the app's view | The mode gates which fields the resolver treats as PRESENT | run both `scripts/collect_es_fields.py` and `/api/es/fields` and compare `mode` (`docs/es-handover-guide.md:41-43`) |
| `username` / `session` absent (this is the expected case) | If they appear, §4 item 1 unblocks automatically and UC-A/UC-B become available | same endpoint: mode must be `COLLAPSED` (`docs/field-sample-report.md:31`) |

The endpoint is admin-authenticated with the `X-API-Key` header
(`docs/es-handover-guide.md:31-35`); `Bearer` is **not** accepted
(`docs/es-handover-guide.md:34`). The endpoint always returns 200 and never 5xx
on ES failure (`app/main.py:291`), so check `es_online` before trusting any of
the above.

---

## Appendix — source citations used

- Baseline/rich/extended field sets: `scripts/collect_es_fields.py:51-80`.
- ES projection list: `app/services/query_builder.py:23-29`.
- Raw-line grammar (slot → field): `app/services/logline.py:17-38`.
- Sentinel handling: `app/services/logline.py:3-10,29,193-211`.
- Filtering/derivation: `app/services/result_processor.py:71-125,128-229`.
- Mode resolver: `app/services/es_fields.py` (`_resolve_mode`).
- Findings schema + migrations: `app/database.py:37-49,56-65,118-147`.
- Risk definition: `docs/adr/0001-risk-definition.md:8,12-17`.
- Conflation quote: `app/routes/client_report.py:61-71` (duplicate at
  `app/routes/analytics.py:125-131`).
- Rule-code aggregation (the one backend read of `rule_info`): `app/services/attck_mapping.py:1611-1620`; splitter `app/services/logline.py:96-98,230`; "never a technique predicate" `docs/attck-mapping-spec.md:998-1000`.
- Mode table + un-collapse list: `docs/field-sample-report.md:27-32,76-81`.
- `user_id` is a `client_ip` alias (verbatim document + analysis): `docs/attck-mapping-spec.md:778-794,803-806,812-813`; second fixture `tests/test_patterns.py:802`.
- Verification commands: `docs/es-handover-guide.md:11-59`.
