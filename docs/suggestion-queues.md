# Design: Human-Confirmed Suggestion Queues

**Status:** Design for implementation
**Date:** 2026-09-21
**Scope:** Two candidacy queues over the persisted `findings` ledger, the verdict record that
closes them, the alert that surfaces them, and the DST correctness fix the recidivism rules
depend on. No application code is changed by this document.
**Relationship to prior work:** Implements Stage 2 of `docs/revamp-proposal.md:365-415`
("two candidacy queues, not one") in the **inverted** form the owner decided: the review proposed
candidacy with a human click; the owner has now made the human click the *only* path to a feed,
for **both** actions. Where this document differs from the review, the difference is stated
inline with a reason.
**Depends on:** `docs/specs/blacklist-metadata.md` (the `blacklist_events` table and its
`finding_id` evidence link, unimplemented), plus the in-flight intent workstream that persists
`DENY` rows and adds the derived `findings.intent` column.

---

## 0. The decision this document implements

The product's entire external interface is three text files plus the same destination contract
served twice:

| File | Consumed by | Orientation | Route | Backing table |
|---|---|---|---|---|
| `urls.txt` | proxy device, firewall | DESTINATION | `GET /api/blacklist/urls.txt` (`app/routes/blacklist.py:24`) | `blacklist_entries WHERE kind='url'` |
| `ips.txt` | proxy device, firewall | DESTINATION | `GET /api/blacklist/ips.txt` (`app/routes/blacklist.py:38`) | `blacklist_entries WHERE kind='ip'` |
| `jail-ips.txt` | firewall | SOURCE | `GET /api/jaillist/ips.txt` (`app/routes/jaillist.py:17`) | `jaillist_entries` |

All three are projections of the database, regenerated at startup (`app/main.py:68-69`,
`app/services/feeds.py:52`, `:69`) and after every mutation
(`app/routes/blacklist.py:71-73`, `app/routes/jaillist.py:50-52`). The writers are atomic,
CRLF-terminated, and select one column only
(`app/services/feeds.py:31-36`, `:39-49`, `:61`, `:74-76`). The `.txt` routes are mounted without
admin auth because external devices fetch them (`app/main.py:227-233`).

**The owner's decision: nothing in this document writes a feed automatically.** Both enforcement
actions — blacklisting a destination and jailing a source — become suggestions that a human
confirms. The reason is asymmetry of blast radius, and it is the whole justification:

- A `urls.txt`/`ips.txt` line blocks a destination **for the whole company**, is consumed by two
  independent devices, and is permanent (the operator states no expiry policy is needed).
- A `jail-ips.txt` line blocks **one device**, is consumed by one device, and is trivially
  reversible by deleting one row.

The second is narrow and reversible; the first is org-wide and, in practice, irreversible. An
automation error on the second is an outage for one desk. An automation error on the first is a
company-wide outage that requires the operator to *notice*, find the entry, and lift it. The owner
rejected auto-blacklisting after this was shown. The design therefore treats the two queues as
peers (both human-confirmed) while keeping the destination queue's trigger thresholds
deliberately conservative, because its downstream action is not.

---

## 1. What a suggestion is (and is not)

### 1.1 Definition

A **suggestion** is a *derived presentation* of persisted evidence that proposes one concrete
enforcement action, together with the reason it was proposed and the evidence that produced it.

It is not a stored object. A suggestion has no table of its own and no id of its own in the feed
path. It is computed on read from `findings` (and the two list tables) by a pure function, exactly
as `app/routes/analytics.py:423-453` already computes destination aggregates on read. The moment
it is *actioned*, it stops being a suggestion and becomes two persisted facts: a row in
`blacklist_entries`/`jaillist_entries` (enforcement) and a row in the verdict ledger (§4).

This gives the queue four properties the owner's workflow requires:

| Property | Mechanism |
|---|---|
| **Derived from persisted evidence, never auto-written** | Read-time SQL over `findings`; the only writers of the two list tables remain `POST /api/blacklist/` (`app/routes/blacklist.py:58`) and `POST /api/jaillist/` (`app/routes/jaillist.py:37`), both behind `verify_admin`. |
| **Carries the reason it was suggested** | Each suggestion names the rule that fired (§2.2, §3.2) and the numeric inputs to that rule. |
| **Carries enough context to decide in under 60 seconds without opening another app** | The payload in §2.3/§3.3 is a superset of the alert facts in §5; every field is either a persisted `findings` column or an explicit "unavailable". |
| **Cannot be confused with a decision** | Copy is neutral throughout, matching the constraint already established at `docs/specs/blacklist-metadata.md:571-577` ("the words harmful, malicious, confirmed do not appear in labels") and story 21 at `:144-145`. |

The display rule from the review lands here unchanged:

> **No value displayed, exported, or placed in an alert may be synthesized, estimated, or derived
> through a proxy formula. Every value is either a persisted field or an explicit "unavailable".**
> (`docs/revamp-proposal.md:84-88`)

### 1.2 What must NEVER produce a suggestion

| Excluded input | Reason | Enforced by |
|---|---|---|
| A **whitelisted** URL | Whitelisting is the operator's own prior decision that this destination is legitimate. Suggesting it again is asking them to relitigate a decision they already made. Whitelisted rows are already excluded at ingest (`app/services/result_processor.py:121-122`) and defended on read (`app/routes/findings.py:42`, `:53-64`). | The queue query joins the same whitelist filter. |
| A **single** low-signal event (`intent=''` legacy row, or one `ATTEMPT` with no other evidence) | One DENY is the proxy *working*: 50 hits/day across the org means a handful of DENYs per day are healthy operation, not a queue entry. Queueing them destroys the queue's signal value. | Thresholds in §2.2/§3.2 are all conjunctions or counts > 1. |
| Any row whose **`reason` cannot be named** | If the rule cannot be stated in one phrase, the operator cannot evaluate it in 60 seconds and will not trust it. | Each suggestion template names exactly one rule id. |
| A row count computed over **byte volume or `duration_seconds`** | `duration_seconds` is `0.01` on real traffic and the historical `×8192` byte proxy overstated by 38× (`docs/attck-mapping-spec.md:943-968`); `bytes_downloaded` is structurally `0` on DENY (`:911-928`). A ~50 hits/day deployment has no statistical basis for volume ranking. | §2.2 ranks on `COUNT(DISTINCT client_ip)` only; no bandwidth field appears in any queue payload. |
| A suggestion produced by **decoding `rule_info`** | Frozen boundary (`docs/revamp-proposal.md:572-581`, `:680-682`). It is stored (`app/database.py:154`) and displayed opaque; no predicate may derive from it. | No query in this document reads `rule_info`. |

**Decision: include single `REACH` events in Queue B only, at the lowest rank, never in Queue A.**
A single REACH (`ALLOW` + block-pattern match) is the strongest single-row signal the system has:
the client actually reached a prohibited destination and the proxy did not stop it. It is
legitimate source-side evidence. It is *not* legitimate destination-side evidence, because one
client reaching one host is a fact about that client, not a consensus about that host (§2.2).

