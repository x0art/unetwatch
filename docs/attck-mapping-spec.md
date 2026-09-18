# ATT&CK Mapping Spec — Field-Driven Technique Resolution

> **Status:** design + core implemented (`app/services/attck_mapping.py`)
> **Author:** uNetWatch backend
> **Companion documents:** `docs/field-sample-report.md` (field inventory template),
> `app/services/es_fields.py` (mode resolver), `app/services/query_builder.py`
> (`QUERY_SOURCE_FIELDS`).
> **Endpoint contract:** `GET /api/attck/host/{ip}`, `GET /api/attck/url/{url}`
> (unchanged — see §g).

---

## 0. The one rule that governs everything

> **A technique is emitted only when every field its predicate reads is present
> in Elasticsearch. When a required field is absent, the technique is
> *suppressed* (not guessed), and the reason is recorded.**

This is the field-driven inversion the operator asked for. Today the heuristics
are written as if `action`, `domain`, `server_ip`, `bytes_downloaded`, … always
exist. They do not. `QUERY_SOURCE_FIELDS` is only the *projection list* handed to
Elasticsearch; ES silently omits fields a document does not carry, and
`apply_filters` then **fabricates empty-string columns** for any missing name
(`app/services/result_processor.py:88-110`). A missing `action` therefore looks
exactly like `action=""`, and a missing `domain` looks like a column of empty
strings. Heuristics that read those columns are, in the current code, reading
fabricated data. §b–§e fix that by resolving real field availability **before**
any heuristic runs.

The mode vocabulary is the one the app already has
(`app/services/es_fields.py:_resolve_mode`): `UC-A`, `UC-B`, `COLLAPSED`,
`UNKNOWN`. This spec extends it to ATT&CK; it does not invent a second one.

---

## a) Field → Technique Capability Matrix

Every field is classified by **how it is resolved**:

| Resolver | Meaning | Implementation |
|---|---|---|
| `MODE` | Present iff the resolved mode is UC-A or UC-B | `mode_has_extended_findings()` |
| `BASELINE` | One of the six fields `_resolve_mode` requires for any non-UNKNOWN mode | `@timestamp, url, client_ip, server_ip, duration_seconds, action` |
| `INV_MODE` | True only when mode ∈ (UC-A, UC-B); in COLLAPSED the inventory is *identical* to the baseline set, so a non-baseline field is `ABSENT`, never `UNKNOWN` | `resolve_availability()` |
| `INVENTORY` | Present iff seen in the cached field inventory (sample keys ⊆ field_caps); `UNKNOWN` when mode is UNKNOWN, or when mode is COLLAPSED and the field is not in `@timestamp, url, client_ip, server_ip, duration_seconds, action` | `get_cached_inventory()` |

`UNKNOWN` (≠ `ABSENT`) is important: it means "we cannot tell", and it is
treated as **not present** by the gate while still being reported distinctly in
`data_sources` as `field_inventory:unknown`.

### a.1 Fields in `QUERY_SOURCE_FIELDS`

> **Implemented vs proposed.** Rows and predicates marked **NOT IMPLEMENTED**
> are design targets that require an ingest field this deployment does not
> publish yet; they are named here so the operator can see what the extra
> fields would buy, *not* because the engine computes them. Everything without
> that marker is live in `app/services/attck_mapping.py`. §b.2 is the
> authoritative inventory of what actually runs.

| Field | Resolver | Techniques it can evidence | Confidence | Exact predicate |
|---|---|---|---|---|
| `url` | `BASELINE` | T1090.003, T1071.001 (interval) | LOW / MEDIUM | `url_host(url) ∈ CDN/Proxy` → T1090.003 LOW. The extension/`upload_path` heuristics listed in §c.2 (`url_ext_class`, `content_addressed_download`) are **NOT IMPLEMENTED** — they need `content_type`/`response_size`. T1105 currently bottom-hops on `bytes_downloaded` + `distinct_clients` |
| `client_ip` | `BASELINE` | T1071.001 (URL), T1105 | — (denominator) | `distinct_clients = nunique(client_ip)` |
| `server_ip` | `BASELINE` | T1583.003, T1583.001, T1029.001 | LOW / MEDIUM | T1029.001: `distinct_dest_ips ≥ 10 ∧ enforcements ≤ risk_requests·0.5 ∧ total_bytes ≥ 1e6`. T1583.003: `1 ≤ distinct_dest_ips ≤ 5 ∧ time_span_hours ≥ 12 ∧ risk_share ≥ 0.5 ∧ no CDN domain`. T1583.001: `distinct_dest_ips ≥ 20 ∧ distinct_domains ≥ 20 ∧ total_requests ≤ 3·distinct_dest_ips` — **and, additionally to the table's `required`, `domain` PRESENT**. `dest_asn_entropy` is **NOT IMPLEMENTED**: it needs an ASN enrichment field that does not exist yet (see §c.2) |
| `@timestamp` | `BASELINE` | T1053.005, T1029.001, T1071.001 (interval regularity) | MEDIUM | `interval_cv = σ(Δt_between_bursts)/μ(Δt) ≤ 0.35 ∧ n_intervals ≥ 10`; `slot_concentration ≥ 0.5`; both `None` (→ UNKNOWN) below 10 samples |
| `action` | `BASELINE` | T1204.002, T1078, T1567, T1114.002, T1041 | MEDIUM / LOW | `risk_requests = #{action ∈ (ALLOW, "")}`, `enforcements = #{action ∈ (DENY, FLAG)}`. T1204.002 uses a plain `enforcements ≥ 3` burst floor; the finer `burst_gate` bucketing in §c.2 is **NOT IMPLEMENTED** (it needs the `state` field) |
| `duration_seconds` | `BASELINE` | *(none as a detector)* | — | Volumetric **proxy only**: `bytes_proxy = Σ max(1, floor(duration_seconds)) × 8192`. Used as a byte fallback; never evidence on its own. **⚠ SUPERSEDED 2026-09-18 (evidence: §j.6, fix §j.9.2):** "never evidence on its own" was **not enforced by the gate** — T1041 has no `required` leg, so `duration_seconds` alone unlocked it. On the real traffic (`duration_seconds: 0.01`) the proxy invents ~8 KiB/row (**38×** the real 215 B) and reaches T1105's `1e6` floor at **122** ordinary denied requests. The proxy may now only *supplement* a measured byte field; it can no longer be the sole basis for crossing a byte threshold. |
| `domain` | `INV_MODE` | T1090.003, T1583.003, T1041, T1583.001 | LOW / MEDIUM | **⚠ SUPERSEDED 2026-09-18 (evidence: §j.2):** `domain` **does not exist** in the operator's documents and is **fabricated as `""` by `apply_filters`** (`result_processor.py:98-110`), so every predicate here is dead in this deployment — `category` (`"facebook.com"`) is the real domain carrier. The rows below remain the design target for a deployment that *does* publish `domain`. T1090.003: `cdn_domain_count ≥ 1 ∧ risk_share ≥ 0.2`. T1583.003: `cdn_domain_count == 0` (absence of CDN is part of its predicate). T1041: `distinct_domains ≥ 3 ∧ total_bytes ≥ 1e8 ∧ risk_share ≥ 0.5`. T1583.001: `distinct_domains ≥ 20`. `duration_cv` and `burst_gate` are **NOT IMPLEMENTED** (see §c.2) |
| `base_url` | `INV_MODE` *(derived)* | T1071.001, T1105, T1090.003 | MEDIUM | **Never read raw** — `apply_filters` always recomputes it from `url`, so `base_url` is *derived*, not a resolved field. Blacklist subtraction uses it |
| `category` | `INV_MODE` | T1204.002, T1071.001 (URL), T1105 | MEDIUM / LOW (downgrade-only) | `risk_category_share = #{category ∈ RISK_TAGS} / total`; only ever **downgrades** the confidence of a predicate established from `url`/`domain` |
| `http_method` | `INV_MODE` | T1567, T1114 | LOW | `method_upload_share = #{http_method ∈ (POST,PUT,PATCH)} / total ≥ 0.4` |
| `http_status_code` | `INV_MODE` | *(supporting)* | — | `not_found_rate = #{http_status_code == 404} / total ≥ 0.5` — a *beaconing* qualifier, never a detector |
| `country_code` | `INV_MODE` | T1583.003 (concentration) | LOW | `country_entropy = H(country_code); ≤ 1.0 ⇒ NOT evidence` (concentration is the *opposite* of bulletproof hosting) |
| `bytes_downloaded` | `INV_MODE` | T1105, T1041 | MEDIUM / LOW | T1105: `download_bytes ≥ 1e6 ∧ download_bytes/total_bytes ≥ 0.9` **and** `content-addressed download` (`archive_ext(url) ∨ hash-named(filename)`); T1041 byte leg only |
| `bytes_uploaded` | `INV_MODE` | T1041, T1567, T1114 | LOW / MEDIUM | `upload_bytes ≥ 5e7 ∧ upload_share ≥ 0.6` |
| `rule_info` | `INV_MODE` | *(policy context — **SUPERSEDED, see §j.3**)* | — | **Hard ABSENT**: every row already matched a block pattern, so a `rule_info` label is a superset fact and can never evidence a technique. **⚠ SUPERSEDED 2026-09-18 (evidence: §j.3):** `rule_info` **is present** (`"RN190,SNI,BS"`), so "Hard ABSENT" misstates its availability. It still cannot evidence a technique — but because the code set is **undocumented**, not because it is missing. Correct disposition: **PRESENT but UNINTERPRETABLE**. If the operator supplies the code table it becomes the strongest signal in the document (new §j.11 handover item 1). |
| `rule_name` | `INV_MODE` | `T1567.002` (class name) | LOW | `T1567.002 ⇐` when `{category, rule_name, rule_info}` ∩ `{upload, box, dropbox, s3, oos, exfil}` — **name-mapped only for techniques in the taxonomy**; `oos` is a uNetWatch *class*, not a technique, so it contributes nothing on its own |
| `user_id` | `INV_MODE` | *(identity lens — **SUPERSEDED, see §j.1**)* | — | **Hard ABSENT.** A non-empty `user_id` is an *authenticated* principal — the opposite of T1078 (valid accounts being abused anonymously). Never emits T1078; may only *raise* the confidence of a T1071.001 beacon to HIGH when stable across the window. **⚠ SUPERSEDED 2026-09-18 (evidence: §j.0–j.1):** in the operator's real documents `user_id` is an **IP address**, identical to `client_ip` (`user_id: "172.21.122.6"`; corroborated by `tests/test_patterns.py:802` `user_id: "172.21.26.84"`). It is **not** a principal, carries no identity, and must be treated as an **alias of `client_ip`** — context only. The "raise T1071.001 to HIGH" clause is **withdrawn**. The reasoning above stays valid only for a deployment that actually has principals. |
| `matched_patterns` | `INV_MODE` | *(block classes)* | — | Consumed by the app's own `risk_weight_*` scoring (`readout.py:_normalize_class_name`). A block-pattern class name is **not** a technique id; not used in mapping |
| `user_agent` | `INV_MODE` | T1071.001 (HTTP *client* tooling) | LOW | `distinct_user_agents ≤ 3 ∧ distinct_domains:clients ≈ 1:1` — a *tool*, not a human browser. **`ua ≉ C2`:** custom UA ⇒ LOW · a *known browser UA* ⇒ **suppress** (the textbook attack beats mimicry; a socket-based tool wears the default UA of its library) |

