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
| `duration_seconds` | `BASELINE` | *(none as a detector)* | — | Volumetric **proxy only**: `bytes_proxy = Σ max(1, floor(duration_seconds)) × 8192`. Used as a byte fallback; never evidence on its own |
| `domain` | `INV_MODE` | T1090.003, T1583.003, T1041, T1583.001 | LOW / MEDIUM | T1090.003: `cdn_domain_count ≥ 1 ∧ risk_share ≥ 0.2`. T1583.003: `cdn_domain_count == 0` (absence of CDN is part of its predicate). T1041: `distinct_domains ≥ 3 ∧ total_bytes ≥ 1e8 ∧ risk_share ≥ 0.5`. T1583.001: `distinct_domains ≥ 20`. `duration_cv` and `burst_gate` are **NOT IMPLEMENTED** (see §c.2) |
| `base_url` | `INV_MODE` *(derived)* | T1071.001, T1105, T1090.003 | MEDIUM | **Never read raw** — `apply_filters` always recomputes it from `url`, so `base_url` is *derived*, not a resolved field. Blacklist subtraction uses it |
| `category` | `INV_MODE` | T1204.002, T1071.001 (URL), T1105 | MEDIUM / LOW (downgrade-only) | `risk_category_share = #{category ∈ RISK_TAGS} / total`; only ever **downgrades** the confidence of a predicate established from `url`/`domain` |
| `http_method` | `INV_MODE` | T1567, T1114 | LOW | `method_upload_share = #{http_method ∈ (POST,PUT,PATCH)} / total ≥ 0.4` |
| `http_status_code` | `INV_MODE` | *(supporting)* | — | `not_found_rate = #{http_status_code == 404} / total ≥ 0.5` — a *beaconing* qualifier, never a detector |
| `country_code` | `INV_MODE` | T1583.003 (concentration) | LOW | `country_entropy = H(country_code); ≤ 1.0 ⇒ NOT evidence` (concentration is the *opposite* of bulletproof hosting) |
| `bytes_downloaded` | `INV_MODE` | T1105, T1041 | MEDIUM / LOW | T1105: `download_bytes ≥ 1e6 ∧ download_bytes/total_bytes ≥ 0.9` **and** `content-addressed download` (`archive_ext(url) ∨ hash-named(filename)`); T1041 byte leg only |
| `bytes_uploaded` | `INV_MODE` | T1041, T1567, T1114 | LOW / MEDIUM | `upload_bytes ≥ 5e7 ∧ upload_share ≥ 0.6` |
| `rule_info` | `INV_MODE` | *(policy context)* | — | **Hard ABSENT**: every row already matched a block pattern, so a `rule_info` label is a superset fact and can never evidence a technique |
| `rule_name` | `INV_MODE` | `T1567.002` (class name) | LOW | `T1567.002 ⇐` when `{category, rule_name, rule_info}` ∩ `{upload, box, dropbox, s3, oos, exfil}` — **name-mapped only for techniques in the taxonomy**; `oos` is a uNetWatch *class*, not a technique, so it contributes nothing on its own |
| `user_id` | `INV_MODE` | *(identity lens)* | — | **Hard ABSENT.** A non-empty `user_id` is an *authenticated* principal — the opposite of T1078 (valid accounts being abused anonymously). Never emits T1078; may only *raise* the confidence of a T1071.001 beacon to HIGH when stable across the window |
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
resolved_mode = get_mode()

mode == UNKNOWN or resolved_mode == UNKNOWN → every field = UNKNOWN
mode ∈ (UC-A, UC-B):
    field ∈ baseline                          → PRESENT
    field ∈ inventory(mode)                   → PRESENT
    else                                      → ABSENT
mode == COLLAPSED:
    field ∈ baseline                          → PRESENT
    else                                      → ABSENT          # inventory ⊆ baseline in this mode
```

The **COLLAPSED hard-ABSENT rule is the load-bearing clause.** In `COLLAPSED`
the inventory is, by definition, exactly the six baseline fields
(`_resolve_mode` reaches COLLAPSED only *after* the 3-field UC set fails), so
there is nothing to sample a `domain` from. Treating those fields as
`ABSENT` — rather than merely `UNKNOWN` — is what lets the engine say *"this
deployment's documents do not carry `domain`"* instead of silently accepting an
empty `domain` column. A one-request health-check that happens to be the single
sampled document is overridden by the mode's own guarantee.

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
| `T1029.001` Scheduled Transfer | **on** · MED | **on** · MED | **on** · LOW (byte leg via `duration-proxy`) | O — `mode=UNKNOWN` |
| `T1053.005` Scheduled Task/Job | **on** · LOW | **on** · LOW | **on** · LOW | O — `mode=UNKNOWN` |
| `T1041` Exfil Over C2 Channel | **on** · LOW | **on** · LOW | **on** · LOW (`mode=COLLAPSED,duration-proxy`) | O — `mode=UNKNOWN` |
| `T1078` Valid Accounts | **on** · MED | **on** · MED | **on** · LOW | O — `mode=UNKNOWN` |
| `T1583.003` Acquire Infrastructure: VPS | **on** · LOW | **on** · LOW | **on** · LOW | O — `mode=UNKNOWN` |
| `T1583.001` Acquire Infrastructure: Domains | **on** · LOW *(requires `domain` — see guard)* | **on** · LOW | O (no `domain`) | O — `mode=UNKNOWN` |
| `T1105` Ingress Tool Transfer (URL) | **on** · MED | **on** · MED | **withheld** (byte-gated) | O — `mode=UNKNOWN` |
| `T1567` Exfil Over Web Service | **on** · MED | **on** · MED | **withheld** (byte-gated) | O — `mode=UNKNOWN` |
| `T1567.002` Exfil To Cloud Storage | **on** · LOW | **on** · LOW | **withheld** (needs `rule_name`/`category`) | O — `mode=UNKNOWN` |
| `T1204.002` User Execution: Malicious File | **on** · MED | **on** · LOW | **on** · LOW *(needs `action` + `url`)* | O — `mode=UNKNOWN` |
| `T1114.002` Email Collection: Remote | **on** · LOW | **on** · LOW | **withheld** (byte-gated) | O — `mode=UNKNOWN` |

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
- **`COLLAPSED`** — baseline-only detectors stay eligible: T1071.001,
  T1090.003, T1078, T1041, T1029.001, T1053.005, T1583.003, T1204.002.
  Everything `domain` / `bytes_*` / `rule_name`-gated is **withheld with an
  explicit reason** (T1583.001, T1105, T1567, T1567.002, T1114.002), never
  guessed. T1041 and T1029.001 may use the `duration_seconds × 8192` proxy and
  say so: `bytes_source = "duration-proxy"`.
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