---

## 2. Queue A — destination (blacklist) suggestions → `urls.txt`

### 2.1 What it answers

"Which destination should be blocked for everyone?" The artifact of confirming is a
`POST /api/blacklist/` call (`app/routes/blacklist.py:58`) which, per
`docs/specs/blacklist-metadata.md:282-298`, becomes a `blacklist_events` append plus an
`INSERT OR IGNORE` enforcement ensure, after which `sync_regenerate` rewrites `urls.txt`/`ips.txt`.

### 2.2 Trigger rules

All rules read only fields that exist on `findings`:

| Field | Column | Citation |
|---|---|---|
| Client identity | `client_ip` | `app/database.py:43` |
| Destination (wildcard-free host) | `base_url` | `app/database.py:46`; derived at `app/services/result_processor.py:117-120` |
| Full URL | `url` | `app/database.py:45` |
| Event time (UTC) | `log_timestamp` | `app/database.py:47` |
| Intent | `intent` (`REACH`/`ATTEMPT`, `''` legacy) | `app/database.py:138-141`; derived by `app/services/result_processor.py:128-139` |
| Policy class that fired | `matched_patterns` (JSON array) | `app/database.py:62-65` |

| Rule | Condition | Rationale |
|---|---|---|
| **D1 — Consensus** | `COUNT(DISTINCT client_ip) WHERE intent='REACH'` for one `base_url` in the window ≥ **3** | Several independent devices reaching the same destination is evidence about the *destination*, not about any one device. N=3 because at ~50 hits/day a 30-day window (see D4) yields a low single-digit distinct-client count for a genuinely popular masked site, while a single mis-typed URL from one desk stays at 1. |
| **D2 — Enforcement defeat** | `COUNT(*) WHERE intent='REACH'` for one `base_url` is ≥ 1 **and** `base_url ∈ blacklist_entries` | The proxy's enforcement was defeated: a destination the operator already blocked was reached anyway. This is the same signal `hosts.py:47-48` already escalates to HIGH per host, promoted here to a destination-level rule. A single occurrence still qualifies: it is a contradiction between intent (block it) and outcome (it was reached). |
| **D3 — Persistent bypass** | `COUNT(DISTINCT client_ip) WHERE intent='ATTEMPT'` for one `base_url` ≥ **2** **and** `base_url ∈ blacklist_entries` | A blocked destination that ≥2 distinct clients keep hammering is evidence the destination is being *actively sought*, which is evidence about the destination's harmfulness even though every attempt was stopped. One client retrying is a stale bookmark; two independent clients is a pattern. |
| **D4 — Window** | rolling **30 days**, evaluated over `findings`, never over the live ES window | The ES window evaporates; `analytics.py:6-8` documents that enforcement counts "only exist in the live Elasticsearch window". A queue that depends on it is a queue that empties itself. |

### 2.3 Evidence presented (the 60-second decision)

The row the operator sees, in order:

| Field | Source | Why it is on the row |
|---|---|---|
| Domain | `base_url` | The thing being judged. |
| Distinct REACH clients | `COUNT(DISTINCT client_ip) WHERE intent='REACH'` | The rank key and the reason. |
| REACH event count | `COUNT(*) WHERE intent='REACH'` | Volume-of-evidence, not volume-of-bytes. |
| ATTEMPT event count | `COUNT(*) WHERE intent='ATTEMPT'` | Distinguishes "many reached it" from "many keep trying it". |
| Currently blocked? | `base_url ∈ blacklist_entries` | **Mandatory.** Whether this is a D1 case (new destination) or D2/D3 case (already blocked, failed) changes the action completely. |
| First seen / last seen (local) | `MIN/MAX(log_timestamp)` rendered via `timeutil.local_day`/`format_peak` | Answers "is this happening now" without a second query. |
| **The full URL(s)** | `findings.url`, newest first, capped at a display limit with an explicit "+N more" | This is the column the entire `blacklist_events` spec exists for (`docs/specs/blacklist-metadata.md:236-238`): a bare host is not judgeable, `https://site.tld/video/123` is. |
| Which pattern fired | `matched_patterns`, flattened, distinct | The operator needs to know this row exists because of `*nonton*` (an over-matching glob, `:5-7`) rather than `*porn*`. |
| Intent mix per client | per-client `REACH`/`ATTEMPT` counts | Surfaces the "this client reached it, that client only tried" split, which is the difference between D1 and D3. |

**Ranking.** Order by `COUNT(DISTINCT client_ip) WHERE intent='REACH'` **descending**, then by
`MAX(log_timestamp)` descending as a tiebreak. Justification against the alternative: the existing
destination aggregation (`app/routes/analytics.py:423-453`) ranks by request volume/bytes, which
answers "where is the traffic?" — a capacity question. The operator's goal is a **policy** question
("what is attracting violations?"), and the correct statistic for it is *how many distinct devices
independently chose this destination*. Byte volume is not merely wrong-ranked here, it is
unavailable: `bytes_downloaded` is `0` on every DENY row (`docs/attck-mapping-spec.md:911-928`),
so a byte-ranked queue would systematically demote exactly the ATTEMPT evidence the owner says he
wants to keep.

### 2.4 Suppression: the "already blocked and still hit" case

This is the case the operator described directly, and it is the one that would otherwise produce
an infinite queue:

> *"there is a site with base_url of 'ringtonetrue' ... most of porn sites is blocked, but this is
> very intentional access by client_ip."*

Once `ringtonetrue` is blocked, every subsequent hit is a `DENY`, hence an `ATTEMPT`. That is
**by design** a permanent, unbounded stream of rows: the block is what produces them. If D2/D3
produced a fresh suggestion per event, the queue would show one destination forever and the
operator would stop reading it.

**Suppression rule:** a destination is suppressed from Queue A when the queue already holds an
unactioned suggestion for it that is *newer than the newest evidence the previous suggestion was
built from*, or when the destination's **last actioned verdict** was `HARMFUL_DESTINATION` and the
destination is currently in `blacklist_entries`.

Concretely, the suppression predicate is:

```
suppress(base_url) :=
       (base_url ∈ blacklist_entries)
   AND (last verdict for base_url == 'HARMFUL_DESTINATION')
   AND (no REACH event since that verdict's decided_at)        -- §4
```

The last clause is the point. Blocking produces ATTEMPTs forever and they must not re-open the
suggestion; but a **REACH** after the block means the block is not working, which is new
information and *must* re-open it. So the suppression is asymmetric by intent, not by time:

| Evidence since the last `HARMFUL_DESTINATION` verdict | Queue A behaviour |
|---|---|
| Only `ATTEMPT` rows (the expected steady state after blocking) | **Suppressed.** Silent. Counted in the destination's history view, never re-queued. |
| ≥1 `REACH` row (the block was defeated — rule D2) | **Re-queued**, top of the list, reason "enforcement defeat". |
| A new distinct client reaching ≥3 total (rule D1 re-fires on a fresh cohort) | Re-queued. |