### a.2 Extended fields the app already knows about (not in `QUERY_SOURCE_FIELDS`)

These are the operator-added fields named in `docs/field-sample-report.md §4`;
each is `INVENTORY`-resolved and each adds exactly one observable.

| Field | Resolver | Signal | Techniques | Confidence |
|---|---|---|---|---|
| `username` / `session` | `INV_MODE` | Identity continuity (`stable_identity = nunique ≤ 2`) — a *supporting* field, not a detector | T1071.001 | HIGH (supporting) |
| `request_size` | `INVENTORY` | Replaces the `duration_seconds×8192` proxy for per-request bytes; `{size}` path template becomes observable → same-path byte-exfil test | T1041, T1029.001 (precision) | +1 level |
| `response_size` | `INVENTORY` | Content-length distribution per endpoint; **decisive** for T1105 (`large signed binary` vs `small gzip auto-refresh`) | T1105 | +1 level |
| `content_type` | `INVENTORY` | Direct classifier: `exe\|dll\|msi\|ps1\|apk\|elf` ⇒ executable tool · `octet-stream` ⇒ content-addressed download · `health/version` ⇒ **anti-beacon → suppress T1071.001** | T1105 | +1 level |
| `request_header_len` | `INVENTORY` | Near-free per-row payload size: fixed-size POST beacons / same-path byte accounting (replaces the marginal TCP/IP estimate) | T1041, T1029.001 | +1 level |
| `request_header_size` | `INVENTORY` | Same as above | T1041, T1029.001 | +1 level |
| `method` | `INVENTORY` | Alternate name for `http_method` when the ingestion pipeline renames it | T1567, T1114 | as `http_method` |
| `response_status` | `INVENTORY` | Alternate name for `http_status_code` | qualifier only | — |
| `bytes` / `response_bytes` | `INVENTORY` | Alternate name for the byte counters | T1105, T1041 | as bytes_* |
| `rule` | `INVENTORY` | Alternate name for `rule_name` → policy-class name map | `T1567.002` | as `rule_name` |
| `client_ip_req_time` (double-encoded string) | `INVENTORY` | **Ingestion bug, not a feature.** A JSON-encoded string makes the whole row opaque to ES field mapping | *(none)* | **suppress all row-level techniques when it co-occurs with `client_ip`; emit `field_inventory:suspect_pipeline`** |

