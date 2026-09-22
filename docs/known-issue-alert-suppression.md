# Known issue: a destination already on the blacklist still alerts

Status: **a record of what was decided and why, NOT a task list.** This document
captures a symptom, the decision taken in response, and the alternatives that
were considered and rejected. It is written to be read as the rationale behind
the shipped behaviour, not as a plan for future work. No item here is a to-do.
Every `file:line` below was re-read in the working tree at the time of writing.

---

## 1. The reported symptom

An operator reported that a host **already on the blacklist still produces an
alert**. The host was blocked, the operator had already decided it was harmful,
and yet the n8n webhook (and the MS Teams card) kept firing with that host in
the payload — asking the operator to re-block a destination the blacklist
already contained.

## 2. Why it happens

The poll builds its frame with **only a whitelist filter**, not a blacklist
filter. `app/services/monitor.py:659` calls `apply_filters(..., actions=("ALLOW",
"DENY"))`, and `apply_filters` (`app/services/result_processor.py:193`) drops
only whitelisted URLs (its `whitelist_regex`, `exclude_whitelist=True` default).
Nothing in that frame is removed for being blacklisted. So a row whose
`base_url` is a blacklist entry survives the filter, is `ALLOW` (a **REACH** —
the client actually reached the destination), and therefore reaches
delivery unchanged. The whitelist filter answers "is this an operator-approved
destination?"; it was never a block list, and it was never intended to be.

**The compensating signal — this is the important half.** A host that is on the
blacklist *and* whose traffic is dominated by `ALLOW` rows is precisely the
**inverse** case: the enforcement was *defeated*. The client reached a
destination the operator had already blocked, which is the strongest signal the
system has (the enforcement point failed). That condition must remain visible —
it is the D2 rule of `docs/suggestion-queues.md:126`. And a blacklist entry that
is *never* reached produces **no rows at all** (nothing to query), so it cannot
generate an alert in the first place. Two cases, then: (i) a blacklisted
destination showing `ALLOW` rows is enforcement-defeat evidence and must not be
silenced as "just noise"; (ii) a blacklisted destination nobody touches is
invisible. The suppression in §3 is scoped so it never hides (i).

---

## 3. The decision

**Suppress before delivery on exact blacklist membership, and on DENY, and
retain the evidence.**

- **Rule.** A filtered row is withheld from delivery when `action == "DENY"`
  (the proxy already enforced the policy — ADR 0001, the request is "handled")
  or when its `base_url` is exactly a `blacklist_entries` value. This is the
  canonical rule, implemented once, in `alertable_check`
  (`app/services/result_processor.py:250`): it derives `enforced` from the
  action column (`:292`) and `blacklisted` from exact `base_url` membership
  (`:299`), then withholds the union.
- **Whole-row suppression.** The *entire* row is withheld or delivered —
  nothing is edited, truncated, or re-labelled. A row is alertable or it is not.
- **Both delivery paths.** The withheld set is excluded from the n8n payload
  *and* the MS Teams card. The poll computes the alertable frame once
  (`app/services/monitor.py:692`) and both call sites read from it.
- **Evidence retained.** Suppression is a *delivery* decision, never a
  *persistence* decision. `store_findings` receives the full filtered frame, so
  a suppressed row is still written to `findings` — it is evidence, and the
  operator can still see it. The counts are recorded on the `monitor_logs` row
  (`app/database.py:327-329`) and surfaced in the Logs page.

The observable consequence, and the one the frontend keys on: the backend
writes the withholding reason prefixed with the literal `suppressed:`
(`app/services/monitor.py:718`, `:734`; `app/services/delivery.py:127`), and the
Logs page renders a distinct primary `n8n: suppressed` / `Teams: suppressed`
badge off that prefix (`admin-ui/src/components/LogsPage.tsx:261`,
`:275`, `:300`) — deliberately *not* the `secondary` "skip" badge, which means
something else entirely ("the row never reached delivery").

---

## 4. Rejected alternatives

Three alternatives were considered and rejected. Each is recorded with its
reason, because the reason is the part that must survive.

### (i) Suppress on jaillist client-IP membership — REJECTED

A naive extension would be "also withhold a row when its `client_ip` is on the
jaillist." **This was not implemented.** `app/services/jaillist.py` stores every
value as a **single-host CIDR** — `ip/32` for IPv4, `ip/128` for IPv6
(`app/services/jaillist.py:11`, `:56`, `:61`). The stored form is therefore
`10.0.0.5/32`, never the bare `10.0.0.5`. A naive check of
`client_ip IN jaillist_entries` would compare a bare IP against CIDR strings and
**silently never match** — a suppression rule that looks active and does
nothing, which is worse than no rule. Making it correct would require
normalizing both sides on every poll, for a rule that is also **orthogonal to
what this issue is about**: jaillisting is *source*-side (which client to jail),
while the blacklist is *destination*-side (which host to block). The reported
symptom is a destination problem; source-jailing does not address it.

### (ii) No suppression table, no stored `suppressed` boolean — REJECTED