A destination the operator has *not* yet actioned is never suppressed: it sits in the queue until a
verdict is recorded. A destination whose last verdict was `NOT_HARMFUL` is suppressed for as long
as its whitelist pattern exists, because the whitelist already excludes its rows at ingest
(`app/services/result_processor.py:121-122`).

**Decision: no separate "suppression" table.** Suppression is a function of
(`blacklist_entries` membership, last verdict, REACH-since-verdict). Adding a stored
`suppressed` flag would create a second source of truth about what is blocked, which is exactly the
drift risk `docs/specs/blacklist-metadata.md:731-738` documents and rejects.

---

## 3. Queue B — source (jail) suggestions → `jail-ips.txt`

### 3.1 What it answers

"Which `client_ip` should be jailed?" The artifact of confirming is a
`POST /api/jaillist/` call (`app/routes/jaillist.py:37-53`), which normalizes to a single-host
CIDR (`app/services/jaillist.py:11-61`), inserts with `UNIQUE(value)` (`app/database.py:204`), and
regenerates `jail-ips.txt` (`app/routes/jaillist.py:50-52`).

`finding_id` is already accepted by the write route and by the request model
(`app/routes/jaillist.py:45-47`, `app/models.py:91-94`) and is **never populated by any caller**
today — the Findings row action sends only the client IP. §4.5 closes that.

### 3.2 Trigger rules, including the REACH/ATTEMPT distinction

The REACH/ATTEMPT distinction is load-bearing for this queue and has no effect on Queue A's D1:

| Concept | `action` | `intent` | Meaning | Severity |
|---|---|---|---|---|
| **REACH** | `ALLOW` | `REACH` | The client reached a prohibited destination. The policy failed at the enforcement point. | P1 |
| **ATTEMPT** | `DENY` | `ATTEMPT` | The client tried; the proxy stopped it. Nothing reached the client. | P2 |
| legacy | `''` | `''` | Row predates the intent column. Treated as REACH (§7.3). | P1, flagged "intent unrecorded" |

Two non-negotiable properties, carried from `docs/revamp-proposal.md:209-215`:

1. **REACH outranks ATTEMPT for the same `(client_ip, base_url)`.** A client that both reached and
   attempted one destination is a REACH case for that destination.
2. **ATTEMPT alone never justifies a jail.** It is evidence of *intent*, not of exposure. It ranks
   below REACH forever and can only *supplement* — never constitute — a source-side case.