`server_ip` is covered in a.1 but carries three techniques (T1583.003, T1583.001,
T1029.001) and the T1583.* pair is easy to over-read: **no public CDN domain
appears under the T1583 predicates**, because that placement is deliberate
(T1090.003's `⇒(T1583.003)` is the *one* exception). A **domain-only** view
loses T1583.003/T1583.001 entirely.

### a.3 Techniques permanently out of reach

A proxy log is a **record of HTTP flows**, not a host-level event stream. The
following technique classes are **structurally excluded by the data source**.
This list is deliberately conservative: a false "cannot" is cheap, a false
"can" pollutes an operator's ATT&CK layer for weeks. Out of reach:

| Out-of-reach class | Example techniques | Why the proxy log cannot evidence it |
|---|---|---|
| All **execution** | T1059.*, T1203, T1055, T1140 | No process creation, no `process_name`/`command_line`/`parent_process`, no image-load telemetry. A proxy sees a `GET`; it never sees the thing that issued it |
| All **host-file** | T1547.*, T1543, T1546, T1053.005 host, T1112, T1218, T1003, T1552 | No registry keys, no file paths, no service/PATH; the client state is entirely on the correct side of a wall the proxy cannot see past |
| **DNS query semantics** | T1071.004, T1568, T1583.001 domain-generation form, T1048.004 | No query type (A/AAAA/TXT/CNAME), no NXDOMAIN rate, no DGA entropy — only post-resolution IPs |
| **Named-pipe / IPC** | T1055.001 | Requires endpoint telemetry |
| **Host scheduling** | T1053.001, T1053.003, T1053.005 *(as a system scheduler)* | A marker holds only that a *caller* retried roughly evenly; it cannot prove a scheduler exists. The marker is preserved with this caveat and **never** carries more than LOW |
| **Nested-tunnelling proof** | T1090.001/.002/.004/.005, T1572 | A proxy log shows the *result* of routing, not the route of routes |
| **Host exfil primitives** | T1048.001–.003, T1048 high-side | No USB, no mail, no host-service path |

**T1090.003 ↔ T1583.003 are not in this list.** They are `network-only,
achievable`: T1090.003 is the *positive* marker (a session persisted through
third-party CDN/relay — an intermediate is empirically present in the path) and
T1583.003 is its *warning* reading (repeat contact with exotic ASNs; provider
*evidence*, not vendor-intent attribution). Their presence here is the honest
correction of the old code, which emitted T1090.003 on the classifier alone.

---

## b) The Mode-Adaptive Strategy

### b.1 Field resolution per mode (implemented)

```
resolve_availability() → {"action": PRESENT|ABSENT|UNKNOWN, "domain": …, "user_agent": …}

baseline = {@timestamp, url, client_ip, server_ip, duration_seconds, action}
inventory = sample.keys() ∪ field_caps        # the real, observed field set
resolved_mode = get_mode()

mode == UNKNOWN or resolved_mode == UNKNOWN → every field = UNKNOWN

otherwise, for every field:
    field ∈ baseline                          → PRESENT
    field ∈ inventory                         → PRESENT   # inventory-driven, all modes
    field ∈ mode_rejected                     → ABSENT    # see below
    else                                      → UNKNOWN   # not sampled — never ABSENT

mode_rejected = {user_agent, username, session}  if mode == COLLAPSED
              = {}                               otherwise
```

> **⚠ SUPERSEDED 2026-09-18 (evidence: §j.8/§j.9.1).** The block above used to
> read:
>
> ```
> mode ∈ (UC-A, UC-B):
>     field ∈ baseline → PRESENT ; field ∈ inventory(mode) → PRESENT ; else → ABSENT
> mode == COLLAPSED:
>     field ∈ baseline → PRESENT ; else → ABSENT   # inventory ⊆ baseline here
> ```
>
> with the prose *"The COLLAPSED hard-ABSENT rule is the load-bearing clause.
> In COLLAPSED the inventory is, by definition, exactly the six baseline
> fields."* **That premise is false against real Elasticsearch.** The inventory
> is the union of the sampled document's keys and `field_caps`, so real
> documents carry non-baseline fields, and forcing them to `ABSENT` **hid
> readable data** — the bug fixed in §j.9.1.
>
> The corrected rule keeps the original concern ("one sampled document must not
> be read as the whole schema") but expresses it as `UNKNOWN`, not `ABSENT`.
> `ABSENT` is now reserved for the closed set of names `_resolve_mode`
> **explicitly tested and rejected** — in COLLAPSED that is exactly
> `{user_agent, username, session}`, because the function evaluates
> `issubset(sample)` and `all(f in caps)` for those and returns COLLAPSED only
> after both fail. For every other name the mode asserts nothing, so
> `UNKNOWN` is the honest state and the gate treats it as closed. The
> "one-request health check" worry is fully addressed: a field absent from both
> the sample *and* `field_caps` is `UNKNOWN` (closed), never presumed present.

**`base_url` is exempt from the gate**: it is always `PRESENT` as *derived*,
because `apply_filters` recomputes it from `url` on every call. Its underlying
field (`url`) is `BASELINE`; its derived output is always present.

### b.2 Technique availability per mode

**Every row below is implemented.** `_HOST_HEURISTICS` carries 12 techniques and
`_URL_HEURISTICS` carries 3; there are no aspirational rows in this table — a
technique is listed only if it has a registered predicate in
`_HOST_HEURISTICS_LIST` / `_URL_HEURISTICS_LIST` (a drift test asserts the
catalogue and the runner list agree, so the two can never silently diverge).

The state column means:

* **on** — reachable in that mode, *given* traffic that meets the predicate.
* **O** — the technique's required fields do not exist in that mode, so the gate
  withholds it and a reason is recorded.

A technique marked **on** is not "always emitted": it is *eligible*. In a mode
where its evidence fields are present but the threshold is unmet, the predicate
declines and nothing is emitted (no suppression is recorded, because nothing was
withheld).

| Technique | UC-A | UC-B | COLLAPSED | UNKNOWN |
|---|---|---|---|---|
| `T1071.001` App-Layer Protocol (host) | **on** · HIGH | **on** · MED | **on** · MED | O — `mode=UNKNOWN` |
| `T1071.001` App-Layer Protocol (URL) | **on** · MED | **on** · MED | **on** · MED→LOW | O — `mode=UNKNOWN` |
| `T1090.003` Proxy: Multi-hop (host) | **on** · MED | **on** · MED | **on** · LOW | O — `mode=UNKNOWN` |
| `T1090.003` Proxy: Multi-hop (URL) | **on** · LOW | **on** · LOW | **on** · LOW | O — `mode=UNKNOWN` |
| `T1029.001` Scheduled Transfer | **on** · MED | **on** · MED | **on** if a byte counter is in the inventory, else **O** (measured bytes required — §j.9.2) | O — `mode=UNKNOWN` |
| `T1053.005` Scheduled Task/Job | **on** · LOW | **on** · LOW | **on** · LOW | O — `mode=UNKNOWN` |
| `T1041` Exfil Over C2 Channel | **on** · LOW | **on** · LOW | **on** if a byte counter is in the inventory, else **O** (measured bytes required — §j.9.2) | O — `mode=UNKNOWN` |
| `T1078` Valid Accounts | **on** · MED | **on** · MED | **on** · LOW | O — `mode=UNKNOWN` |
| `T1583.003` Acquire Infrastructure: VPS | **on** · LOW | **on** · LOW | **on** · LOW | O — `mode=UNKNOWN` |
| `T1583.001` Acquire Infrastructure: Domains | **on** · LOW *(requires `domain` — see guard)* | **on** · LOW | O (no `domain`) | O — `mode=UNKNOWN` |
| `T1105` Ingress Tool Transfer (URL) | **on** · MED | **on** · MED | **on** if a byte/response field is in the inventory, else **O** | O — `mode=UNKNOWN` |
| `T1567` Exfil Over Web Service | **on** · MED | **on** · MED | **on** if a byte counter is in the inventory, else **O** | O — `mode=UNKNOWN` |
| `T1567.002` Exfil To Cloud Storage | **on** · LOW | **on** · LOW | **on** if `rule_name`/`category` is in the inventory, else **O** | O — `mode=UNKNOWN` |
| `T1204.002` User Execution: Malicious File | **on** · MED | **on** · LOW | **on** · LOW *(needs `action` + `url`)* | O — `mode=UNKNOWN` |
| `T1114.002` Email Collection: Remote | **on** · LOW | **on** · LOW | **on** if a byte counter is in the inventory, else **O** | O — `mode=UNKNOWN` |

> **⚠ The COLLAPSED column was rewritten 2026-09-18 (evidence: §j.8/§j.9.1).**
> It previously read **"withheld"** for T1105/T1567/T1567.002/T1114.002 on the
> theory that COLLAPSED's inventory equals the baseline six. Real ES disproves
> that, so the *gate* is open for any technique whose fields the inventory
> actually shows; whether it fires then depends on its predicate, not the mode.
> "O" now means one thing only: the required field is genuinely not in the
> inventory. On the operator's real documents (which carry `bytes_*`,
> `category`, `rule_name`) these are therefore **eligible and decline on
> threshold**, not withheld — see §j.8's worked outcome.

`T1190` Exploit Public-Facing Application is **not implemented and not
listed**: a proxy log carries the *result* of an exploit, not the request
semantics that prove one, so it is permanently out (see §a.3).

Notes on three rows that are easy to misread:

* **`T1583.001`** carries a *predicate-level* `domain` guard in addition to its
  catalogue `server_ip` requirement: it names **domains**, so without a readable
  `domain` field it declines rather than calling an unreadable column a domain
  set. That makes it "on" in UC-A/UC-B and **O** in COLLAPSED.
* **`T1204.002`** requires `action` (to see the burst) and `url`; both are
  baseline, so it is eligible in every resolvable mode. Its *evidence* is
  `enforcements` (a burst of rejected navigation), which COLLAPSED can read.
* **`T1078`** requires `client_ip` + `action`, both baseline, so it is eligible
  in COLLAPSED; it carries a window-dependent caveat below.

### b.3 Mode-degradation summary

- **`UC-A` / `UC-B`** — the full catalogue is *eligible*. `user_agent` may only
  *downgrade* T1071.001, never upgrade it, and its absence in UC-B is not
  charged a confidence step (the mode itself proves the lens field's
  availability — see `_MODE_PROVEN_FIELDS`).
- **`COLLAPSED`** — **⚠ SUPERSEDED 2026-09-18 (evidence: §j.8):** the paragraph
  below assumed `COLLAPSED ⇒ inventory == baseline six`. That invariant is
  **false against real ES** (`inventory_field_names()` unions `_source` keys with
  `field_caps`, so a real document's `category`/`bytes_*`/`rule_name` resolve
  **PRESENT** even in COLLAPSED — executed, §j.8). **This is the operator's
  permanent mode** (no `username`/`session` in the schema), and its realistic
  output is **≤ 2 LOW techniques** (T1053.005, T1204.002) plus predicate
  declines — *not* the withhold list below. `T1583.001` is the one technique
  genuinely withheld, by its own predicate-level `domain` guard. The original
  claim is retained for reference: baseline-only detectors stay eligible
  (T1071.001, T1090.003, T1078, T1041, T1029.001, T1053.005, T1583.003,
  T1204.002); everything `domain`/`bytes_*`/`rule_name`-gated was believed
  withheld with a reason. T1041 and T1029.001 may use the
  `duration_seconds × 8192` proxy — **but no longer as sole evidence** (§j.9.2),
  and they say so via `bytes_source = "duration-proxy"`.
- **`UNKNOWN`** — zero techniques, `es_online` faithful to the real error, and
  an explicit reason string. Preserved verbatim from the pre-existing
  behaviour.

---

## c) Signal Catalogue

### c.1 Existing signals

| Signal | Formula | Fields read | Failure mode when a field is absent | Feeds |
|---|---|---|---|---|
| `total_requests` | `len(df)` | *(any row)* | Cannot fail — row count survives every projection | de-boost denominator |
| `risk_requests` | `#{action ∈ (ALLOW, "")}` + de-boost | `action` | **`action` ABSENT in COLLAPSED ⇒ `risk_requests = total_requests` is a FABRICATION.** Corrected by `apply_risk_boost`: `risk_share < 0.9 ⇒ × 0.3` | T1204, T1078, T1567, T1114 |
| `enforcements` | `#{action ∈ (DENY, FLAG)}` | `action` | Absent ⇒ `0`, and the de-boost below makes `risk_requests` a *floor* | T1029.001 |
| `blacklisted_requests` | `#{base_url ∈ blacklist}` | *derived* `base_url` (+ `url`) | Never — `base_url` is recomputed from the BASELINE `url` | everywhere (`blacklisted ⇒ HIGH`) |
| `distinct_domains` | `nunique(domain)` | `domain` | Absent ⇒ `0`; `0` fails every `≥ n` gate ⇒ the dependent technique is suppressed | T1041, T1567, T1114, T1204, T1078 |
| `distinct_dest_ips` | `nunique(server_ip)` | `server_ip` | A client-side *loopback/enumeration* set (`> 2 ⇒ × 0.5`, `== 1 ⇒ × 0.5`) — a **de-boost on T1029.001 only**, never a boost | T1029.001 |
| `distinct_http_methods` | `len(set(http_method))` | `http_method` | Absent ⇒ `{}` — informational only today | — (candidate) |
| `total_bytes` | `Σ bytes_downloaded + Σ bytes_uploaded` | `bytes_downloaded`, `bytes_uploaded` | Absent ⇒ **`total_bytes = 0` is `UNKNOWN`, never `0 low`.** Byte techniques are suppressed; if `duration_seconds` is PRESENT, `0 < total ≤ 50000 ⇒ duration-proxy` instead | T1041 |
| `risk_share` | `risk_requests / total_requests` | `action` (via `risk_requests`) | Floors at `0.9/3 = 0.3` under COLLAPSED — enough for T1071.001/T1090.003, insufficient for T1567/T1567.002/T1114/T1204 | every share gate |
| `periodicity_score` | **retained on the wire contract only, always `0.0`** — the old `1 − std/mean` formula is deleted (§c.3) | `@timestamp` | never computed; **no predicate reads it** | *(none)* |
| `cdn_domain_count` | `Σ is_cdn(domain)` | `domain` (+ CDN list) | Absent ⇒ `0` ⇒ T1090.003 falls back to the **`url`-host classifier** (a first-class path, not a fallback-of-last-resort — it is just LOW on its own) | T1090.003, T1583.003 guard |
| `time_span_hours` | `(max(@timestamp) − min(@timestamp)) / 3600` | `@timestamp` | No rows ⇒ `0` | T1567/T1567.002/T1078 (>14d guard) |
| `total_accesses` | `len(df)` / findings `Σ cnt` | *(any row)* | Never | T1071.001 (URL), T1105 |
| `distinct_clients` | `nunique(client_ip)` | `client_ip` | Absent ⇒ `0`; the `findings` source never has it | T1071.001 (URL), T1105 |
| `host_is_cdn` / `host_is_proxy` | `_is_cdn(host)` / `_is_proxy(host)` | `url` (host substring) | Never | T1090.003 |
| `is_link_follow` | URL host ≠ `Referer` host **and** `Referer` host ∉ CDN list | `url` + ingest-level `referer` (INVENTORY) | Absent ⇒ `False`; a user click is explicitly **not** C2 | T1071.001 (URL) → downgrade |

**The `action`-absent fabrications, named plainly:**

```python
# WRONG — a missing `action` is NOT 100 % ALLOW
risk_requests = total_requests; enforcements = 0
# RIGHT — de-boost a byte-only/legacy stream to a risk FLOOR
risk_share_eff = max(0.0, (total - 0.5*enforcements_proxy)/total) if action else
                 risk_share * 0.3
```

### c.2 New signals

**Implemented** in `attck_mapping.py`: `upload_bytes`, `upload_share`,
`interval_cv`, `slot_concentration`, `download_bytes`, `bytes_source`
(`"bytes"` / `"duration-proxy"` / `"none"`).

**Proposed — NOT IMPLEMENTED.** These are listed because they are the next
increment once the corresponding ingest field lands (§f items 2–3). Nothing
below is computed today; a predicate must not be written against them until it
is.

| Signal | Formula | Fields | Failure mode | Feeds | Status |
|---|---|---|---|---|---|
| `upload_bytes` | `Σ bytes_uploaded` | `bytes_uploaded` | Absent ⇒ `None` (UNKNOWN) | T1041, T1567, T1114.002 | **implemented** |
| `upload_share` | `upload_bytes / total_bytes` | both byte counters | Absent ⇒ `None` | T1567, T1114.002 | **implemented** |
| `download_bytes` | `Σ bytes_downloaded` | `bytes_downloaded` | Absent ⇒ `None` | T1105, T1041 | **implemented** |
| `bytes_source` | provenance tag: `bytes` / `duration-proxy` / `none` | byte counters, `duration_seconds` | never | all byte techniques (evidence) | **implemented** |
| `interval_cv` | `σ(Δt between bursts) / μ(Δt)`, merge gap 1 h, `n ≥ 10` | `@timestamp` | Sparse ⇒ `None` (UNKNOWN, never `0.0`) | T1071.001 (beacon ↑), T1053.005 | **implemented** |
| `slot_concentration` | best of 12 × 5-min offset phases' share of all requests | `@timestamp` | `< 2` slots ⇒ `None` | T1053.005, T1029.001 | **implemented** |
| `method_upload_share` | `#{http_method ∈ (POST,PUT,PATCH)} / total` | `http_method` | Absent ⇒ not used | T1567, T1114.002 | proposed |
| `request_size_cv` | `σ(request_size)/μ(request_size)` | `request_size` | Absent ⇒ UNKNOWN | T1041, T1029.001 | proposed |
| `periodicity_by_width` | `k* = argmax_k slot_concentration(k)`, `k ∈ {30 s, 1 m, 5 m, 15 m, 1 h}` | `@timestamp` | `< 6 slots` ⇒ UNKNOWN | T1053.005 | proposed |
| `slot_score` | `1 − |2·frac(u) − 1|` with `u = minutes-of-hour` | `@timestamp` | short runs ⇒ `0.0` | presentation only | proposed |
| `url_ext_class` | `suffix(url) → {plugin, binary, archive, document, script, none}` | `url` | `none` always available | T1105 | proposed |
| `content_addressed_download` | octet-stream ∧ hash-named filename | `content_type` + `url` | Absent ⇒ UNKNOWN | T1105 | proposed |
| `not_found_rate` | `#{http_status_code == 404} / total` | `http_status_code` | Absent ⇒ UNKNOWN | T1071.001 qualifier | proposed |
| `dest_asn_entropy` | `H(normalized_as_org(server_ip))` | `server_ip` + **ingest-level ASN enrich** | ASN absent ⇒ UNKNOWN | T1583.003 | proposed (needs ASN field) |
| `dest_net16_diversity` | `nunique(truncate16(server_ip))` | `server_ip` | `server_ip` ABSENT ⇒ `0` | T1583.001 | proposed |
| `same_path_byte_flow` | share of byte volume on the busiest normalised URL | `url` + `bytes_*` (+ `method`) | Absent ⇒ UNKNOWN | T1041 | proposed |
| `fixed_size_form` | `#{same (url, request_size)} ≥ n_appearances` | `url` + `request_size` | Absent ⇒ UNKNOWN | T1041 | proposed |
| `duration_cv` | `σ(duration_seconds)/μ(duration_seconds)` | `duration_seconds` | Absent ⇒ UNKNOWN | T1078 | proposed |
| `stable_identity` | `nunique({username, session}) ≤ 2` | identity fields | blank-on-doc ⇒ downgrade | T1071.001 (support) | proposed |
| `burst_gate` | `#{ t : risk_t ≥ 10 ∧ enforcements_t < t·0.1 } ≥ 3` | `action`, `@timestamp` | neutral `GFW` `state` values are not `action` codes | T1204.002 | proposed (needs `state`) |
| `request_summary` | `n_requests / unix_seconds` (a RATE) | `@timestamp` + row count | never | display only | proposed |
| `action_correlated_temporally` | leading `action,state` pair flips at least once in-window | `action` + `state` | `action`-only correlation insufficient | warning confidence | proposed (needs `state`) |
| `url_host_is_cdn` / `url_host_is_proxy` | `_is_cdn/_is_proxy(url_host)` | `url` | never | T1090.003, T1583.003 guard | **implemented** |

`critical_patterns`: only an operator-supplied list (`["*.exe", "*ransom*"]`) may
promote a match to T1204.002 / CRITICAL. `action="deny"` is **not** an
`action ∈ (DENY, FLAG)` code and is **never** by itself an
enforcement/destination marker — a deny is a *branch* to inspect, not a hit.

### c.3 Periodicity — what actually ships, and what it cannot see

**The historical `1 − std/mean` score is not sound for sparse buckets, and was
deleted.** `_periodicity_score` computed the index of dispersion inverted over
the window's buckets:

```
σ/μ = √λ / λ = 1/√λ          (Poisson)
score ≈ 1 − 1/√λ  →  1 as λ grows
```

It was **monotone in sample density, not in periodicity**: with 1500 requests
over 24 h (λ = 1/48 per 5-minute slot) the index is ≈ 0.144, so a *real*
periodic process scores 0.14 while a busier log of the same process scores
0.9. In the sparse regime the floor was capped by geometry — a heartbeat
landing one 5-minute bucket in five gave `mean 3.2, std 6.4 → 1 − 2.0 = 0.0`.
**`_periodicity_score` is DELETED from the module**, not merely bypassed: a
formula kept "for the coarse cases" gets reused for the coarse cases it is
wrong about. A drift test asserts its absence. The wire field
`signals.periodicity_score` remains on the contract at its `0.0` default (the
frontend's `AttckSignal` declares it optional), but **no predicate reads it**.

Two replacement statistics ship. They do **not** have equal power, and the
section states the split honestly rather than implying a grid search that was
never implemented.

**(1) `_interval_cv` — the load-bearing detector.** The coefficient of
variation of the **raw inter-arrival gaps** of `@timestamp` (full resolution;
no burst merging), `None` below `n = 10` gaps. Measured:

| Stream | `interval_cv` |
|---|---|
| 1-minute heartbeat, exact | 0.00 |
| 1-minute heartbeat, 5 % jitter | 0.07 |
| 1-minute heartbeat, 20 % jitter | 0.28 |
| 1-hour lockstep, exact | 0.00 |
| Poisson (uniform) load, ~1/min | **0.97** |
| bursty human traffic | **0.96** |

The threshold is `≤ 0.35`, which separates a machine beat (≤ 0.28 even at
20 % jitter) from organic load (~0.97) with a wide margin. An earlier version
merged arrivals within 1 hour into "bursts" before measuring; that was exactly
backwards — on a dense stream it collapsed a 1-minute beat to one arrival per
hour and Poisson noise to the same, so the two became indistinguishable and
slightly *inverted* (a jittered beat scored 0.005, noise 0.014). The merge is
gone.

**(2) `_slot_concentration` — a coarse corroborator, with a stated aliasing
limit.** It buckets the timeline's span into fixed **5-minute** slots, takes
each slot modulo one shift-hour (12 phases), and returns the busiest phase's
share of all requests, `None` below 2 slots. **It cannot detect a cadence
finer than its slot grid.** `build_timeline` buckets the data at
`minutes // 48` — 5 min at a 4 h window (matching), but **30 min at 24 h and
210 min at 7 d** — so once the data is bucketed wider than 5 minutes the
cadence is already gone. Measured on the real 24 h path:

| Stream (24 h window) | `_slot_concentration` |
|---|---|
| 1-minute heartbeat | 0.5 |
| 30-minute lockstep | 0.5 |
| uniform Poisson load | **0.5** |
| 1-hour lockstep | 1.0 |

So it discriminates a 1-hour lockstep only, and is **bit-identical to uniform
load** for everything faster. Earlier revisions of this section claimed a
per-width search `for k ∈ {30s, 1m, 5m, 15m, 1h}` with the phase offset
searched — **that was never implemented**, and the "1-minute heartbeat scores
16·288/86400 = 0.053 (5.3 %)" arithmetic described a 1-minute grid the code
does not have. Those claims are removed.

**The honest consequence.** A fast cadence (1–5 min) is found by
`_interval_cv`; `_slot_concentration` adds corroboration for a coarse
lockstep. `_heuristic_t1053_005_host` fires on **either** (`interval_cv ≤
0.35` **or** `slot_concentration ≥ 0.5`), gated behind `total_requests ≥ 30`,
at **LOW** — never higher, because a marker proves only that a *caller*
retried evenly; it cannot prove a scheduler exists (§a.3).

**Minimum-sample rule (mandatory):** both statistics return `None`
(→ UNKNOWN, technique not emitted) rather than a fabricated `0.0` when their
sample floor is unmet — `interval_cv` below 10 gaps, `slot_concentration`
below 2 slots. `n = 2` means "cannot tell", never "acyclic".

---

## d) Confidence Model

`severity` is the surviving wire field (`AttckTechnique.severity`), so the model
is expressed in its three labels: **HIGH · MEDIUM · LOW**.

| Label | Means | Requires |
|---|---|---|
| **HIGH** | A network-only strong signal **plus** independent corroboration, or a blacklist hit | Presence-class (known-bad) **OR** (a strong signal **AND** ≥ 1 independent corroborator) |
| **MEDIUM** | A qualifying network-only strong signal, or ≥ 2 weak signals that multiply to a true positive | qualifying predicate; `blacklisted_requests == 0`; a recognised volume floor |
| **LOW** | **co-occurrence**, case by case — a warning, not a fact | field presence, but zero independent corroboration |

### d.1 The downgrade table (mechanically applicable)

| Condition | Effect |
|---|---|
| any contributing field `ABSENT` | −1 step (or suppress if the field was **required**) |
| any contributing field `UNKNOWN` (mode unknown / not sampled) | −1 step, marked `field_inventory:unknown` |
| `action` **absent** (COLLAPSED) | `risk_share` × 0.3 (floors at 0.3) **AND** −1 step on T1204/T1078/T1567/T1114; T1071.001/T1090.003 keep MEDIUM |
| window `< 24 h` | −1 step if the signal is retention-sensitive; must end `LOW` |
| session `> 7 d` | at most `LOW` |
| handover-bound `PRESENT` but document-absent/blank | **downgrade, never gate** — "present in inventory" ≠ "present on **this** doc" |
| `action="deny"` *without* a `kind="ip"` blacklist entry | never destination-level evidence (per-row `deny` only) |
| `rule_class="oos"` alone | **no technique** — a uNetWatch class, not a technique id |
| `critical_class` (`*.exe|*.dll|*.ps1|*.apk|*.msi`) alone | **T1105 LOW** (§d.2); `T1204.002` requires a **non-navigational content type** — `octet-stream`/`zip` ⇒ `LOW` |
| `scheduled_interval` **n < 20** | −1 step; n < 10 ⇒ **not a detector** (downgrade to time-of-day only) |
| `interval_cv`, `slot_concentration` (or any proposed `*_cv` / `payload_cv`) with `n < 10` | −1 step; below the minimum the statistic returns `None` (UNKNOWN), so the dependent technique is suppressed rather than mis-scored |
| `stealth` **present but blank** | **downgrade** — the tool is *present* and not *stating intent*; a blank must never read as benign |
| detector-suite is **CDN-only** | T1105 ⇒ **at most `LOW`** — a CDN package is a file *delivered*, not a file *installed*; `content-addressed` supplies the *extra* evidentiary weight to reach MEDIUM |

### d.2 Worked example — the same URL, three modes

Entity: `http://update.acme-cdn.example/installer.exe`, three hits, one client.

**Mode `UC-A`** (`action`, `bytes_downloaded`, `bytes_uploaded`, `domain` present):

```
total_bytes      = 3 × download_bytes          (real counters -> bytes_source="bytes")
risk_share       = 1.0   (action PRESENT: all three rows ALLOW, not fabricated)
distinct_clients = 1     -> T1071.001 (URL) needs >= 3, so not emitted
T1105: requires {"url"} + any of {bytes_downloaded, response_size, request_size}
       bytes_downloaded >= 1e6  AND  total_accesses >= 20
       -> total_accesses is 3, so the PREDICATE declines
```

Emitted: **no technique.** The evidence was not there — a 3-hit URL is not a
tool-transfer pattern at any confidence.

**Mode `UC-B`** (`user_agent` absent; byte counters still present):

```
same numbers as UC-A
T1105 gate: met (byte fields present); predicate declines (total_accesses < 20)
```

Emitted: **no technique**, same reason. Note what did *not* happen: the absent
`user_agent` was not charged a confidence step, because `_MODE_PROVEN_FIELDS`
excludes it (UC-A/UC-B itself proves the lens field's availability, so charging
for it would drop a UC-A result below its own UC-B baseline).

**Mode `COLLAPSED`** (`domain`/`bytes_*`/`category` = **ABSENT**):

```
T1105 gate: requires any of {bytes_downloaded, response_size, request_size}
            -> none present in this mode
```

Emitted: **no technique**, and this time the gate records *why*:

```
summary: "... | suppressed: T1105: requires any of bytes_downloaded,
          response_size, request_size; none present (present: @timestamp,
          action, client_ip, duration_seconds, server_ip, url)"
techniques[].evidence.field_availability.bytes_downloaded == "absent"
```

The panel shows an empty list, the summary names the reason, and the evidence
carries the full field-availability map. **That empty result is the spec
succeeding** — it refuses to say "medium-risk tool transfer" about a log that
carries only URLs.

---

## e) Anti-Fabrication Rules (normative)

1. **Presence gates emission.** A technique's predicate may read only fields that
   resolve to `PRESENT`. A predicate with any required `ABSENT`/`UNKNOWN` field is
   **suppressed**, and the suppression reason is a first-class output (§g).
2. **No field is ever re-derived from a fabricated column.** `apply_filters`
   default-fills missing columns with `""`; the gate must run against the
   *pre-fill* field set (`available_fields`, a new `Signal` field), **never**
   against `df.columns`.
3. **`UNKNOWN ≠ 0`.** `total_bytes`, `download_bytes`, `upload_bytes`,
   `upload_share`, `interval_cv`, `slot_concentration` and any proposed
   `dest_asn_entropy` take an `UNKNOWN` state (modelled as `None` on `Signal`,
   which `_gate` treats as unavailable) distinct from a numeric `0`. A
   `count = 0` may legitimately feed a threshold; an `UNKNOWN` may not.
4. **Signal provenance ships in `evidence`.** Every emitted technique carries the
   signal names and values that produced it (`"total_requests":914`, …) plus the
   availability of every field it read. An operator can re-derive the verdict
   from the JSON without reading the code.
5. **`mode == UNKNOWN` emits zero techniques** with a clear reason string
   (`summary = "UNKNOWN mode: techniques not resolvable"`). If ES is reachable but
   the *user's own grouping field* was never sampled, the engine
   **suppresses/edits rather than blanks the whole layer**: the "unknown field"
   resolution overrides the "mode/group blank" rule, but never loosens the
   `mode == UNKNOWN` total-suppression above.
6. **No invented technique IDs.** Only IDs present in the catalogue
   (§a/§b) may appear. A uNetWatch class name is never echoed as a technique id.
7. **No speculative predicates.** Every predicate must be expressible as a
   formula over the fields in §a. Ideas that cannot be — e.g. a PC-*panel*
   shortcut, a BitTorrent DHT tracker, a proxy-*onion* hostname mnemonic — are
   explicitly out (see the judgment calls in §h).
8. **Absent ≠ benign.** `rule_info`/`user_id`/`matched_patterns` resolve to
   **ABSENT-contextual** and are context only. `action` may be legitimately
   absent (everything already matched a block pattern); a `state` field that *is*
   sampled changes how you *read* `action` (a neutral `GFW` `state` is **not** an
   `action` code) — this is one of the strongest reasons the underlying ES schema
   must be confirmed from **real** documents, not the schema hero the operator ran
   on to name the request.

---

## f) Handover Checklist (what the operator must provide)

**Auth: this app uses `X-API-Key`, not Basic.** `verify_admin` in
`app/config.py` checks the `X-API-Key` header against `API_KEY` (then against
the session-token store) *before* it accepts Basic, and the SPA sends the same
header (`admin-ui/src/api.ts`). `docs/es-handover-guide.md` §1 carries the
token-acquisition snippet; do not hand-write `-u admin:<pass>` calls — the
`WWW-Authenticate` challenge is deliberately `Bearer` only to stop browsers
popping a native Basic dialog, so `Bearer` will **not** authenticate.

### Preferred path — one command, items 1–7

`scripts/collect_es_fields.py` collects everything below in a single read-only
run (connection metadata, `_mapping`, `_field_caps`, a 3-document verbatim
`_source` sample, the field-presence table, the resolved mode, and cardinality
hints). It never writes to ES and exits `0` even when ES is unreachable — check
`es_reachable` and `notes` before trusting the output.

```bash
python scripts/collect_es_fields.py --out docs/es-field-handover.json
```

> Use this as the default. The per-item commands below exist for the cases the
> collector cannot cover (the app-side inventory cross-check, the exact query,
> and the labelled pair) or when a single item needs re-collecting.

### Per-item commands

| # | Item | Exact collection command | Goes where |
|---|---|---|---|
| 1 | **ES index name** | `grep -E '^ELASTIC_(HOST\|INDEX)' .env` | `docs/field-sample-report.md §1.3` header |
| 2 | **Verbatim sample docs** | `python scripts/collect_es_fields.py --out docs/es-field-handover.json` (collects 3) — or ES-direct: `curl -s -u "$ELASTIC_USER:$ELASTIC_PASS" -H 'Content-Type: application/json' "$ELASTIC_HOST/$ELASTIC_INDEX/_search?size=3&filter_path=hits.hits._source" \| jq '[.hits.hits[]._source]' > docs/sample-doc.json` | paste verbatim (§1.1) |
| 3 | **`field_caps` output** | `curl -s -u "$ELASTIC_USER:$ELASTIC_PASS" -H 'Content-Type: application/json' "$ELASTIC_HOST/$ELASTIC_INDEX/_field_caps?fields=*" \| jq . > docs/field-caps.json` | §1.2 |
| 4 | **App inventory** | `curl -s -H "X-API-Key: $TOKEN" http://localhost:8000/api/es/fields \| jq . > docs/es-fields.json` | §1.3 resolves the mode |
| 5 | **The exact query used** | `curl -s -H "X-API-Key: $TOKEN" http://localhost:8000/api/logs \| jq '.logs[0].query'` | append to §2 so predicates are run against the real projection |
| 6 | **The raw hit count** | `curl -s -u "$ELASTIC_USER:$ELASTIC_PASS" "$ELASTIC_HOST/$ELASTIC_INDEX/_count" \| jq .count` | §2 sanity — confirms the operator's window is populated |
| 7 | **Two labelled documents — MANDATORY** | one document the operator *knows* is benign and one they *know* is malicious, as full `_source` (redact identifiers if needed, **keep every field name and every numeric value**) | `docs/es-field-handover.json` → new `labelled_examples` block; feed into the threshold calibration below |

**`$TOKEN` acquisition** (from `docs/es-handover-guide.md` §1):

```bash
export TOKEN="$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<ADMIN_PASS>"}' | jq -r .token)"
```

### Item 7 is mandatory, and here is why

**All byte and volume thresholds in §a are UNCALIBRATED.** They are inferred
from the app's existing `8192 bytes/second` convention (`analytics.py` derives
volume as `duration_seconds × 8192` when no byte counter exists) — that is the
*only* number in this repository with a size dimension, and it is a proxy, not
a measurement. Every predicate of the form `total_bytes ≥ 1e8`,
`download_bytes ≥ 1e6`, `upload_bytes ≥ 5e7`, or `bytes_share ≥ 0.6` is
therefore a placeholder that will misfire on a deployment whose normal traffic
is orders of magnitude away from those values (a small internal proxy will
never trip `1e8`; a busy CDN ingress mirror will trip it constantly).

The labelled pair is what converts those placeholders into thresholds:

1. Take the malicious example's byte/volume values as a **lower bound target**;
   take the benign example's as the **upper bound the predicate must not
   cross**. Set each threshold between them, closer to the benign side.
2. If no value separates the pair (e.g. both documents carry
   `bytes_downloaded` of the same order), the byte-gated technique cannot be
   calibrated from two documents — say so in the report rather than guessing,
   and leave those predicates at their conservative (high-threshold) defaults.
3. If either label is unavailable, the byte-gated techniques (T1105, T1041,
   T1567, T1567.002, T1114.002, T1029.001) remain **advisory only** and the
   spec must say so wherever they appear.

**DoD checklist (extended from `field-sample-report.md`):**

- [ ] sample (≥ 1 doc, verbatim) + `field_caps` + resolved mode collected
- [ ] the baseline six confirmed: `@timestamp`, `url`, `client_ip`,
      `server_ip`, `duration_seconds`, `action`
- [ ] extended fields recorded (`domain`, `bytes_*`, `category`,
      `http_method`, `http_status_code`, `country_code`, `rule_*`, `user_id`)
- [ ] identity fields recorded (`user_agent`, `username`, `session`)
- [ ] the `state` / `action` code set enumerated (which values mean
      ALLOW / DENY / FLAG / neutral)
- [ ] **item 7 supplied, or the byte/volume thresholds explicitly marked
      UNCALIBRATED and their techniques marked advisory**

> The `WARNING` in `docs/es-handover-guide.md` §2 applies to every artifact
> here: sample documents carry verbatim URLs, IPs, usernames and session
> identifiers. Review before attaching the file to anything.

---

## g) Response Shape (unchanged) & the `suppressed` field

The endpoint contract is **frozen** — the frontend depends on it
(`admin-ui/src/components/AttckPanel.tsx`, `admin-ui/src/api.ts:2104-2143`):

```ts
AttckTechnique { technique_id, name, severity: "HIGH"|"MEDIUM"|"LOW", description, evidence }
AttckMapping   { entity, generated_at, data_sources, es_online, signals, techniques, summary }
```

**Where suppression reasons actually live.** An earlier revision of this
section claimed they appear in `techniques[].evidence`. That was wrong, and
worth stating plainly: `_evaluate` returns `(None, {"id", "reason"})` for a
suppressed technique (`attck_mapping.py:715-717`), and the runners append that
dict to a local list *without ever creating a technique object*
(`attck_mapping.py:1195-1222`). A suppressed technique therefore has **no
`techniques[]` entry at all** — so there is no `evidence` object that could
carry its reason. Pointing the operator there was pointing at a field that
cannot contain suppressions.

The reasons are surfaced in three places, all of which are populated on every
path (`map_host`, `map_url` live, `map_url` findings):

1. **`signals.suppressed`** — `list[{"id": str, "reason": str}]` on the
   `Signal` dataclass, assigned from the runner's local `suppressed` list
   (`attck_mapping.py` `map_host` / `map_url` tails). This is the structured,
   machine-readable home. It is **additive**: `AttckSignal` in
   `admin-ui/src/api.ts` declares no index signature, and an extra key on a
   TS interface is ignored rather than a compile error, so the type only
   needed the optional `suppressed?` member that was added alongside it.
2. **`summary`** — the same list rendered as prose, appended by
   `_with_suppressed()`: `" | suppressed: T1105: requires any of …; none
   present (present: …)"`. This existed before and is unchanged.
3. **`signals.available_fields`** — the resolved PRESENT/ABSENT/UNKNOWN map
   for every field, which is what lets a reader re-derive *why* a gate closed.
   `data_sources` also carries `field_inventory:<mode>` /
   `field_inventory:unknown` as badges.

`AttckPanel.tsx` renders `signals.suppressed` as a short "N techniques
withheld — required fields were absent" list under the technique table. This
matters: without it the panel showed only "No ATT&CK techniques detected",
which is indistinguishable from a clean result.

**`AttckTechnique.evidence` is unchanged and still means what it says**: the
provenance of a technique that *was* emitted (`es_mode`, `bytes_source`,
`field_availability`, the signal values, `confidence_downgrade`). It is not a
suppression channel, and §e.4's "signal provenance ships in `evidence`" refers
only to emitted techniques.

**A top-level `AttckMapping.suppressed` is still not added.** `signals` is the
natural home — suppressions are an observation about this mapping's inputs,
not a sibling of `techniques` — and it keeps `AttckMapping` byte-for-byte at
its frozen key set.

---

## h) Judgment Calls (review these)

1. **T1105 / T1567 are *gated empty* in `COLLAPSED`**, because both bottom out in
   byte fields that do not exist there. If the operator wants a weaker proxy, it
   belongs in a **data-quality warning**, not an ATT&CK technique.
2. **T1583.003 is rendered as an *Infrastructure* technique, not in-app C2.** The
   data supports "infrastructure with botnet-like characteristics"; anything
   stronger is an inference.
3. **The `1 − std/mean` score was deleted outright** rather than kept for the
   "coarse" cases — the sparse regime *is* the coarse regime in a proxy log, and
   any surviving copy gets reused. A naive `1/CV` = `μ/σ` replacement was
   rejected: it exceeds 1 and would be a worse bug for a score bounded to
   `[0, 1]`. **See §c.3 for what replaced it** — the interval CV of raw
   arrivals is the load-bearing detector; the fixed-slot statistic is a coarse
   corroborator only.
4. **`user_agent` can only downgrade**, never upgrade. See §a.1.
5. **One weakly-evidenced exclusion was recorded and left OUT of the code**: a
   proxy/onion host-name mnemonic was floated but unverifiable, so it is
   **suppressed** even though the substring list exists. The *CDN* read alone
   feeds T1090.003 at LOW.
6. **Out-of-reach §a.3 is deliberately conservative.** If a reviewer disagrees on
   one class, move it under "requires additional ingest fields" **with the field
   named**, do not re-enable it on a mnemonic.

7. **Suppression reasons were moved to `signals.suppressed`, not
   `techniques[].evidence`** (§g). The old claim was false on its face — a
   suppressed technique emits no technique object, so it has no evidence to
   write into. `signals` was chosen over a top-level key because it keeps
   `AttckMapping`'s key set frozen and because a suppression is an observation
   about the mapping's inputs. The frontend renders it as a "withheld"
   list under the table, so an all-suppressed result is no longer
   indistinguishable from a clean one.
8. **The periodicity detector reads raw arrivals, not the bucketed
   timeline** (§c.3). `build_timeline` bins at `minutes // 48` — 30 min at a
   24 h window — which aliases every cadence faster than the bucket width to
   uniform load. The interval CV had to read `@timestamp` directly to have any
   discrimination at all, and the burst-merge that used to destroy that
   discrimination was removed.

---

## i) Changelog

| Date | Change | By |
| 2026-09-18 | Field-driven availability gate, technique-availability resolver, mode-adaptive suppression, fixed-slot periodicity, confidence downgrade | backend |
| 2026-09-18 | Field-inventory cache no longer poisoned by a failed boot fetch (success-only caching + 30 s negative-TTL retry throttle) and refreshed hourly; suppression reasons moved to `signals.suppressed` (§g corrected); periodicity reworked onto raw-arrival interval CV with the slot aliasing limitation stated (§c.3) | backend |

| 2026-09-18 | **Reconciliation with the operator's verbatim documents (§j).** Eight claims corrected: `user_id` is a `client_ip` alias not a principal; `domain` is absent & fabricated (`category` carries the domain); `rule_info` is present but undocumented; `http_status_code: 0` = no upstream response; byte thresholds inert on DENY traffic; the `duration-proxy` inflated ~38× and **was reachable as sole evidence for T1041** — now fixed so it may only supplement a measured byte field; `host.ip`/`message` recorded as unused provenance/recovery fields. **Deployment is permanently COLLAPSED** (no `username`/`session`), so the realistic panel is ≤ 2 LOW techniques. The `COLLAPSED ⇒ inventory == baseline` invariant is **false against real ES**. §b.2/§b.3 COLLAPSED column superseded. | backend |

| 2026-09-18 | **Two code fixes from the §j traces.** (1) `resolve_availability` no longer marks every non-baseline field `ABSENT` in COLLAPSED — presence is now inventory-driven (`field_caps` ∪ sampled `_source`) in every mode, with `ABSENT` reserved for the closed set `_resolve_mode` explicitly tested and rejected, and `UNKNOWN` for fields no source mentions (§j.9.1). (2) `duration_seconds` removed from the `required_any` legs of T1041/T1029.001 and a `bytes_source == "bytes"` check added to both predicates, so the duration proxy can no longer be sole evidence for crossing a byte floor (§j.9.2); T1567/T1114.002/T1567.002 audited and unchanged (§j.12). | backend |

---

## j) Reconciliation with the Operator's Real Documents (2026-09-18)

> **Status:** a verbatim `logstash-proxy-*` document was supplied and read against
> this spec. Eight claims above are **contradicted by the data**. This section is
> the corrected record; the affected rows above are marked *superseded* rather
> than deleted, so the reasoning that produced them stays visible.
>
> **The headline is §j.8, not the field-level corrections.** The operator's
> deployment resolves to `COLLAPSED` **permanently** — not because of a
> transient sampling gap, but because the two fields `_resolve_mode` requires
> for UC-A/UC-B (`username`, `session`) do not exist in the schema and are
> listed in `docs/field-sample-report.md §4.2` as *fields to request*. The
> engine therefore withholds most of the enriched catalogue on every real
> query. §j.8 traces this line by line; §j.9 records the two implementation
> bugs the trace exposed.

### j.0 The document under review (verbatim, `logstash-proxy-*`)

```json
{
  "_index": "logstash-proxy-2026.08.31",
  "_id": "kjVDWqABEYGXh41EPOrt",
  "_source": {
    "@version": "1", "category": "facebook.com", "rule_info": "RN190,SNI,BS",
    "rule_name": "facebook.com", "action": "DENY",
    "@timestamp": "2026-08-31T23:59:11.000Z", "user_id": "172.21.122.6",
    "server_ip": "57.144.192.3", "url": "https://z-m-gateway.facebook.com/",
    "duration_seconds": 0.01, "host": {"ip": "172.21.73.13"},
    "event": {"original": "[01/Sep/2026:06:59:11 +0700] 172.21.122.6 … DENY RN190,SNI,BS BE \"facebook.com\""},
    "bytes_downloaded": 0, "bytes_uploaded": 215,
    "client_ip": "172.21.122.6", "country_code": "BE",
    "message": "[01/Sep/2026:06:59:11 +0700] 172.21.122.6 172.21.122.6 57.144.192.3 \"facebook.com\" 0.01 - https://z-m-gateway.facebook.com/ - 0 215 DENY RN190,SNI,BS BE \"facebook.com\"",
    "http_status_code": 0
  }
}
```

### j.1 `user_id` is an IP alias, not an authenticated principal — **CONFIRMED contra §a.1**

§a.1's `user_id` row asserted: *"A non-empty `user_id` is an **authenticated**
principal — the opposite of T1078 … Never emits T1078; may only *raise* the
confidence of a T1071.001 beacon to HIGH when stable across the window."*

**That assertion is false for this deployment.** In the sample,
`user_id == client_ip == "172.21.122.6"`, character-for-character. This is not
a one-document coincidence: the app's own test fixture carries the same shape
in a different client —
`tests/test_patterns.py:802` has `"user_id": "172.21.26.84"`, an IP, on an
`"action": "ALLOW"` row. No `username`/`session` field exists anywhere in the
repo outside `_resolve_mode` itself and the *proposed*-fields table in
`docs/field-sample-report.md:80-81`.

**Corrected claim.** In this deployment `user_id` is a **second spelling of
`client_ip`**, not an identity lens:

* It carries **no authenticated-principal information**; treating it as such
  was the source of the "may raise T1071.001 to HIGH" clause, which must not
  stand on an IP.
* It **must not** be read as identity continuity / `stable_identity`. Two rows
  with the same `user_id` are two rows from the same **source IP** — which
  `client_ip` already says.
* It is therefore **demoted to an alias of `client_ip`**: context only,
  confirming provenance, contributing **no** independent technique evidence.
  §e.8's "ABSENT-contextual" treatment was right for the wrong reason — the
  field is not absent-contextual because a principal is absent; it is
  context-only because it is a duplicate of a baseline field.
* The "may only *raise* T1071.001 to HIGH" clause is **withdrawn**: a stable
  IP alias adds nothing `client_ip` did not already provide.

> The row is **superseded**, not deleted, at §a.1 — the reasoning ("T1078 is
> anonymous abuse; a real principal is its opposite") remains correct *for a
> deployment that has principals*. This one does not.

### j.2 There is no `domain` and no `base_url`; `category` carries the domain — **CONFIRMED contra §a.1, §c.1**

The document has **no `domain` key and no `base_url` key**. The destination is
carried by **`category`** (`"facebook.com"`) and `url`
(`"https://z-m-gateway.facebook.com/"`), with `rule_name` also
`"facebook.com"`.

**Is `domain` "projected and therefore fabricated by `apply_filters`"?**
Verified: **yes, exactly.** `domain` is named in `QUERY_SOURCE_FIELDS`
(`app/services/query_builder.py:22`) but is absent from every real document;
`apply_filters` then default-fills it —
`for col in (… "domain", "category", …): if col not in df.columns: df[col] = ""`
(`app/services/result_processor.py:98-110`). So a heuristic that reads `df["domain"]`
reads a column of **empty strings synthesized by the app**, never data from ES.
§0 of this spec names this fabrication; §j.9 confirms the gate had a hole that
let it through in one mode.

**`category` is the real domain carrier.** It holds `facebook.com` — a
registrable domain. §a.1 currently classes `category` as
`T1204.002/T1071.001/T1105`, **downgrade-only**, and §c.1's `distinct_domains`
reads `domain`. Both under-read the deployment:

* `distinct_domains`, `cdn_domain_count`, and every `domain`-gated predicate
  (T1041, T1567, T1114, T1583.001, T1090.003's CDN leg) are **dead** here —
  `domain` is `ABSENT`, so the gate withholds them, even though a perfectly
  usable domain set sits in `category`.
* This is a **precision gap, not a safety one** (withholding is the safe
  direction), and it is the honest correction to record: `category` *could*
  carry the domain leg. Promoting it is a **calibration change** that needs the
  labelled pair from `docs/field-sample-report.md` item 7; it is recorded here
  as the next increment, not silently enabled.

### j.3 `action="DENY"`, `rule_info="RN190,SNI,BS"`, `country_code="BE"` — **CONFIRMED, with a decode question §a.1 does not answer**

The doc carries `action: "DENY"` (so §c.2's claim that `FLAG` and enforcement
codes are unavailable is **only partly** true — `DENY` is present and is an
enforcement code, and `_aggregate_host_signals` reads it,
`attck_mapping.py:1458`), plus `rule_info: "RN190,SNI,BS"` and
`country_code: "BE"`.

**What the `rule_info` codes are — verified, and the answer is "not decodable
from this repository".** `RN190`, `SNI`, `BS` are a **comma-separated
rule/condition code set** emitted by the classifying proxy. Grepping the whole
repo finds them **only** in this sample and in the sample the operator
pasted — there is **no decoder table, no enum, and no documentation** of what
`RN190`/`SNI`/`BS` mean. The one structural read the data supports: three
independent tokens, and `BS` matches the trailing `BE` country code loosely,
suggesting `BS`/`BE` are *country* or *category* codes while `RN190` looks like
a **rule number** and `SNI` a **match surface** (Server Name Indication — i.e.
the classifier matched on TLS SNI, which fits `rule_name: "facebook.com"`).

§a.1's `rule_info` row declares it **"Hard ABSENT … can never evidence a
technique."** That conflates two different things and must be corrected:

* `rule_info` **is present** in this deployment (it is not absent), so
  "Hard ABSENT" is wrong as a statement of availability.
* It **still cannot evidence a technique**, but for the right reason: **the
  code scheme is undocumented**, so no predicate can be written against it
  (§e.7 — "no speculative predicates"). The correct disposition is
  **PRESENT but UNINTERPRETABLE**, reported as context and as a
  data-quality note, not silently dropped.
* **It is a far stronger signal than the current engine exploits** *if* the
  operator supplies the code table — a documented severity/category scheme
  would be the single highest-value addition in this document, well above any
  byte heuristic. That is a **handover item**, added to §f.

### j.4 `http_status_code: 0` is not a status — **CONFIRMED contra §a.1**

§a.1: `not_found_rate = #{http_status_code == 404} / total ≥ 0.5` as a
beaconing qualifier. On this traffic the field is **`0`** on every denied row,
because a DENY is answered by the proxy and **never reaches an upstream**, so
no HTTP status exists. `#{… == 404}` is therefore **0 on the entire denied
mix**, and the qualifier can only ever read `0.0` — *vacuous, not merely
weak*. The predicate is correctly marked **NOT IMPLEMENTED**; this is the
evidence for why it must stay that way until an ingest field carries a real
status (`0` must be treated as *"no upstream response"*, **not** as a status
code).

### j.5 `bytes_downloaded: 0` / `bytes_uploaded: 215` — **CONFIRMED; the byte predicates are near-vacuous here**

On a DENY, `bytes_downloaded` is `0` and only the request side carries bytes.
Verified against the §a.1 thresholds:

| Predicate | Threshold | This traffic | Verdict |
|---|---|---|---|
| T1105 `download_bytes` | `≥ 1e6 ∧ download/total ≥ 0.9` | download `= 0` | **structurally unreachable** |
| T1041 byte leg | `total_bytes ≥ 1e8` | ≈ `215`/row | unreachable at any realistic window |
| T1567 `upload_bytes` | `≥ 5e7 ∧ upload_share ≥ 0.6` | share `= 1.0` passes, bytes fail | **share gate passes on a vacuous denominator** |

The last row is the one to flag: **`upload_share = upload/(upload+download)`
is `1.0` by construction on an all-DENY stream** (download is always 0), so
the *share* leg is satisfied by arithmetic, not by upload behaviour. It is
saved only by the absolute byte floor. Any relaxation of that floor would
make T1567 fire on ordinary blocked traffic. **The byte-threshold predicates
are not wrong, but they are inert here** — and a share computed over a
zero-download mix must never be read as evidence of upload.

### j.6 `duration_seconds: 0.01` → the `duration-proxy` invents ~8 KiB/row — **CONFIRMED fabrication risk, contra §a.1/§c.1**

§a.1: `bytes_proxy = Σ max(1, floor(duration_seconds)) × 8192`, declared
"used as a byte fallback; never evidence on its own."

Verified arithmetic on this data (`max(1, floor(0.01)) = 1`):

| Quantity | Value |
|---|---|
| real bytes / row (download+upload) | `215` |
| proxy bytes / row | `8192` |
| **invented per row** | **`7977`** — a **38×** overstatement |
| rows to reach T1105's `1e6` | **122** |
| rows to reach T1567's `5e7` | 6103 |
| rows to reach T1041's `1e8` | 12207 |

So **122 ordinary denied requests** manufacture a "1 MB tool transfer" from
nothing. §a.1 says the proxy is "never evidence on its own", but T1041's
catalogue entry has **no `required` leg at all** — only
`required_any: (bytes_uploaded, bytes_downloaded, duration_seconds)`
(`attck_mapping.py:316`) — so `duration_seconds` **alone** unlocks the gate,
and the predicate then compares the *invented* total against a real threshold.
The "never evidence on its own" claim is **not enforced by the gate**; it is
enforced only inside T1041's `≥ 1e8` floor, which the proxy reaches at ~12k
rows. **This is a genuine fabrication path on this traffic mix** and the
correction is recorded in §j.9.

### j.7 `host.ip`, `event.original`, `message`, `@version` — **CONFIRMED: the app never reads them, and the raw line is the richest field present**

* **`host.ip` = `172.21.73.13`** — an internal address, distinct from the
  client (`172.21.122.6`) and the destination (`57.144.192.3`). It is the
  **proxy/gateway node itself**, i.e. *which sensor produced the log*. The app
  does not read it. It buys **provenance and multi-node correlation**: on a
  fleet of proxy nodes it is the dimension that turns "the organisation saw
  this" into "node `172.21.73.13` saw this", which is what a NOC triages on.
  It is **not** a technique field and must never be treated as one.
* **`message` / `event.original`** — the **full raw log line**, which is a
  strict superset of the flat fields:
  `… 172.21.122.6 172.21.122.6 57.144.192.3 "facebook.com" 0.01 - https://z-m-gateway.facebook.com/ - 0 215 DENY RN190,SNI,BS BE "facebook.com"`.
  It carries the timestamp (in `+0700`), client, server, the category in
  quotes, **duration (`0.01`)**, the response size (`0`), the request size
  (`215`), the action, the rule code set, and the country (`BE`). Everything
  the flat fields carry, plus a **parseable positional structure**.

  **What a `message`-parsing path could buy:** the two things the flat schema
  loses — (a) the **positional role** of each number (the flat schema gives
  `bytes_downloaded`/`bytes_uploaded` but not which field is request vs
  response size in the line), and (b) any **field the projection drops**.
  It is a *recovery* path, not a new detector: it re-derives signals the flat
  fields already flatten, so it belongs behind a parser with tests, **not**
  as a regex in a predicate. Recorded as a handover item (§f), not enabled.
* **`@version`** — Logstash pipeline metadata, constant `"1"`. No analytic
  value.

### j.8 Mode resolution: this deployment is **permanently COLLAPSED** — traced line by line

`_resolve_mode` requires, in order (`app/services/es_fields.py:164-196`):

```
baseline = {@timestamp, url, client_ip, server_ip, duration_seconds, action}
uc_a_extra = {user_agent, username, session}
uc_b_extra = {username, session}
```

Traced against the real document (executed, not reasoned):

| Test | Result |
|---|---|
| `baseline ⊆ sample.keys()` | **True** — all six present |
| `{user_agent, username, session} ⊆ …` | **False** — all three missing |
| `{username, session} ⊆ …` | **False** — both missing |
| **`_resolve_mode(...)`** | **`"COLLAPSED"`** |

**This is not a sampling artifact — it is the schema.** `username` and
`session` appear nowhere in the deployment: `docs/field-sample-report.md:80-81`
lists them under *"4.2 Upgrade to UC-A (Identity Lens)"* as fields to **ask the
proxy team for**, with the note *"Requires `user_agent` also present for full
UC-A."* Until that ingest change lands, **every** query resolves to COLLAPSED.

**What that withholds.** Executing the real gate
(`_gate`, `attck_mapping.py:716`) under this document's resolved availability:

| Technique | Gate state | Why |
|---|---|---|
| `T1071.001` host | **eligible** | `@timestamp` only |
| `T1090.003` host | **eligible** | `url` only |
| `T1029.001` host | **eligible** | `server_ip` + a byte leg |
| `T1053.005` host | **eligible** | `@timestamp` only |
| `T1041` host | **eligible** | `required_any` includes `duration_seconds` |
| `T1078` host | **eligible** | `client_ip` + `action` |
| `T1583.003` host | **eligible** | `server_ip` only |
| `T1567` host | **eligible** | byte leg present in inventory |
| `T1114.002` host | **eligible** | `url` + byte leg |
| `T1204.002` host | **eligible** | `action` + `url` |
| `T1583.001` host | **eligible at the gate**, **declines in the predicate** | predicate-level `domain` guard refuses (`:1019`) |
| `T1567.002` host | **eligible** | `rule_name`/`category` present in inventory |
| `T1071.001` / `T1105` / `T1090.003` URL | **eligible** | `url` (+ byte leg for T1105) |

**The important correction to the table above — and to §b.2.** §b.1 asserts
that *"in `COLLAPSED` the inventory is, by definition, exactly the six baseline
fields"* and that every non-baseline field is therefore `ABSENT`. **That is
false for real ES data.** The inventory is the *union of the sampled document's
keys and `field_caps`* (`es_fields.inventory_field_names()`,
`es_fields.py:220-243`), and real documents carry `category`,
`bytes_downloaded`, `bytes_uploaded`, `rule_name`, `http_status_code`,
`country_code`, `user_id`. The original resolver nevertheless forced those to
`ABSENT` in COLLAPSED, hiding fields the engine can read; **this was the first
implementation bug (§j.9.1) and is now fixed** — `resolve_availability` is
inventory-driven in every mode, so it resolves those to **PRESENT** (executed:
`bytes_downloaded → present`, `category → present`), and the byte-gated
techniques are **eligible** rather than withheld.

**Net effect on the operator's real data.** With the deployment's actual
document shape and a representative window, the host catalogue emits:

```
T1053.005 (LOW)   — only if the interval CV / slot statistic passes
T1204.002 (LOW)   — only on a ≥100-request, ≥3-enforcement burst
(everything else declines in its predicate — correct behaviour)
```

and the URL catalogue emits **nothing** (a single client on a `facebook.com`
gateway URL fails T1071.001's `distinct_clients ≥ 3` and T1105's byte floor).
So the operator's realistic panel is **at most two LOW techniques**, and the
withheld rows are **not** the ones §b.3 lists — `T1567`/`T1567.002`/`T1114.002`
are *eligible* and decline on threshold, while `T1583.001` is the one genuinely
withheld by its own `domain` guard. **§b.2/§b.3's COLLAPSED column is
superseded by this table.**

### j.9 The two implementation bugs this review exposed — both now fixed

Both were found by executing the real document against the real resolver, and
both are fixed in code (`app/services/attck_mapping.py`) and pinned by tests.
The original (wrong) behaviour is described so a reader can see what changed
and why.

1. **The COLLAPSED hard-ABSENT rule was wrong.**
   `resolve_availability` treated *any* non-baseline field as `ABSENT` in
   COLLAPSED, on the theory that "the inventory is exactly the baseline six".
   Real Elasticsearch disproves it: `inventory_field_names()` is the **union**
   of the sampled document's keys and `field_caps`, and real `logstash-proxy`
   documents carry `category`, `bytes_downloaded`, `bytes_uploaded`,
   `rule_name`, `http_status_code`, `country_code` and `user_id` — none of
   which `_resolve_mode` ever inspects. Declaring those `ABSENT` **hid fields
   the engine can genuinely read**, starving every byte- and category-reading
   heuristic on the operator's real data.

   **The fix resolves the original motivation honestly rather than flipping the
   branch.** The old code had a real concern — a single sampled document that
   happens to omit a field must not be read as "the field exists". But that
   concern points at *UNKNOWN*, not at `ABSENT`. The corrected rule has three
   tiers of authority:

   | Source | Verdict | Why |
   |---|---|---|
   | Seen in `field_caps` **or** in the sampled document | `PRESENT` | `field_caps` is the index-wide mapping (authoritative); a `_source` key a real document carries is readable, which is all a heuristic needs |
   | A name `_resolve_mode` **explicitly tested and rejected** — in COLLAPSED that is exactly `user_agent`, `username`, `session` | `ABSENT` | The mode ran a real presence test on that closed set and it failed both `issubset(sample)` and `all(f in caps)`; that is proof of absence |
   | Mentioned by **neither** source | `UNKNOWN` | The inventory is one document + a mapping, not a per-document census; silence is not proof of absence |

   So **presence is inventory-driven in every mode**, and the mode's only job is
   to mark the small closed set of names it actually tested as proven `ABSENT`.
   Before, the mode overrode the evidence; after, it contributes one narrow,
   defensible fact. `UNKNOWN` still gates closed, so the change cannot open a
   technique on a field nobody observed.

2. **The `duration-proxy` was reachable as *sole* evidence for T1041.**
   T1041's catalogue entry had no `required` leg — only
   `required_any: (bytes_uploaded, bytes_downloaded, duration_seconds)`. So
   `duration_seconds` **alone** opened the gate, and the predicate then
   compared an *invented* byte total against a real threshold. This is the bug
   §j.6's arithmetic exposed: at `duration_seconds: 0.01` the proxy invents
   8192 B/row against a real 215 B (**38×**), reaching T1105's 1 MiB floor on
   **122 ordinary denied requests**.

   **The fix enforces §a.1's own claim, at the gate.** Two layers:

   * the `required_any` legs of **T1041 and T1029.001** no longer list
     `duration_seconds` — a *measured* byte counter is now genuinely required;
   * each predicate additionally checks `bytes_source == "bytes"`, so even a
     caller that bypasses the catalogue (the findings path) cannot emit on the
     proxy alone.

   The proxy stays on the wire for **provenance** (`bytes_source =
   "duration-proxy"` is still reported); it just can no longer be the only
   basis for crossing a byte floor. T1029.001's 1 MB volume leg had the
   identical hole and took the same guard.

   **T1567 / T1114.002 do *not* share the hole** (§j.12): their `required_any`
   never listed `duration_seconds`, and both floors are on `upload_bytes`,
   which the proxy path sets to `0` (`_aggregate_host_signals`). They decline
   naturally on an upload floor, so no change was needed there.

### j.10 Corrections applied

| # | Spec claim (superseded) | Corrected claim |
|---|---|---|
| 1 | §a.1 `user_id` = authenticated principal; may raise T1071.001 to HIGH | `user_id` is a **`client_ip` alias** here; context-only; the raise clause is withdrawn |
| 2 | §a.1/§c.1 `domain` is `INV_MODE` and carries the domain leg | `domain` is **absent & fabricated by `apply_filters`**; `category` is the real domain carrier (promotion = next increment) |
| 3 | §a.1 `rule_info` = "Hard ABSENT" | `rule_info` is **PRESENT but UNINTERPRETABLE** (undocumented code set); context + data-quality note; highest-value handover item |
| 4 | §a.1 `not_found_rate` on `http_status_code` | `http_status_code == 0` means **no upstream response**; the predicate is vacuous on DENY traffic |
| 5 | §a.1 byte thresholds | Inert here; `upload_share = 1.0` on all-DENY is **arithmetic, not evidence** |
| 6 | §a.1 `duration-proxy` "never evidence on its own" | **Not enforced by the gate**; 38× inflation, T1105 reachable at 122 rows; now fixed (§j.9.2) |
| 7 | (silent) `host.ip`, `message`, `event.original`, `@version` | Recorded: `host.ip` = proxy-node provenance; `message` = superset raw line (recovery path); `@version` = no value |
| 8 | §b.1/§b.2/§b.3 COLLAPSED column | Deployment is **permanently COLLAPSED**; the hard-ABSENT invariant is **false**; realistic panel = ≤ 2 LOW techniques |

### j.11 Handover items this review adds to §f

1. **The `rule_info` code table** (`RN190`, `SNI`, `BS`, …) — the single
   highest-value artifact. A documented severity/category scheme would
   out-evidence every byte heuristic in §a.
2. **The `username`/`session` ingest** — the only path out of permanent
   COLLAPSED (`docs/field-sample-report.md §4.2`).
3. **A `message`-line format spec** — to build a tested parser for the
   positional fields the flat projection loses.
4. **Confirmation that `user_id` is an IP** on the operator's side, so the
   alias treatment (§j.1) can be promoted from *observed* to *documented*.

### j.12 The same-proxy-hole audit: T1567 / T1114.002 do not share it

§j.6 raised the question of whether the *other* byte-gated techniques carry
T1041's hole. They do not — verified against the catalogue and the aggregation
path:

| Technique | `required_any` | Byte leg | Proxy hole? |
|---|---|---|---|
| `T1041` | `(bytes_uploaded, bytes_downloaded, duration_seconds)` → **now `(bytes_uploaded, bytes_downloaded)`** | `total_bytes ≥ 1e8` | **yes — fixed** |
| `T1029.001` | same → **now `(bytes_uploaded, bytes_downloaded)`** | `total_bytes ≥ 1e6` | **yes — fixed** |
| `T1567` | `(bytes_uploaded, bytes_downloaded)` | `upload_bytes ≥ 5e7 ∧ share ≥ 0.6` | **no** |
| `T1114.002` | `(bytes_uploaded, bytes_downloaded)` | `upload_bytes ≥ 1e7` | **no** |
| `T1567.002` | `(rule_name, category)` | `upload_bytes ≥ 1e7` | **no** |

Two independent reasons neither of the latter three is affected:

1. **`duration_seconds` is not in their `required_any`**, so the gate never
   admits a duration-only stream in the first place.
2. **Their floors are on `upload_bytes`**, and the proxy branch of
   `_aggregate_host_signals` sets `upload_bytes = 0` while putting the invented
   total in `download_bytes` — so even a proxy-fed Signal fails the upload
   floor.

Only `T1041` and `T1029.001` listed `duration_seconds` as an alternative byte
leg, and those are exactly the two fixed in §j.9.2. **No change was needed for
T1567 / T1114.002 / T1567.002**, and none was made.