Suppression stays a **pure function of persisted membership plus the row's own
action**. Nothing about "was this row suppressed?" is stored on the row itself,
because that would create a **second source of truth about what is blocked**.
The blacklist is the answer to "what is blocked"; a per-row flag would be a
derived copy that can drift the moment the blacklist changes (a destination
un-blocked later would leave stale `suppressed=1` rows asserting it is still
blocked). This is the same reasoning `docs/suggestion-queues.md:198-201` gives
for rejecting a stored `suppressed` flag: the drift risk is exactly what
`docs/specs/blacklist-metadata.md` documents and rejects. For the same reason
there is **no suppression table** — membership plus the row's action is
sufficient, and any table would be a cache of a fact the blacklist already
owns.

### (iii) No time cooldown / debounce — REJECTED

A "don't re-alert the same destination within N minutes" window was rejected as
**unrequested scope**. The repository contains no such concept today: there is
no cooldown, debounce, rate-limit, or alert-dedup primitive anywhere in the
delivery path (`app/services/delivery.py`) or the poll (`app/services/monitor.py`).
Adding one would introduce a new piece of delivery state, a new configuration
knob, and a new failure mode — for a symptom that is already fully addressed by
the membership rule in §3. The blacklist is a durable, operator-controlled
answer to "stop alerting me about this"; a time window would be a
*weaker, expiry-based* approximation of the same intent, and the operator
already has the durable one.

---

## 5. Relationship to the existing `webhook_reason` and the verdict ledger

**`webhook_reason` semantics.** This field already existed to explain *why a run
produced no delivery* — its established values are prose like `"No matches in
window — nothing to send"` (`app/services/monitor.py:649`) and the
all-whitelisted case. Suppression extends that same channel rather than adding a
parallel one: the withholding reason is written into `webhook_reason`, now
prefixed with the machine-readable `suppressed:` marker so the Logs page can
distinguish "suppressed" from the other skip reasons. A mixed window (some rows
alertable, some suppressed) also sets a reason, but appends `— not included in
this alert` rather than `— nothing to send`, so an alert that *did* fire is
never confused with one that did not.

**The asymmetric rule of the verdict ledger.** `docs/suggestion-queues.md` §2.4
(`:156`, `:185`) supplies the *destination* suppression predicate for Queue A,
and it is **deliberately asymmetric by intent, not by time**:

| Evidence since the last `HARMFUL_DESTINATION` verdict | Queue A behaviour |
|---|---|
| Only `ATTEMPT` rows (the expected steady state after blocking) | **Suppressed.** Silent, forever (`:189`). |
| ≥1 `REACH` row (the block was defeated — rule D2) | **Re-queued**, top of the list (`:190`). |

The relationship between that ledger rule and the delivery suppression in §3 is
direct and worth stating plainly: **an ATTEMPT row being permanently suppressed
is deliberate, in both places.** Once a destination is blocked, every subsequent
hit is a `DENY`, hence an `ATTEMPT` — a block *produces* an unbounded stream of
those rows by construction. If each one re-alerted (or re-queued), the operator
would see one destination forever and stop reading. So the steady state after
blocking is silence: suppressed at delivery (§3), and suppressed from the queue
(§2.4 `:189`). What re-opens the question in the ledger is a single `REACH` —
`ALLOW` traffic to a blocked destination, the enforcement-defeat case. That is
also why §3 suppresses on membership and DENY but must keep `ALLOW`-to-blocked
distinguishable: the delivery layer withholds the noise, and the evidence that
would re-open the question (`ALLOW` rows, which are persisted, never dropped)
remains in `findings` for the ledger to read.

---

## 6. Verified line map

Every `file:line` above was re-checked against the working tree at the time of
writing.

- `app/services/monitor.py:659` — `apply_filters(..., actions=("ALLOW","DENY"))`;
  the whitelist-only filter that lets a blacklisted `ALLOW` row through.
- `app/services/monitor.py:687-692` — the blacklist set read and the
  `alertable_check(df, blacklist)` call that narrows the frame to alertable rows.
- `app/services/monitor.py:718` / `:734` — the two writers of the
  `suppressed:`-prefixed reason (mixed window / all-suppressed).
- `app/services/monitor.py:649` — the pre-existing `webhook_reason` prose the
  suppression reason sits beside.
- `app/services/result_processor.py:250` — `alertable_check` (`def` at `:250`);
  `enforced` derived at `:292`, `blacklisted` at `:299`.
- `app/services/result_processor.py:193` — `apply_filters` (whitelist-only
  default `actions=("ALLOW",)`), the frame's filter.
- `app/services/jaillist.py:11` / `:56` / `:61` — single-host CIDR
  normalization (`ip/32` / `ip/128`), the reason a naive `client_ip IN
  jaillist_entries` never matches.
- `app/database.py:327-329` — the `suppressed_rows` / `suppressed_enforced` /
  `suppressed_blacklisted` columns on `monitor_logs`.
- `docs/suggestion-queues.md:156` / `:185` / `:189-190` / `:198-201` — the §2.4
  asymmetric suppression predicate, its ATTEMPT-permanent / REACH-reopens table,
  and the "no separate suppression table" decision.
- `admin-ui/src/components/LogsPage.tsx:261` / `:275` / `:300` — the
  `suppressed:` prefix constant, the badge predicate, and the primary
  `n8n: suppressed` label.
- `admin-ui/src/components/LogsPage.tsx:143` / `:158-159` — the `suppressed`
  and `Monitored dests` columns.
- `admin-ui/src/api.ts:324-328` — the three numeric `MonitorLog` fields.