| Rule | Condition | Why |
|---|---|---|
| **S1 — Volume** | ≥ 3 REACH events to ≥ 2 distinct `base_url` in the window | One blocked-then-reached destination can be a mistyped URL; three across two hosts is a habit. |
| **S2 — Persistence (the operator's own case)** | ≥ 1 REACH **and** ≥ 3 ATTEMPT to the *same* `base_url` | The destination is already blocked and the client keeps trying anyway. This is the quoted threat model verbatim: *"this is very intentional access by client_ip."* |
| **S3 — Recidivism** | ≥ 2 REACH events on ≥ 2 distinct **local calendar days** | Same-day bursts are one incident. Two days is a pattern. This rule is the one that requires §6 to be correct. |
| **S4 — Class breadth** | `matched_patterns` (flattened, distinct) ≥ 2 distinct policy classes | One policy class can be an over-matching glob; two classes is intent. |
| **S5 — Enforcement defeat, per client** | ≥ 1 REACH where `base_url ∈ blacklist_entries` | Already implemented as a per-host HIGH escalation at `app/routes/hosts.py:47-48`; Queue B promotes it to a queue trigger. |
| **S6 — Window** | rolling **30 days** over `findings` | Same as D4. |

**Conjunction — the escalation ladder:**

- Any one rule firing → the client appears in Queue B (a "watch" entry, rank 3).
- **Jail-strength candidacy requires S5, or S2, or ≥2 rules.** A single S1 alone is a habit worth
  watching, not a device worth jailing. This mirrors `docs/revamp-proposal.md:396` and is adopted
  unchanged.
- ≥2 rules including any of S5/S2 → rank 1.

**Decision: keep Queue A and Queue B ranked independently and never let one imply the other.** A
destination can be queued on D1 with none of its clients queued (many devices each misbehaving
once); a client can be queued on S1 with no destination queued (few devices across many harms).
The two produce different files. Merging them would force the operator to reason about which file
a "confirm" button writes, which is exactly the ambiguity `docs/adr/0004-jaillist.md:15` avoided by
choosing a separate table.

### 3.3 Findability: the substitute for expiry

**This is the risk that replaces the expiry policy the owner declined.**

The operator's stated workflow: a jailed device's IP is looked up in a *separate* system that
records who owns it, and that system will not be integrated (§9.1). So jailing is: look up an IP
elsewhere, then block it here. **Un-jailing requires finding the entry again months later**, and
the only current handle on a jail entry is a bare value row
(`app/routes/jaillist.py:30-34` returns `{"ips": [...]}` — value only, no metadata at all).

A bare `10.20.30.40/32` in `jail-ips.txt` and a bare `10.20.30.40/32` row in `jaillist_entries`
answer none of the questions that lifting a jail requires:

- Who was this? (the device, and the person the other system maps it to)
- Why was it jailed?
- What evidence justified it?
- Who decided, and when?
- Has anything happened since that changes the answer?

The owner declined a *time-based* expiry, so the substitute must be an *information-based* one:
**a jail entry must be self-explaining.** Lifting a jail then reduces to reading one row.

**Required fields on a jail entry.** These are a **dependency** — the `jaillist_entries` table
(`app/database.py:199-206`) does not carry them today and they must be added (§7.1):

| Field | Purpose | Source |
|---|---|---|
| `finding_id` | The evidence anchor. Already exists (`app/database.py:203`), already accepted by the route (`app/routes/jaillist.py:45-47`), **never populated** today. | The Findings row the operator clicked. |
| `reason` | One line, operator-authored, phrased as the rule that fired: "REACH to 3 blocked destinations across 2 days". | Pre-filled from the queue suggestion; the operator may edit. |
| `url` | The single most representative full URL that produced the jail. | `findings.url` of the newest REACH row. |
| `category` | The operator's own policy class label, free text, never an enum. | Same convention as `blacklist_events.category` (`docs/specs/blacklist-metadata.md:239-240`). |
| `note` | Free text. | Operator. |
| `verdict_id` | FK to the verdict that created it (§4). | §4. |
| `decided_by` / `decided_at` | Who and when. | §4.4. |
| `evidence_summary` | Frozen-at-decision JSON: the rule ids that fired and their counts at decision time. | Computed at confirm time and **stored**, so it does not drift as the window rolls forward. |

`evidence_summary` is frozen deliberately. Recomputing "what did this look like when we jailed
it" from `findings` later gives a *different* answer than it did at the time, because the
rolling window (D4/S6) has moved. The operator lifting a jail six months later needs the evidence as it
was, not as it is.

**Decision: store `evidence_summary`, do not recompute it.** A jail entry that cannot explain
itself will never be lifted, because lifting it requires re-deriving a 30-day window from three
months ago — and at that point the operator's rational move is to leave it in, which means the
declined expiry policy becomes a de-facto permanent jail. This field is what keeps the owner's
"no expiry needed" decision defensible.

### 3.4 Recommendation: do NOT auto-jail

The owner permits auto-jailing. Two prior positions in this repository argue against it, and this
document agrees with them:

- `docs/revamp-proposal.md:408`: *"Jailing a static-IP device is an operational event with real
  human cost... keep the human in the loop and make the suggestion loud."*
- `docs/adr/0004-jaillist.md:26`: *"Jails are enforcement-intent only. Nothing in the app yet
  verifies that a jailed IP actually stopped being seen — the feed is the contract."*

**Recommendation: human click required, for both queues.** Reasons specific to this deployment:

1. **One IP is one device is one desk.** The operator confirmed static IPs and no MAC/identity
   integration. Jailing is therefore not anonymous: it cuts off a named colleague's connectivity,
   and the operator knows it. Auto-jailing converts a threshold crossing into a connectivity
   outage whose cause the affected person will report as "the network is broken".
2. **There is no un-jail automation.** Lifting requires finding the entry (§3.3). Every automatic
   jail is a manual, delayed un-jail by construction.
3. **At under 50 hits/day the human is not the bottleneck.** The whole economic argument for
   automation is throughput, and there is no throughput problem to solve. The owner states
   explicitly that the team can handle it all. Automating a decision that costs nothing to make by
   hand and is expensive to make wrongly is a bad trade.
4. **The verdict record is the product.** Auto-jailing skips the verdict write, and the verdict
   ledger (§4) is the only asset this feature accumulates. An automated path produces no labelled
   data.

If the owner later reverses this, the correct shape is not "auto-jail on S5/S2" but "auto-**queue**
at rank 1 and notify", which is what this document already specifies.

---

## 4. The verdict record (the audit trail)

### 4.1 Where the decisions live

**Decision: a separate `triage_events` table. Do not extend `blacklist_events` with a verdict.**

`docs/specs/blacklist-metadata.md:199` and `:223-225` define `blacklist_events` as exactly one row
per **block**, with no `UNIQUE` constraint at all. Its identity is the *act of blocking*. A verdict
is a different kind of thing:

| | `blacklist_events` | `triage_events` |
|---|---|---|
| Row count per decision | Appended only when the action is a block | One per decision, **including decisions that produce no artifact** |
| Covers the jail side | No — it is the blacklist's table | Yes — both queues write here |
| Covers `NOT_HARMFUL` / `INCONCLUSIVE` | No artifact exists to append | Yes |
| Cardinality | Many rows per destination | One row per reviewed subject |

Extending `blacklist_events` with a verdict column would fail on all four rows of that table. It
cannot record a jail decision, it cannot record a decision that produced no block, and its
"no `UNIQUE` constraint" design is premised on repetition being meaningful *blocks* — repetition
being meaningful *verdicts* would require a different key, i.e. a different table.

The two coexist and are not redundant: `blacklist_events` answers "what blocks happened to this
destination and with what evidence", `triage_events` answers "what did a human decide about this
subject, when, and why". A `HARMFUL_DESTINATION` verdict produces **both** rows, in one
transaction, and the `triage_events` row is the one that survives an unblock (an unblock deletes
the enforcement row, not the events — `docs/specs/blacklist-metadata.md:416-423`).

**What `triage_events` absorbs from the prior spec.** Build 3 of the review
(`docs/revamp-proposal.md:613`) asks for "`blacklist_events` as specced, plus a four-state
`verdict`". This document supplies that verdict as this table instead, and the review's acceptance
criterion is satisfiable either way: *"Record NOT_HARMFUL: a whitelist pattern is created and the
destination drops out of future findings."* That is a statement about observable behaviour, not
about column placement.

**What the prior spec already supplies and this design reuses unchanged.** `blacklist_events`
keeps its exact DDL (`docs/specs/blacklist-metadata.md:207-219`), its two-statement write path
(`:282-298`), its no-cascade delete semantics (`:411-423`), its backup treatment (`:596-610`), and
its feed invariants (`:487-509`). This document adds one peer table and does not alter that spec.

### 4.2 The four verdicts

| Verdict | Meaning | Artifact written | Ledger |
|---|---|---|---|
| `HARMFUL_DESTINATION` | The operator judged the destination prohibited. | `POST /api/blacklist/` → `urls.txt` (`kind='url'` for a host, `kind='ip'` for an IP destination) | 1 row |
| `HARMFUL_SOURCE` | The operator judged the device's behaviour a violation. | `POST /api/jaillist/` → `jail-ips.txt` | 1 row |
| `NOT_HARMFUL` | The operator judged the hit legitimate — a pattern over-match, not a violation. | A **whitelist pattern** in `url_patterns` with `pattern_type='whitelist'` | 1 row |
| `INCONCLUSIVE` | The operator could not decide from the evidence available. | **None.** | 1 row — **mandatory** |

### 4.3 Why `INCONCLUSIVE` is required

The operator's stated extraction step is: check the URL manually; if harmful → block; **if not →
possibly whitelist**. That "possibly" is the whole reason this state exists. The operator's real
options when looking at a hit are three, and the third is the common one:

1. It is harmful → `HARMFUL_DESTINATION`.
2. It is clearly legitimate → `NOT_HARMFUL` (write the whitelist).
3. **It is neither.** The site is dead, parked, a domain-squatter, a CDN edge that does not resolve
   to content, or resolves to content the operator cannot judge (a language they do not read, a
   page that needs an account). The operator cannot say "harmful" and cannot say "not harmful".

Without `INCONCLUSIVE`, option 3 has only bad outcomes: the operator either (a) whitelists
something they are not sure about — the one action that causes future violations to stop being
*seen*, because whitelisted rows are excluded at ingest
(`app/services/result_processor.py:121-122`) — or (b) leaves the row untouched, and it reappears
at the top of the queue tomorrow. Both are failures. `INCONCLUSIVE` closes the loop honestly: the
subject leaves the queue, no artifact is written, and the *fact that a human looked and could not
decide* is recorded, which is itself the most valuable signal in the ledger for anyone who later
reviews the patterns.

**`INCONCLUSIVE` must suppress re-queueing for a bounded period**, otherwise it is a no-op. This
document specifies: an `INCONCLUSIVE` verdict suppresses the same subject from the same rule for
**the remainder of the window (30 days)**. It does *not* suppress other rules, and it does not
suppress a *new* rule firing on new evidence.

### 4.4 Why a verdict is immutable and carries who/when

Three reasons, each grounded in the owner's operating context:

1. **It authorises an action with external effect.** `HARMFUL_DESTINATION` writes a line into a file
   two devices consume for the whole company. When someone asks six months later "why is this
   domain blocked", the answer must be a durable record, not a mutable field. The codebase already
   treats `findings` this way: the only writes to it after insert are the legacy backfill and the
   deletes (`app/services/result_processor.py:249`, `app/routes/findings.py:499`, `:513`, `:522`) —
   no update path exists, and that is deliberate.
2. **The ledger is the only dataset the feature produces.** It is a labelled set of operator
   judgements over pattern hits, and it is the corpus any future automation would be trained or
   evaluated on. A mutable label set is not a dataset.
3. **`INCONCLUSIVE` is only useful if it is honest.** Its value is "a human looked and could not
   decide". If a verdict can be edited, the operator under time pressure will retroactively
   convert an `INCONCLUSIVE` into a decision to clear a queue, and the signal is destroyed.

Consequently: **a correction is a new row, not an edit.** A verdict is superseded by writing a new
`triage_events` row with `supersedes_id` pointing at the earlier one; the effective verdict for a
subject is the newest row in its chain. The table is append-only in the same sense as
`blacklist_events` (`docs/specs/blacklist-metadata.md:48-55`).

`decided_by` is required and is the authenticated admin identity already available to every
admin-gated route (`app/routes/blacklist.py:49`, `app/routes/jaillist.py:30`). `decided_at` is a
UTC timestamp on the same convention as `findings.log_timestamp` (`app/database.py:47`). Both are
non-nullable: a verdict without an author is not an audit trail.

### 4.5 The evidence link

`finding_id` is dead-by-default today in both list tables: the columns exist
(`app/database.py:175`, `:202`), the routes write them (`app/routes/blacklist.py:65-69`,
`app/routes/jaillist.py:45-47`), the models accept them (`app/models.py:56`, `:94`) — and the only
UI caller sends `{ value }` and nothing else
(`admin-ui/src/api.ts:1267-1275`, `:1291-1296`). The operator cannot currently get from "why is
this blocked" back to the device and log line that caused it.

Every confirming action in this design therefore carries `finding_id` from the queue row's
originating finding. `triage_events.finding_id` is populated on every verdict, including
`INCONCLUSIVE`, so the ledger records *the specific row looked at*, not just the subject.

---

## 5. The alert-to-decision loop

### 5.1 What is sent today

| Path | Content | Citation |
|---|---|---|
| n8n webhook | `{"summary":{"total_matches","timestamp_utc"},"total_documents","documents":[{"client_ip","url":[…],"base_url":[…]}]}` | Built at `app/services/monitor.py:706-713`, sent at `:730` via `deliver_n8n` (`app/services/delivery.py:144-168`) |
| MS Teams | Adaptive Card: "Security Alert", FactSet of `Timestamp` / `Source Client IP` / `Pattern Match`, then two monospace containers of target domains and destination URLs, each capped at 20 with an ellipsis overflow, plus two `Action.OpenUrl` buttons | Built at `app/services/msteams.py:16-143`, invoked at `app/services/delivery.py:100-133` |

Concretely, what the alert **does not** carry today:

- No intent. The card does not distinguish REACH from ATTEMPT (`app/services/msteams.py:90-97` has
  exactly three facts and none is action-derived).
- No per-client distinction. `first_client_ip` is taken from the first grouped document
  (`app/services/delivery.py:57-60`) and the card presents it as *the* source client IP
  (`:102`), so a batch spanning several clients attributes all domains to one of them.
- No prior-attempt count.
- No current block status.
- The two action buttons link to `/blockDomain` / `/whitelistDomain` (`app/services/msteams.py:43-52`),
  which are real standalone confirmation pages (`admin-ui/src/App.tsx:88`, `:231`;
  `admin-ui/src/components/BlockDomainPage.tsx:1-15`). So a blacklist confirm is reachable from
  Teams today, but it is a **bulk comma-joined** flow with no evidence attached and no verdict
  recorded.

**The buttons are also the design's largest hazard and must change.** `blockDomain_url` joins
`target_domains[:10]` into one query parameter (`app/services/msteams.py:44`). One click from a
chat client can blacklist up to ten destinations for the whole company, with the operator having
seen only a monospace list of domains in a chat card. That is the org-wide irreversible action with
the least context attached in the entire product. §5.2 replaces it.

### 5.2 What the alert MUST carry (the delta)

The target is the operator's stated 60-second workflow: *an alert fires → the team spends the first
60 seconds rechecking the finding → they decide whether the site is actually harmful → act.* The
alert must make the first 60 seconds sufficient, and must not require opening the app to *decide*.

| Required fact | Why | Delta from today |
|---|---|---|
| **Intent** (`REACH` / `ATTEMPT` / both, with counts) | This is the difference between "a device reached a prohibited site" and "a device tried and was stopped". It is the single most decision-relevant bit and is absent. | **New.** Read from `findings.intent`. |
| **Per-client breakdown** (client IP, REACH count, ATTEMPT count, last seen) instead of one `first_client_ip` | The current card names one client while listing domains from all of them (`app/services/delivery.py:57-60`). An enforcement decision per device cannot be made from that. | **Changed** — replaces the single-fact client field. |
| **Prior-attempt count** for this `(client_ip, base_url)` over the window | "This device has tried this 14 times since Tuesday" is the whole case for a jail; "it tried once" is not. | **New.** |
| **Destination's current block status** (`blocked` / `not blocked`) | Changes the meaning of the same event completely: a REACH to a blocked destination is enforcement failure; the same REACH to an unblocked one is a new discovery. | **New.** |
| **Local time in the operator's zone**, labelled | The alert currently stamps `datetime.now(UTC)` (`app/services/msteams.py:93`, `app/services/delivery.py:101`). An operator at UTC+07:00 reading a 23:59Z timestamp is reading yesterday. | **Changed** — must render local with an explicit zone label, using `timeutil.zone_label` (`app/services/timeutil.py:119`). |
| **Full URL, not just domain** | The `*nonton*` over-match means a domain is not judgeable (`docs/specs/blacklist-metadata.md:5-10`). | **Changed** — the URL container already exists (`app/services/msteams.py:117-136`), keep it and pair each URL with its client. |
| **Window** the counts are over, stated | A count with no denominator is not a fact. | **New.** |

**What the operator must still do in the app:** exactly one thing — **confirm and classify**.
The alert can carry enough to *decide*; it cannot carry the act, because the act is a POST to an
admin-gated route with a verdict attached (`app/routes/blacklist.py:58`, `app/routes/jaillist.py:37`),
and the verdict requires an authenticated author (§4.4).

**Decision: the Teams buttons stop being enforcement buttons and become queue links.**
`Block Domain` → "Review destination" opening the destination queue row; `Add to Whitelist` →
"Review as legitimate" opening the same row with `NOT_HARMFUL` preselected. The reason is that the
current bulk-join button is an org-wide irreversible write reachable in one click from a chat card
with no attached evidence, and §4's ledger cannot be populated through it. This is a **change to
`app/services/msteams.py:43-52`** and is the one place this design deletes existing behaviour.

---

## 6. DST and local-day correctness

### 6.1 The mechanism

`app/services/timeutil.py:98-108`:

```python
def local_day(ts: str) -> str:
    dt = _parse_utc(ts)                      # ts -> aware UTC
    if dt is None:
        return ""
    return dt.astimezone(operator_tz()).strftime("%Y-%m-%d")
```

`operator_tz()` (`:74-76`) resolves `Settings.display_tz` (`app/config.py:64`, default `"UTC"`)
**at call time**, every call. `_parse_utc` (`:79-95`) correctly produces an aware UTC instant from
the stored `...Z` string. So the instant is right and the zone is right; the question is whether a
zone resolved at *read* time can correctly decode an instant captured across a DST boundary.

### 6.2 Verdict: the instant is safe; the *offset used to render it* is not the issue — the issue is the two-sided comparison

**Reading a single stored timestamp and converting it with a DST-aware zone is correct.**
`dt.astimezone(ZoneInfo("Europe/London"))` applies the offset that zone had **at that instant**,
not the current offset, because `ZoneInfo` carries the full transition table. This is the property
that makes Python's `zoneinfo` the right tool and is worth stating explicitly because the intuition
"read-time conversion must be wrong" is wrong for the single-row case.

**The failure is in comparing two rows bucketed by that function, when the two rows straddle a
transition. It is not in either conversion.** Concretely:

Rule S3 ("≥2 REACH events on ≥2 distinct local calendar days") counts distinct values returned by
`local_day`. That is a comparison of *bucket labels*. Consider an operator zone that shifts its
offset during the window — a `Europe/London` deployment, an `America/New_York` deployment, or any
IANA zone where the operator's own DST applies. Take a device that reaches a prohibited destination
twice, once just before and once just after the spring-forward transition:

| Event | UTC instant | `local_day` → local date | Local clock |
|---|---|---|---|
| A | `2026-03-29T00:30:00Z` | `2026-03-29` | 00:30 GMT (before transition) |
| B | `2026-03-29T23:30:00Z` | `2026-03-29` | 00:30 BST (after transition) |

Both are on `2026-03-29` local; S3 does not fire. That outcome is correct. The transition that
breaks a rule is not spring-forward, where a local day is 23 hours long, but **fall-back, where a
local day is 25 hours long**: the interval `2026-10-25T00:00Z`–`2026-10-26T00:00Z` local contains
25 wall-clock hours and therefore *more* instants than a normal day. Two events 24 hours apart can
land on the *same* local day (suppressing a genuine S3 firing), and two events on two wall-clock
dates can be 23 hours apart (allowing a spurious firing). Neither is a bug in `local_day`; both are
consequences of the rule's definition being "distinct calendar labels" rather than "distinct
elapsed periods".

**The concrete, silent corruption is different and worse, and it is the one this document must
name.** It is not DST in the operator's zone — the operator's zone is UTC+07:00 (`root` operating
context, and the worked example at `app/services/timeutil.py:6-8`), which **has no DST**. It is
this:

> `local_day` resolves the zone from configuration **at read time**, so the bucket labels a rule
> has already accumulated are not stable. Changing `DISPLAY_TZ` — or, on a zone that observes DST,
> observing the transition — changes how *already-stored* rows are bucketed, retroactively, without
> touching a single row of `findings`.

For the operator's zone (+07:00) this reduces to: **the labels are stable only while the
configuration is stable.** A one-off correction of `DISPLAY_TZ` (a plausible action — the operator
sees a chart one day off and fixes the setting) silently re-partitions the entire recidivism
history and can change which clients S3 has already flagged. Nothing records that the
interpretation changed. The rule's output is therefore not a function of the persisted evidence
alone; it is a function of evidence plus current configuration, which violates the "suggestions are
derived from persisted evidence" property in §1.1.

**Second, independent failure, specific to the deferred-workstream ordering.** §6.3's rule needs
"which local day was this" *at decision time* if any part of the ledger is keyed on it. If
`evidence_summary` (§3.3) is computed at confirm time and stored, it is safe. If any rule is
evaluated later for a *display* of "how many days has this client been at it", and the config has
changed in between, the number the operator reads differs from the number that triggered the jail.
This is why §3.3 requires freezing `evidence_summary`, not recomputing it.

### 6.3 The correct approach

Three requirements, all of which must hold:

1. **Bucket by local day using a DST-aware zone resolved per instant, which `local_day` already
   does.** Do not "fix" `local_day` — it is correct for the single-row case. Any change that
   replaces `astimezone(zone)` with a manual offset arithmetic (`utc_offset_minutes`,
   `:140-150`, which returns the offset **right now**) would be a regression: that function's
   docstring says so explicitly (`:141`).

2. **Record the zone in force when a verdict is written.** `triage_events` gains
   `decided_tz` (§7.2), the `zone_label()` output at decision time. A later reviewer then knows
   which calendar the verdict was reached under, and a config change does not silently rewrite
   history's meaning.

3. **For any rule whose counts are frozen into `evidence_summary`, freeze the bucketing too.**
   Store the distinct local-day labels that produced the count, not just the count. This makes the
   rule's output reproducible from the ledger alone.

**And one explicit non-requirement, stated so it is not "fixed" by mistake:** the operator's
deployment zone is a **fixed offset with no DST**, so the
25-hour-day arithmetic above does not currently bite. It is documented because the code accepts any
IANA name or fixed offset (`app/services/timeutil.py:53-71`) and a future operator in a DST zone
would hit it. Do not add transition-handling logic to `local_day` for a case the current deployment
does not have; do keep the deployment on a fixed offset, and prefer `+07:00` to `Asia/Bangkok` if
the operator's true zone ever observes a shift — a fixed offset makes every rule's day boundaries
stable by construction.

---

## 7. Data model + migrations

All DDL is additive and follows the idiom in `app/database.py`: `CREATE TABLE IF NOT EXISTS` inline
in `init_db`, plus a `PRAGMA table_info` guard for each added column, exactly as
`app/database.py:53-141` does for `findings`.

### 7.1 `jaillist_entries` — add the findability columns

Added between the table creation (`app/database.py:197-206`) and the jaillist normalization
migration (`:315-356`), using the same guard shape as `:53-58`.

```python
cursor = await db.execute("PRAGMA table_info(jaillist_entries)")
_jl_columns = {row[1] for row in await cursor.fetchall()}
for _col, _type in (
    ("reason", "TEXT NOT NULL DEFAULT ''"),
    ("url", "TEXT NOT NULL DEFAULT ''"),
    ("category", "TEXT NOT NULL DEFAULT ''"),
    ("note", "TEXT NOT NULL DEFAULT ''"),
    ("verdict_id", "INTEGER"),
    ("evidence_summary", "TEXT NOT NULL DEFAULT '{}'"),
    ("decided_by", "TEXT NOT NULL DEFAULT ''"),
    ("decided_at", "TEXT NOT NULL DEFAULT ''"),
):
    if _col not in _jl_columns:
        await db.execute(f"ALTER TABLE jaillist_entries ADD COLUMN {_col} {_type}")
```

All nullable or defaulted, so every existing row survives unchanged and `UNIQUE(value)`
(`app/database.py:204`) is untouched. Note the guard re-reads `PRAGMA table_info` **after** the
`CREATE TABLE IF NOT EXISTS` above it: reusing the earlier `columns` variable would perform the
guard against `findings`' column set, a bug this document explicitly avoids (§8 step 0).

`finding_id` already exists (`app/database.py:202`) and needs no migration; it needs a **caller**.

### 7.2 `triage_events` — the verdict ledger

Placed after the jaillist creation (`app/database.py:197-206`), before `tracked_urls` (`:210`).

```sql
CREATE TABLE IF NOT EXISTS triage_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_kind  TEXT NOT NULL CHECK (subject_kind IN ('destination', 'source')),
    subject       TEXT NOT NULL,                 -- base_url (destination) or bare client_ip (source)
    verdict       TEXT NOT NULL CHECK (verdict IN (
                      'HARMFUL_DESTINATION', 'HARMFUL_SOURCE',
                      'NOT_HARMFUL', 'INCONCLUSIVE')),
    rule_ids      TEXT NOT NULL DEFAULT '[]',    -- JSON array, e.g. ["D1"] or ["S2","S5"]
    finding_id    INTEGER,                       -- the row the operator looked at
    url           TEXT NOT NULL DEFAULT '',      -- full URL judged, as supplied
    category      TEXT NOT NULL DEFAULT '',      -- operator free text, never an enum
    note          TEXT NOT NULL DEFAULT '',      -- operator free text
    evidence_summary TEXT NOT NULL DEFAULT '{}', -- frozen counts + local-day labels at decision
    decided_by    TEXT NOT NULL,                 -- authenticated admin identity
    decided_at    TEXT NOT NULL,                 -- UTC ISO, same convention as findings.log_timestamp
    decided_tz    TEXT NOT NULL DEFAULT '',      -- zone_label() in force at decision time
    supersedes_id INTEGER,                       -- prior verdict this replaces; NULL for the first
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_triage_subject
    ON triage_events(subject_kind, subject, decided_at);
CREATE INDEX IF NOT EXISTS idx_triage_verdict
    ON triage_events(verdict, decided_at);
```

**No `UNIQUE` constraint, deliberately.** A subject legitimately receives many verdicts over its
life (jail, later un-jail, later re-jail with new evidence). Identity is `id`, matching the
reasoning for `blacklist_events` (`docs/specs/blacklist-metadata.md:223-225`). The *effective*
verdict for a subject is the row with the greatest `decided_at` that no other row's
`supersedes_id` points at; the query is one `ORDER BY decided_at DESC LIMIT 1` over the chain, and
the index above serves it.

**Why `rule_ids` is a JSON array and not a rule column.** A single decision can be justified by
several rules at once (S2 and S5 both firing), and the ledger must record what the human saw, not a
normalised single cause. Same idiom as `findings.matched_patterns` (`app/database.py:62-65`).

**Backup.** Two entries are required in `app/routes/backup.py`: `_TABLES["triage"] =
"triage_events"` and `_NATURAL_KEYS["triage"] = ("id",)` (`app/routes/backup.py:32-50`). This is
the same id-keyed path `docs/specs/blacklist-metadata.md:596-610` specifies for
`blacklist_events`, including its consequence: the importer's dynamic branch drops `id`
(`app/routes/backup.py:257`), so an id-keyed section must take the fixed-key path or it imports
every row as "skipped". The existing `blacklist` and `jaillist` export statements name columns
explicitly (`app/routes/backup.py:69-74`) and will silently strip the §7.1 columns unless they too
are extended — the same asymmetry the prior spec documents at `:582-594`.

### 7.3 Legacy `findings` rows with `intent=''`

| Case | Treatment |
|---|---|
| `action='ALLOW'` but `intent=''` (row written before the intent column existed) | **Treated as REACH.** The value is a pure function of `action` (`app/services/result_processor.py:156-158` says so explicitly), so the correct `intent` is recoverable. |
| `action=''` and `intent=''` | **Excluded from both queues**, but surfaced. The row has no recorded proxy disposition, so it cannot be classified. It is still evidence of *something* and must not be silently dropped from display; it simply cannot trigger a rule. |
| `action='DENY'` but `intent=''` | Does not arise: the intent column and the DENY persistence land together. If it does arise (a partial migration), treat as ATTEMPT by the same `intent_for_action` mapping (`app/services/result_processor.py:128-139`). |

**No backfill is required and none should be written.** `app/services/result_processor.py:154-158`
already commits to this: legacy rows keep the `''` default and `intent` is a pure function of
`action`. The queue queries therefore evaluate intent as
`COALESCE(NULLIF(intent, ''), CASE WHEN action='ALLOW' THEN 'REACH' WHEN action='DENY' THEN 'ATTEMPT' ELSE '' END)`
rather than reading the column raw. This expression is defined once in the escalation module, not
duplicated per query.

**Dependency, stated plainly:** the `intent` column and the DENY-persistence change are the
in-flight workstream. As of this writing, `app/database.py:134-141` and `:178-181` add the column
and its index, `app/services/monitor.py:652-662` persists both actions, and
`app/services/result_processor.py:128-139` derives the value. **`app/database.py` is not part of
this design's scope and this document does not modify it.**

---

## 8. Implementation order

Each step is independently verifiable. Step 1 is the only ordered blocker.

| # | Step | Type | Acceptance criterion |
|---|---|---|---|
| **1** | **Confirm the intent workstream is wired end to end before anything else.** The column, the index, the two-action filter, and the derived value all exist in the working tree (`app/database.py:134-141`, `:178-181`; `app/services/monitor.py:652-662`; `app/services/result_processor.py:128-139`). **Verify it actually runs:** `python -m pytest tests/test_patterns.py -k store_findings`, then poll once and check `SELECT action, intent, COUNT(*) FROM findings GROUP BY action, intent` returns both `ALLOW/REACH` and `DENY/ATTEMPT`. | Pure backend | The tests pass and both rows are present. This step is a **live regression detector, not a formality**: `app/services/result_processor.py:249` calls `db.executemany` with `col_names`/`placeholders`, and during the writing of this document that edit did intermittently leave `all_cols` assigned at `:215` while the derived `col_names`/`placeholders` were stripped, producing `NameError: name 'col_names' is not defined` and storing **zero** findings per poll. That failure is silent in production — the poll continues, the alert still fires, and the ledger is simply empty, which starves both queues. Run this check before any queue work and after every change to `store_findings`. |
| 2 | Add §7.1 `jaillist_entries` columns and §7.2 `triage_events`, in `init_db`. | Pure backend | Fresh DB contains both; a pre-existing DB upgrades with no row loss (`SELECT COUNT(*) FROM jaillist_entries` unchanged) and no constraint change. |
| 3 | Write `app/services/escalation.py`: pure functions `destination_suggestions(db, window_days)` and `source_suggestions(db, window_days)`, returning the §2.3/§3.3 payloads. Two aggregate queries, not per-entity ones. | Pure backend | Unit test with a hand-seeded `findings` table: a destination reached by 3 distinct clients appears once with `distinct_reach_clients=3`; a destination reached by 2 does not. A client with 1 REACH + 3 ATTEMPT to one blocked `base_url` appears with `rule_ids=['S2']`. No `rule_info` read; no bandwidth field in the payload. |
| 4 | Implement the §2.4 suppression predicate and the §4.3 `INCONCLUSIVE` suppression. | Pure backend | After a `HARMFUL_DESTINATION` verdict on a blocked destination, an injected ATTEMPT-only run leaves the queue unchanged; injecting one REACH re-queues it at rank 1 with `rule_ids=['D2']`. |
| 5 | `GET /api/triage/suggestions?queue=destination\|source` returning the queue rows. Admin-gated following `app/routes/blacklist.py:49`. | API | Response shape matches §2.3/§3.3; every field traceable to a persisted column or an explicit "unavailable". No value in the response is computed from `duration_seconds` or `bytes_*`. |
| 6 | `POST /api/triage/verdict` — writes `triage_events`, and for the two artifact-producing verdicts calls the existing list write in the **same transaction**, then regenerates the feed. | API | `HARMFUL_DESTINATION` produces one `triage_events` row and one `blacklist_entries` row plus a regenerated `urls.txt`; `HARMFUL_SOURCE` likewise for `jaillist_entries`/`jail-ips.txt`; `NOT_HARMFUL` produces a `url_patterns` row with `pattern_type='whitelist'` and **no** feed change; `INCONCLUSIVE` produces one `triage_events` row and **no** other write. Reject a request with no authenticated identity. |
| 7 | Populate `finding_id` on every confirming write, from the queue row's originating finding. | API | After a jail confirm from a queue row, `SELECT finding_id, reason, decided_by FROM jaillist_entries WHERE value=?` returns the row's id, a non-empty reason, and the admin identity. |
| 8 | `GET /api/triage/history?subject=...` — the verdict chain and the destination's `blacklist_events` history, shown as two separate facts. | API | Mirrors `docs/specs/blacklist-metadata.md:438-448`: "blocked with no events", "blocked with events", "not blocked with events" are three distinguishable responses. |
| 9 | Extend the alert payload per §5.2 and replace the two Teams buttons with queue links (`app/services/msteams.py:43-52`). | API | Card carries intent, per-client breakdown, prior-attempt count, block status, local labelled time. No card action performs a write. |
| 10 | Add the destination queue and source queue to the nav (`admin-ui/src/components/Sidebar.tsx:129-160`) and the `View` union / stored-view allowlist (`admin-ui/src/App.tsx:97`). | UI | Nav shows both queues; a stored deep link does not 404. |
| 11 | Build the two queue pages: ranked list, per-row evidence panel per §2.3/§3.3, four verdict buttons per §4.2. | UI | Every number on screen traces to a persisted column; a row with `intent=''` renders "intent unrecorded", never a fabricated class. |
| 12 | Render the jail entry's findability fields (reason, url, category, note, decided_by/at, evidence_summary) on the Jaillist page, and make an existing jail entry editable **by appending a `triage_events` correction**, not by mutating the row. | UI | A jail entry created from a queue row explains itself on screen with no second query, and a correction adds a history row. |
| 13 | Backup: add the `triage` section (`_TABLES`/`_NATURAL_KEYS`) and extend the explicit `blacklist`/`jaillist` export column lists. | Pure backend | Export → wipe → import round-trips `triage_events` with the same count and ids; importing into a populated DB restores nothing and raises `skipped` (same semantics as `app/routes/backup.py:107-109`). |

Steps 1-4 and 13 are pure backend; 5-9 are API; 10-12 are UI. Step 1 is the sole ordered blocker.

---

## 9. What this must never do

1. **Never write a feed automatically.** `urls.txt`, `ips.txt`, and `jail-ips.txt` are written only
   by `sync_regenerate` (`app/services/feeds.py:52`) and `sync_regenerate_jail` (`:69`), which are
   called only from startup (`app/main.py:68-69`) and from the mutation routes
   (`app/routes/blacklist.py:71-73`, `app/routes/jaillist.py:50-52`). No timer, no threshold, no
   scheduler job may call them. The existing `blacklist_tracked_hosts` auto-write
   (`app/services/redirects.py:22-34`) is **not** extended by this design and should be converted
   to a queue entry in a separate change.
2. **Never auto-jail.** §3.4. The owner permits it; this document recommends against it and the
   recommendation is part of the design, not a preference.
3. **No fabricated values anywhere in the queue display or the alert.** This is the boundary that
   `app/routes/hosts.py:52-58` violates today: `_synthesize_bandwidth` multiplies a request count
   by `0.12` and formats it as MB (`:57`), and the same fabrication is duplicated client-side at
   `admin-ui/src/api.ts:1530-1537`, whose own comment says the value is chosen "so the card matches
   the wireframe ('4.2 GB')" (`:1531-1532`). Both sit on a surface from which a device can be
   jailed. No queue field may be produced that way; a count that does not exist renders as
   unavailable, never as `0` and never as an estimate.
4. **Never decode `rule_info`.** Frozen and permanent (`docs/revamp-proposal.md:572-581`,
   `:680-682`). It is stored (`app/database.py:154`) and may be displayed as opaque text; no rule,
   threshold, score, ranking, or feed line may derive from it.
5. **No new identity data.** No MAC, no department, no person. `client_ip` is the only identity this
   deployment carries and the only one this design uses. The separate IP-to-owner system stays
   unintegrated (`docs/revamp-proposal.md:674-678`); the moment a name attaches to a `client_ip`,
   the feed contract becomes a privacy surface and the jail decision acquires a different review
   process.
6. **No second risk-scoring model.** Rankings here are rule counts, stated in the rules, not env-tuned
   weights. `app/services/readout.py:169-176` is a competing model and this design does not consult
   or extend it.
7. **No change to any feed's bytes.** One value per line, bare host or bare IP, CRLF-terminated with
   a trailing CRLF, written atomically. The §7.1 columns are management-side metadata and have no
   path into `jail-ips.txt`, whose writer selects one column only (`app/services/feeds.py:74-76`).
8. **No `UNIQUE` constraint added to any ledger table.** Repetition is the point of both
   `blacklist_events` and `triage_events`.
9. **No verdict edit or delete.** Corrections are new rows with `supersedes_id` (§4.4).
10. **No queue item without a named rule.** A suggestion the operator cannot evaluate from its own
    displayed reason does not ship.
