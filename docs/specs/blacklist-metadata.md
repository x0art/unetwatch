# Spec: Blacklist Metadata (operator-authored labelling of blacklist entries)

## Problem Statement

Block patterns are broad substring globs, so they over-match. The canonical example: the
pattern `*nonton*` also matches Indonesian news sites, because *nonton* means "watch" — the
hit is a legitimate destination that merely contains the substring. Every hit a pattern
produces is therefore only a **candidate**, and the decision that a destination should be
blocked is a human judgement made by manually inspecting the site. The operator is the only
party who can make that call, and does so one entry at a time.

Today that judgement is recorded nowhere. The blacklist stores a bare host and nothing else:
which full URL prompted the decision, what the operator saw, and why they concluded it
belonged on the list are all lost the moment the entry is added. The consequences compound:

- The evidence behind a past decision cannot be **reused** — the next operator (or the same
  operator months later) re-inspects a site that was already inspected.
- The decision cannot be **audited** — there is no way to review why a destination is blocked,
  or to spot a blocking decision that was wrong.
- The blacklist cannot serve as **training data** — a labelled set of blocked destinations with
  the operator's reasoning is exactly the labelling signal needed to later automate or assist
  triage, and right now that signal is discarded.
- The evidence does not link back to **what triggered it** — the entry does not point at the
  device and log line that produced the finding, so "why is this blocked?" cannot be answered
  from the row itself. (See `finding_id` in Implementation Decisions.)

The cost is paid in manual re-inspection and in the loss of a dataset that the operator's own
daily work is already producing.

**The dataset keeps one labelled row per block, and the device feed is deduped — and the split
between the two is the whole design.** The normalizer strips protocol, path, query, and fragment
(`app/services/blacklist.py:27-28`), so `https://porn-site.com/video/123` and
`https://porn-site.com/other` both normalize to `porn-site.com`. Two different consumers want two
different things from that fact, and an earlier version of this spec wrongly served only one of
them:

- **Training wants every block event.** The operator's stated purpose is training data, and a
  classifier trains on the *paths* — `https://porn-site.com/video/123` and
  `https://porn-site.com/other` are two distinct labelled examples even though they share a host.
  Collapsing them to one row discards the signal. So each block event is stored as its own row
  and the full URL of the block survives per event. A domain blocked many times therefore has
  many rows.
- **The device wants no duplicates.** The consumer device is a firewall parsing a plain-text list:
  a destination that appears twice is at best wasted bytes and at worst a parsing surprise. The
  feed file must keep exactly one line per blocked destination, regardless of how many block
  events exist for it.

Both are satisfiable at once because they read **different things**. Training rows (the new
`blacklist_events` table) are append-only and never deduped; the enforcement projection
(`blacklist_entries`, unchanged, still `UNIQUE (kind, value)`) is by construction one row per
destination, and the feed writer reads only that. The feed's lack of duplicates is a structural
property of the table it reads, not of the training rows. Say it plainly because it is the
mechanism that satisfies the device requirement without touching
`SELECT value FROM blacklist_entries WHERE kind = ? ORDER BY value`: **deduplication has moved
out of the table and into the feed writer.**

## Solution

When the operator blacklists a destination, they may also record the reasoning behind it:

- the **full URL** that triggered the blacklisting — e.g. `https://porn-site.com/video/123`,
  not just the host `porn-site.com` — so the actual evidence is kept;
- a **category** — free text the operator chooses;
- a **note** — free text recording why the destination was judged blockable.

All three are optional. The operator adds them while working, or not at all. Existing entries
keep working and gain nothing. The bare host continues to be what the device consumes, and the
plain-text device feeds are unchanged.

Two mechanics make this work honestly, and both are part of the design rather than details to
be discovered while implementing:
1. **Re-blocking a domain records a new event.** Blocking a domain that is already blocked must
   not silently discard the metadata the operator just supplied — but it must also not overwrite
   the record of the earlier block. The write path therefore (a) appends a new row to the
   append-only `blacklist_events` table for **every** add, carrying that add's full URL,
   category, note, and `finding_id`, and (b) ensures the destination exists in
   `blacklist_entries` via `INSERT OR IGNORE`. Nothing is coalesced and nothing is overwritten:
   the earlier event keeps its URL and the later event keeps its own. (An earlier version of this
   spec collapsed the second add into an upsert on the first — that is the behaviour this design
   reverses.)
2. **The entry points back at its evidence.** The existing `finding_id` column — accepted by the
   API and written by the single-add route, yet never populated by any caller today — becomes the
   link from a block event back to the device and log line that triggered it, by being populated
   from a Findings row action. It is recorded on the *event*, which is where the evidence lives,
   rather than on the destination, which is shared by every event for that host.

The blacklist thereby becomes three things at once: the enforcement input it already was, an
append-only labelled dataset of **block events** (full URL, category, reasoning, and evidence
anchor attached, authored by the human who made the call), and an evidence index that ties each
block back to the finding that prompted it. The dataset grows per *block*, not per host. The
device feed does not grow with it: it still lists each blocked destination exactly once, because
it is generated from the enforcement projection, which holds each destination exactly once.


## User Stories

1. As an operator, I want to add a blacklist entry together with the full URL that triggered
   the decision, so that the evidence behind the block is preserved.
2. As an operator, I want to record a free-text category on a blacklist entry, so that I can
   group blocked destinations using vocabulary that fits my own judgement.
3. As an operator, I want to record a free-text note on a blacklist entry, so that the reason I
   judged a destination blockable is written down rather than held in my head.
4. As an operator, I want to add a blacklist entry with no metadata at all, so that a quick
   block is not slowed down by mandatory fields.
5. As an operator, I want to add a blacklist entry with only a category and no note (or vice
   versa), so that I can record as much or as little as I actually know.
6. As an operator, I want to blacklist a destination directly from a Findings row action and
   carry the row's full URL onto the new block event, so that the evidence travels with the
   decision without retyping.
7. As an operator, I want the Findings row action to also record the finding's id on the block
   event it creates, so that I can get from a block back to the device and log line that
   triggered it.
8. As an operator, I want to blacklist a destination from the URL Investigation page with the
   investigated URL attached, so that the page where I made the judgement is the page that
   records it.
9. As an operator, I want to add a blacklist entry from the global header dialog and optionally
   attach metadata, so that capture is possible from anywhere in the app without lying about
   the evidence.
10. As an operator, I want to bulk-import a plain list of hosts with no metadata, so that my
    existing import habit keeps working exactly as it does today.
11. As an operator, I want to attach shared metadata to a bulk import, so that a batch of related
    destinations does not have to be annotated one entry at a time.
12. As an operator, I want each entry produced by a bulk import to keep the raw line I supplied
    as its recorded URL when the import carries a full URL, so that per-entry evidence survives
    batching.
13. As an operator, I want to view the block history recorded for a destination, so that I can
    read back the reasoning behind each block, not just that the destination is blocked.
14. As an operator, I want to edit the URL, category, and note on a block event after the fact,
    so that I can correct or complete a record when I learn more.
15. As an operator, I want to add metadata to a destination that was blocked before this feature
    existed, so that old blocks become part of the dataset too.
16. As an operator, I want to search or review block events by their recorded reasoning, so that
    I can find the precedents behind past blocking decisions.
17. As an operator, I want to export the block events with their metadata, so that I can take
    the labelled dataset out of the app for analysis or training.
18. As an operator, I want every block I perform to be recorded as its own labelled example, so
    that a host I have blocked from three different URLs trains on all three of those URLs rather
    than on one of them chosen arbitrarily.
19. As an operator, I want the training dataset to be append-only, so that recording a new block
    never overwrites or discards the evidence of an earlier one.
20. As an operator, I want to read back the full history of every URL that was blocked for a
    given destination, so that I can see the pattern of what actually led to the block rather than
    only the first thing that did.
21. As an operator, I want the UI to describe entries neutrally — a URL "matched a pattern" and
    is a "candidate" — so that the app never implies a judgement I have not personally made.
22. As an operator, I want no fixed list of categories offered or required, so that the
    classification stays a human judgement rather than being forced into the app's vocabulary.
23. As the downstream device/consumer, I want `/api/blacklist/urls.txt` to keep containing only
    bare domains, one per line, CRLF-terminated, so that my parsing continues to work unchanged.
24. As the downstream device/consumer, I want `/api/blacklist/ips.txt` to keep containing only
    bare IPs, one per line, CRLF-terminated, so that my parsing continues to work unchanged.
25. As the downstream device/consumer, I want metadata never to appear in either feed under any
    circumstance, so that a leaked annotation cannot corrupt the block list my firewall applies.
26. As an operator, I want the feed files to remain byte-identical after this change, so that I
    can deploy it without revalidating what my device consumes.
27. As an operator, I want an existing database to gain the new fields transparently on startup,
    so that upgrading does not require a manual migration step.
28. As an operator, I want existing entries to retain their exact values through the upgrade, so
    that nothing that is currently blocked inadvertently stops being blocked.
29. As an operator, I want metadata to be entirely optional everywhere — single add, bulk add,
    and lookup — so that omitting it is never an error.
30. As an operator, I want an exposed entry returned with empty metadata when none was recorded,
    so that the UI can render a uniform shape without special-casing old rows.
31. As an operator, I want the recorded URL to be stored as supplied even when the host is
    normalized, so that I keep the full evidence path while the feed keeps the bare host.
32. As an operator, I want a backup export followed by a restore to preserve the URL, category,
    and note on my blacklist entries, so that restoring after a wipe does not silently discard the
    training data the feature exists to accumulate.
33. As an operator, I want a re-block of an existing entry never to lose metadata that is
    already recorded, so that working quickly does not damage the dataset.
34. As an operator, I want metadata I supply for a domain currently owned by an upstream feed to
    promote that domain to a manual entry, so that my judgement is not silently deleted by the
    next upstream sync.
35. As the operator/auditor, I want no write path ever to leave a metadata-bearing row marked as
    an upstream row, so that the periodic upstream prune can never delete my URL, category, or
    note.
36. As an operator, I want a block performed after this feature shipped to be recorded even when
    the destination was already blocked, so that the per-block history does not silently stop at
    the pre-feature entries.
37. As an operator, I want unblocking a destination to remove it from enforcement without
    destroying the training examples recorded for it, so that unblocking a host that turned out
    to be a false positive does not throw away a correctly-labelled history of it.
38. As an operator, I want the UI to show a destination's block history separately from whether it
    is currently blocked, so that "blocked, and blocked five times" and "not blocked, but blocked
    five times historically" are distinguishable states rather than one ambiguous row.
39. As the downstream device/consumer, I want each blocked destination to appear at most once in
    the feed, so that a destination blocked many times over still costs me exactly one line and
    cannot confuse my parser.
40. As an operator, I want unblocking and re-blocking a destination to be idempotent with respect
    to the feed, so that adding a destination that is already blocked never duplicates its line
    and removing one that is absent is a no-op rather than an error.

## Implementation Decisions

**Schema — one new table, and `blacklist_entries` stays exactly as it is.** The dataset of record
is a new append-only table; the enforcement projection keeps its current shape and its
`UNIQUE (kind, value)`. This is the central schema decision and it is recorded precisely:

    blacklist_events(id, kind, value, source, finding_id, url, category, note, created_at)

DDL as it must be added to `app/database.py` in the existing `CREATE TABLE IF NOT EXISTS` style,
placed in the same block as the other `CREATE TABLE IF NOT EXISTS` statements (immediately after
the `blacklist_entries` creation at `app/database.py:169-179`, before the jaillist creation at
`:184-193`). It needs no `PRAGMA table_info` guard, because it has no columns to add to an older
shape — the table is new:

```
CREATE TABLE IF NOT EXISTS blacklist_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('url', 'ip')),
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    finding_id INTEGER,
    url TEXT,
    category TEXT,
    note TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

**Why each column exists — the DDL is not copy-paste boilerplate:**

- `id` — one row per block, so identity cannot be `(kind, value)`; the event needs its own key
  because the same `(kind, value)` recurs with every block. This is the whole point of the table,
  and it is why the table carries **no `UNIQUE` constraint at all**.
- `kind` / `value` — the normalized destination that was blocked (`value` is the bare host after
  `normalize_blacklist_value`). This is the join key back to `blacklist_entries` and the column
  the feed dedupes on: the same `value` here is what (b) ensures exists once.
- `source` — the provenance of *this block event* (`manual` / `finding` / `redirect` / `auto` /
  `upstream`), copied from the same request the enforcement insert uses. It is per-event because
  one destination can be blocked once by an operator and once by an upstream sync, and the
  history should say so; it is not the prunable switch that `blacklist_entries.source` is.
- `finding_id` — the evidence anchor: the Findings row (device + log line) that prompted this
  block. Nullable, because most blocks are manual. Recorded per event because each block can be
  prompted by a different finding (see the evidence-link decision below).
- `url` — the FULL URL of this block, stored as supplied, never normalized. This is the column
  the entire feature exists for: it is the per-event training signal that the previous one-row
  design discarded.
- `category` / `note` — operator free text, per event, recorded as written. Free text and never
  an enum (see the no-enum decision below).
- `created_at` — when the block happened. Needed because the table is append-only and its whole
  value is the *sequence* of blocks; without a per-row timestamp the history is unordered.

**`blacklist_entries` is NOT altered.** Its constraint stays exactly as declared at
`app/database.py:170-178`, including `UNIQUE (kind, value)`, because the feed's
no-duplicates-by-construction property is derived from that constraint and nothing else. The
three metadata columns from the earlier draft (`url`, `category`, `note`) may still be added to
it as optional mirror columns for the UI, but they are not required by this design and the events
table is authoritative. Nothing on `blacklist_entries` is dropped, renamed, or relocated.

**Migration — purely additive, with no data movement, and no table rebuild.** Because the new
table has no `UNIQUE (kind, value)` and does not exist today, creating it is a plain
`CREATE TABLE IF NOT EXISTS` with no `PRAGMA table_info` guard needed. Creating a table does not
touch rows other tables hold, so on an existing database this migration adds one empty table and
changes nothing else: **no existing row is rewritten, no unique key is dropped, no table is
rebuilt, and no copy-into-new-table-and-swap is performed.** If the earlier draft's mirror columns
are kept on `blacklist_entries`, those are the same plain nullable `ALTER TABLE ... ADD COLUMN`
adds as before. This is stated as a conclusion rather than left to the implementer: there is no
table in this design whose existing constraint must be removed, because the table that must be
free of `UNIQUE (kind, value)` — `blacklist_events` — is new and never had one. The one thing the
migration chronology must make unambiguous: the events table is created before the write routes
reference it, which `CREATE TABLE IF NOT EXISTS` above the route registration already guarantees;
a database whose `blacklist_entries` has pre-normalization garbage is handled by the existing
normalization migration at `app/database.py:274-300` (comment at `:274`, block at `:278-300`),
unchanged, and the events table simply starts empty (it can be backfilled from the mirror columns
if those were kept, but that is optional and not required).

Note on `source` while we are here: the column's inline comment at `app/database.py:174` reads
`'manual' | 'finding'`, but there is **no CHECK constraint** on `source` and no closed set — five
values are written in practice (`manual`, `finding`, `upstream`, `redirect`, `auto`; the backup
importer's allowlist is `app/routes/backup.py:203`). The single-add request model does carry a
closed pydantic pattern (`^(manual|finding|redirect)$`, `app/models.py:55`), but that constrains
only that one input, not the column. No spec text may imply a constraint or a closed set on
`source`.

**Normalizer — unchanged.** Value normalization continues to reduce an input to a bare host and
return `(kind, value)`. Metadata rides *alongside* the normalized value, never inside it, so no
metadata can influence `kind`/`value` and the normalizer requires no modification. A recorded
`url` is stored as supplied; it is not passed through the normalizer, and it never becomes the
stored `value`.

**Write path — both routes are rewritten, and the write is now two statements (this is the
load-bearing change).** Today `app/routes/blacklist.py:65-69` (single add) and `:106-110` (bulk
add) both use `INSERT OR IGNORE` into `blacklist_entries`. Under the new design that single write
becomes a **per-block append** plus an **enforcement ensure**, and both routes must be rewritten —
this is not negotiable, and neither route can be left as-is:

```
-- (a) append the block event: one row per block, metadata lives here, nothing is coalesced
INSERT INTO blacklist_events (kind, value, source, finding_id, url, category, note)
VALUES (?, ?, ?, ?, ?, ?, ?)

-- (b) ensure the destination is in the enforcement projection.
--     Plain INSERT OR IGNORE is correct when the destination is not upstream-owned:
--     it is a no-op if the destination is already blocked. Its ONLY job is "is this
--     destination in the enforcement set", so an existing operator-owned row is left alone.
INSERT OR IGNORE INTO blacklist_entries (kind, value, source) VALUES (?, ?, ?)
```

There is exactly **one** enforcement statement, `(b)`, and it is the one above. The write path
must never coalesce metadata into `blacklist_entries` and must never update any column of an
existing enforcement row for its own sake: the metadata belongs to the event from (a). The single
exception is the upstream-promotion rule stated in full below, which is a `WHERE`-scoped `DO
UPDATE` used only to move an upstream-owned row out of the prunable set — and even that statement
leaves every data column of the enforcement row untouched. Any other `DO UPDATE` on
`blacklist_entries` in this design is wrong.

**Why each INSERT names its columns.** Both statements list their columns explicitly, and that is
required, not stylistic. Column-list omission is the classic way this feature ships dead: a write
that omits a column stores NULL for it, and for `blacklist_entries` — whose whole point is a
unique destination — there is no later write that can repair a row without also appending a
misleading event. The existing single add currently names `(kind, value, source, finding_id)` and
the bulk add names `(kind, value, source)`; the event insert names all seven columns, and the
enforcement insert names `(kind, value, source)` because the metadata now belongs to the event,
not the destination.

**Transaction boundary — stated precisely.** For a single add, (a) and (b) run on the same
`db` connection inside one transaction: open the transaction, execute (a) then (b), read
`cursor_b.rowcount` for the feed decision below, `commit`, then `sync_regenerate`. The commit is
the boundary: the feed write happens *after* commit, so a crash between commit and feed
regeneration leaves the DB authoritative and the feed stale-but-valid, exactly as today — the
feed is never ahead of the DB. For a bulk add the boundary is the whole batch, preserving the
current shape (the loop executes (a) and (b) per entry, one `await db.commit()` after the loop at
`:116`, one `sync_regenerate` at `:117-119`). Opening the transaction before (a) is required for a
different reason than atomicity-of-pair: the `rowcount` from (b) is only portable to the
post-commit `sync_regenerate` decision if nothing between them issues an implicit commit on the
same connection.

**The regeneration guards at `:71-73` / `:117-119` do NOT need to change, and here is why.** An
earlier draft of this spec got this wrong by carrying the old upsert's premise forward. Under the
old design the write *was* the upsert, and an upsert reports `rowcount == 1` even when its
`DO UPDATE` branch changed nothing — so `rowcount` would have been a meaningless change signal
and a second, different mechanism (a pre-image comparison or `changes()`) would have been
required. **That upsert no longer exists.** In the new split the only `rowcount` the guard reads
is (b)'s — the `INSERT OR IGNORE` into `blacklist_entries` — and (b) does not migrate the
destination row's data, so SQLite's `INSERT OR IGNORE` `rowcount` means exactly what it always
meant: **`rowcount == 1` iff a new enforcement row was actually created, i.e. this is a new
destination.** Therefore `if cursor.rowcount:` at `:71-73` and `if touched:` at `:117-119` keep
their current form unchanged. The one thing that must change is the *returned payload*:
`:74`'s `{"added": [value] if cursor.rowcount else []}` and `:111-115`'s `added` / `skipped`
lived in a route that also committed a metadata write for the same call, so "skipped" is now a
half-truth and the response must be made consistent with the events table (the design decision is
in the API contract below; the point here is that it is a payload change, not a guard change).

**Why the guard must NOT be changed to "always regenerate".** The two failure directions are not
symmetric and the spec decides both explicitly:

- **A new destination is added → the feed MUST be regenerated.** (b) returns `rowcount == 1`, the
  existing guard already fires, and `sync_regenerate` runs. No change needed.
- **Only event metadata was recorded for an already-blocked destination → the feed must NOT be
  falsely reported as changed, but it must never be *silently skipped* as a write.** (b) returns
  `rowcount == 0`; the destination is already in the enforcement set, so the feed content is
  already correct and re-writing it is pure churn (a 1 MB feed re-fsync'd for nothing). The guard
  correctly skips the *feed write*. The event row from (a) was already committed, so the
  metadata is not lost — the "silent skip" that matters (the event) cannot happen, because (a)
  is unconditional. The bug this design must not reintroduce is the old one: an add whose *only*
  effect was metadata going back to `INSERT OR IGNORE` and vanishing. Here (a) never vanishes.

**Bulk add inside-batch duplicate and per-line metadata.** A batch that lists the same
destination twice appends two events (two blocks) and ensures the destination once — consistent
with "one row per block, one line per destination". The current per-request `url`/`category`/
`note` are shared batch metadata; where a batch line is itself a full URL, the event records that
line verbatim as its `url` (story 12), and the shared metadata fills the rest.

**Retention of `blacklist_entries.url` / `category` / `note`.** The canonical record of block
evidence is the `blacklist_events` row. `blacklist_entries` may keep the metadata columns (they
are harmless and the existing UI reads them), but they are now a *convenience mirror of the latest
event for one destination*, not the dataset of record, and the spec does not require them to be
kept in sync. The backup and training paths must read the events table; see the backup section.

**Hard constraint — the enforcement projection's `source` still gates dependency on the upstream
prune.** The upstream prune (`app/services/upstream_blacklist.py:177-199`) DELETEs
`blacklist_entries` rows `WHERE source='upstream'` that have vanished from the upstream feed. An
upstream-owned destination that has never been touched by an operator is therefore adoptable and
prunable; that is correct and stays. The hazard, unchanged from the earlier draft, is that a
destination the operator has deliberately blocked must not sit in the prunable set. The old
upsert expressed that as a `DO UPDATE SET source = CASE ...`; in this design the same intent is
carried by **one variant of statement (b), not a second statement**: when the destination's
existing enforcement row is upstream-owned, (b) is written as the `WHERE`-scoped promotion below
instead of the plain `INSERT OR IGNORE` shown earlier:

```
-- (b) [upstream-owned case only] the same statement, extended with a scoped promotion.
-- This is still "ensure the destination is in the enforcement set"; the DO UPDATE fires
-- ONLY for an upstream-owned row and touches ONLY source.
INSERT INTO blacklist_entries (kind, value, source) VALUES (?, ?, 'manual')
ON CONFLICT(kind, value) DO UPDATE SET source = 'manual'
WHERE blacklist_entries.source = 'upstream'
```

This is not a competing write path: it is (b) with a `WHERE` clause, and the implementer may use
it unconditionally (it degrades to `INSERT OR IGNORE` behaviour for a destination that is absent
or already `manual`, because the `DO UPDATE` simply does not fire). The `DO UPDATE` fires only
when the existing row is upstream-owned, promoting it to `manual` so the next prune cannot
adopt-and-delete it; it never overwrites an operator-owned row's `source`, because the `WHERE`
clause excludes them. Critically for the regeneration guard: this variant writes **only**
`source`, so it does not change the destination's membership in the enforcement set, and its
`rowcount` is still `1` iff a new row was created — the guard's meaning is unchanged (see the
guard decision above). The upstream path itself stays `INSERT OR IGNORE ... source='upstream'`
(`app/services/upstream_blacklist.py:260-264`) and **must never write `blacklist_events`**: an
upstream feed sync is provenance about a destination, not an operator block, and the training
dataset is operator-authored by definition. (If a future decision wants upstream arrivals in the
history, that is a separate, explicit change; it is out of scope here.)

**The events table is not governed by the prune, and that is the point.** Nothing in
`_prune_kind` may touch `blacklist_events`, and no FK / cascade may be introduced that would make
it delete events when an enforcement row goes away (see the next decision, which forbids exactly
that). The historical record must show that a destination *was* previously blocked by upstream,
even after the prune removes the enforcement row — the event row is the surviving proof.

**Deletion and unblock semantics — decided, and they are not obvious.** Today both delete routes
remove the `blacklist_entries` row and the destination leaves the feed; there is nowhere else for
the data to be. Under the new design delete has two possible meanings, and the operator's whole
purpose — accumulating training data — decides between them:

- **Deleting a destination UNBLOCKS it: it removes the enforcement row from
  `blacklist_entries`, and the destination leaves the feed.** This is the current, correct
  behaviour and is preserved.
- **Deleting a destination does NOT delete its block events.** The `blacklist_events` rows are
  kept. Rationale, in one line: the training dataset is the reason the table exists, and an
  unblock is one of the most informative labels there is (a destination the operator blocked and
  later judged wrong is a negative example of the *pattern* that fired, not garbage), so
  cascading the events away would destroy exactly the signal the operator asked us to keep.

Two consequences follow and must be stated rather than discovered:

1. **`DELETE /{kind}/{value}` and `POST /bulk-delete` must now do exactly one thing to the
   enforcement set and nothing to the events.** The current statements
   (`app/routes/blacklist.py:135-138` and `:175-178`) both `DELETE FROM blacklist_entries WHERE
   kind = ? AND value = ?`; those remain correct and unchanged for the projection. What must be
   added is the explicit rule that no route may cascade that delete into `blacklist_events` —
   there is deliberately no `ON DELETE CASCADE` and no trigger. The 404 at `:180-181` stays keyed
   on the *enforcement* row's `rowcount == 0`, not on any event, so unblocking a destination
   that is not currently blocked is still a 404 even if it has a long event history; that is
   intentional and the UI must not treat the 404 as "no history". The same destination may have
   MANY event rows and the routes still address it by `(kind, value)` — the routes are unchanged
   in shape precisely because they no longer touch the multi-row table.
2. **The UI must be able to show the two states, because they diverge.** After this change,
   "blocked" and "has block history" are independent: a destination can be (blocked, with
   events), (blocked, with zero events — an enforcement row with no recorded history, e.g. one
   created by an upstream sync or predating this feature), or (not blocked, with events — it was
   unblocked, or upstream pruned it, and the history survives). The per-destination view must
   therefore show block history (from `blacklist_events`) and current enforcement state (from
   `blacklist_entries`) as two separate facts, not as one row whose presence is the only signal.
   Editing/removing "a row" in the list (stories 13-14) now means editing an *event* or
   unblocking a *destination* — two different actions, and the spec expects the UI to name them
   as such. A destination that is blocked with no events shows empty metadata, not an error; a
   destination with events that is not blocked shows as unblocked with a history, not as absent.

**Upstream prune vs. events — the required rule.** When `_prune_kind` removes a destination's
enforcement row, that destination's `blacklist_events` rows MUST survive, and they must still
read as having been blocked by upstream at that time. The rule the spec requires is therefore:
the prune deletes from `blacklist_entries` only, and the surviving events keep whatever `source`
they recorded (`upstream` for an upstream-caused block, `manual` with the operator's metadata for
an operator-caused one). No event is deleted to match, and no event's `source` is rewritten when
its destination leaves the enforcement set. If the operator later re-blocks the destination, a
new event is appended and the enforcement row is recreated; the earlier events remain, so the
history across an unblock/re-block cycle is continuous.

**Backup needs a new section for the events table.** The events table is training data, so it must
be exported; without it a restore would recover the destination list but silently discard the
per-block history, which is the feature's purpose. The change: add
`_TABLES["blacklist_events"] = "blacklist_events"` and give it a natural key. The events table
has no natural key — the same `(kind, value, url)` can legitimately repeat across blocks — so the
correct choice is to use `id` as the key and export it. That requires the backup layer to accept
an `id`-keyed section (unlike the sections that drop `id`): state the key as `("id",)`, export the
row including `id`, and key the importer's `exists()` check on `id`. The alternative (a composite
`(kind, value, url, created_at)`) is rejected because it can collide for two genuine blocks of the
same URL in the same second, which would drop a training row on restore. The `blacklist` section
keeps `_NATURAL_KEYS["blacklist"] = ("kind", "value")` and gains the metadata columns the earlier
draft specified if those mirror columns are kept; the new events section is additive and does not
change the `blacklist` section's keying.

**The evidence link is the point, and it is currently dead.** `finding_id` already exists
(`app/database.py:175`), is written by the single-add route (`:66-68`), and is accepted by
`app/models.py` (`:53-56`) — but no caller ever populates it. The only UI write path,
`addBaseUrlToBlacklist` (`admin-ui/src/api.ts:1267-1275`), sends `{ value }` and nothing else. So
the column is dead-by-default: the operator cannot get from "why I blocked porn-site.com" back to
the device and log line that triggered it, and the spec's stated purpose (evidence plus training
data) is **not delivered by the metadata columns alone**. The design therefore requires that a
**Findings row action** populate `finding_id` from the row it was launched from, alongside the
row's full URL — and it writes both onto the **block event** (`blacklist_events.finding_id` /
`.url`), because the evidence belongs to the individual block, not to the destination shared by
every block of that host. Without that, this spec adds labels with no provenance and the "audited
decision" claim is unsupported.

**Feed writer — unchanged, and now the deduplication lives here by construction.** The feed
generator continues to run only `SELECT value FROM blacklist_entries WHERE kind = ? ORDER BY
value` (`app/services/feeds.py:32-36`, `_values()`) and to write `"\r\n".join(values) + "\r\n"` through
`_atomic_write` (`:39-49`, temp file + fsync + `os.replace`, `newline=""`). Two invariants are
stated explicitly and protected by tests:

1. **Only `value` ever reaches the device feeds, and the feeds never read `blacklist_events`.**
   The events table contains the operator's full URLs and free text; naming the enforcement table
   — whose columns are `id, kind, value, source, finding_id, created_at` and, if the mirror
   columns are kept, `url, category, note` — and selecting only `value` means metadata cannot
   leak in *by construction*.
2. **The feed has no duplicates, and the mechanism is the table it reads — not a `DISTINCT` in
   the query.** `blacklist_entries` still declares `UNIQUE (kind, value)`
   (`app/database.py:177`), so it holds at most one row per destination, so `SELECT value ...
   ORDER BY value` emits each destination exactly once. The training rows are not consulted, so
   three events for one host cannot become three feed lines. **Do not add `DISTINCT`, and do not
   change the query**: the deduplication has moved out of the table's row count and into the fact
   that the feed reads the deduped projection. `ORDER BY value` also keeps the feed's byte order
   stable, and a destination kept out of the result set by `UNIQUE` never appears twice.

The two plain-text feeds keep their exact current format — bare domain or bare IP, one per line,
CRLF-terminated with a trailing CRLF, written atomically — and the regeneration trigger points
(startup and after every mutation that added a new destination) are unchanged.

**API contract — additions only, plus one response correction the split forces.** These are the
request/response field changes to the blacklist endpoints:

- single add — request gains optional `url`, `category`, `note` (and the caller may now supply
  `finding_id` strongly typed); every one of these is written to the event row. The response's
  `added` list is **no longer a reliable statement about what happened**: an add that only
  recorded metadata for an already-blocked destination now leaves `added` empty while still
  having stored an event, so the response must be corrected to report that, not to imply the
  call did nothing. The exact shape is the implementer's, but the spec requires that the
  response distinguishes "destination newly blocked" from "block recorded for an
  already-blocked destination" (e.g. an `added` list plus a recorded-event indication).
- bulk add — request gains optional shared `url`, `category`, `note` applied to the batch, plus
  the option to derive each entry's URL from its own supplied line when it is a full URL;
  response keeps its `added` / `skipped` / `errors` shape, with the same caveat: `skipped` now
  means "already blocked", not "nothing was stored", because an event was appended for it.
- list — see the shape change immediately below; it must also be able to expose per-destination
  event history (see the delete/unblock UI note above).

**The update path is NEW work, and the list shape is a breaking change — say so plainly.** The
current routes are `:24 /urls.txt`, `:38 /ips.txt`, `:49 GET /entries`, `:58 POST /`, `:77 POST
/bulk`, `:123 POST /bulk-delete`, `:149 POST /upstream-sync`, `:157 GET /upstream-status`, and
`:165 DELETE /{kind}/{value}`. There is **no PUT or PATCH** anywhere, so "the operator can edit a
record" (stories 13-14) is not an extension of existing behaviour: it is new surface that must be
designed and built. Equally, `GET /entries` today returns only `{"urls": [...], "ips": [...]}`,
built from `SELECT kind, value` (`:49-55`) and consumed as that flat shape by the admin UI
(e.g. `getBlacklistSet`, `admin-ui/src/api.ts:1281-1289`, whose return type is
`{ urls: string[]; ips: string[] }`). Returning metadata per entry therefore cannot be a pure
addition to that payload: the shape changes and every consumer of `getBlacklistSet` must move with
it. This spec labels both the new update route and the `GET /entries` shape change as breaking /
new work rather than as an aside, and expects the implementer to update the UI call sites in the
same change. List responses stay auth-gated exactly as today, and the public `.txt` feed routes
stay public and format-identical.

All existing request payloads (value-and-source only, and bare bulk lists) remain valid and
behave exactly as before — omitting metadata is the back-compat case, not a special case.

**UI — state the real mechanism, not an aspiration.** The **only** blacklist add dialog is the
one mounted once in the app-shell header actions: `AddBlacklistButton` / `AddBlacklistDialog` at
`admin-ui/src/App.tsx:251-255`. It is not mounted per-page. Consequences that the spec must
reflect rather than gloss:

- Findings uses the blacklist set **only for a badge** — `FindingsPage.tsx` calls
  `getBlacklistSet()` (`:358`) to mark rows already blocked; it does not mount the dialog.
- URL Investigation does **not** open the dialog either; it POSTs inline via
  `addBaseUrlToBlacklist` (`UrlInvestigationPage.tsx:205`), which sends `{ value }` only
  (`admin-ui/src/api.ts:1267-1275`) — no metadata, no `finding_id`.
- `finding_id`/metadata therefore cannot ride along today *by construction*: no UI path sends it.
  The Findings row action is new work (see the evidence-link decision above), and the header
  dialog is the single place the three metadata inputs are added.

So: the header dialog gains optional inputs for `url`, `category`, and `note`; the Blacklist
page's per-feed entries — today bare value rows, one per destination — gain the ability to display
an entry's metadata **and its block history** (the list of `blacklist_events` for that
destination) alongside the value, without altering the feed-oriented list; the bulk-add dialog
gains optional batch metadata; and a Findings row action is added that carries the row's full URL
and its `finding_id` into the write path. Because the list is per-*destination* while the dataset
is per-*block*, the UI must not present one row as one labelled example; a destination row must
expand (or link) to its events. The form UX follows the existing list + feed + dialog mental model
already established by the blacklist and jaillist surfaces.

**No harm classification, and no enum.** There is no classification step anywhere in this
feature and no fixed vocabulary for `category`. The app does not decide that a destination is
harmful and does not offer a controlled list of categories, because classification is a human
judgement and the operator's own words are the only valid source. All UI copy and API
documentation use neutral framing — a URL "matched a pattern", it is a "candidate" — and never
assert harm. The words "harmful", "malicious", and "confirmed" do not appear in labels,
placeholders, or documentation.

**Note on the destination feed contract.** The proxy feed contract remains **destination block
list = bare domain only**. Metadata is operator documentation stored in the management app; it
has no path to the device.
**Backup export/import must carry the metadata — and the events table is a NEW section.** The
backup's `blacklist` section does not auto-pick-up new columns the way the `findings`,
`tracked_urls`, and `redirect_edges` sections do — those three are exported with `SELECT *` and
reduced by dropping `id`, so a new column rides along untouched. The `blacklist` section instead
exports an explicit column list (`kind, value, source` — `app/routes/backup.py:69-71`) and its
importer rebuilds an explicit row dict (`app/routes/backup.py:202-225`), so as written a backup →
restore round-trip would silently strip any metadata column on that section. That asymmetry is
why that section needs an explicit change if the mirror columns are kept. The surrounding
machinery stays as it is: the natural key is `_NATURAL_KEYS["blacklist"] = ("kind", "value")`
(`app/routes/backup.py:36`), and `exists()` indexes `_NATURAL_KEYS[section]` directly
(`:139-143`), so a `blacklist` section must keep supplying both keys for the existence check to
work. The same explicit-column and explicit-row-dict treatment applies to a metadata column the
mirror retains.

**The events table gets its own backup section, keyed on `id` — this is the change that actually
protects the training data.** `_TABLES` gains
`"blacklist_events": "blacklist_events"` and `_NATURAL_KEYS` gains
`"blacklist_events": ("id",)` (`app/routes/backup.py:32-50`). Two consequences the implementer
must handle, stated so they are not discovered mid-change: (a) `exists()` will run
`SELECT 1 FROM blacklist_events WHERE id = ?`, which is correct — an event's identity is its
`id`; and (b) the export path must include `id` for this section, unlike the `SELECT *`-minus-`id`
sections, because `id` is the key. The importer's dynamic branch already drops `id`
(`app/routes/backup.py:257`), so the events section must take the fixed-key path or be granted an
explicit exception; leaving it in the dynamic branch would drop the very key the section is keyed
on and import every event as "skipped". A composite key over `(kind, value, url, created_at)` is
rejected as noted above: it silently merges two genuine same-second blocks of the same URL, which
is data loss in a dataset whose purpose is per-event history. The restore semantics below apply
to events unchanged: importing an event whose `id` already exists restores nothing and does not
overwrite, consistent with the backup contract.

**Restore semantics on an existing row — stated precisely.** Import inserts with
`INSERT OR IGNORE`, keyed on the section's natural key — `(kind, value)` for `blacklist`, `(id,)`
for `blacklist_events`. Because of that, **restoring into a database that already holds that
domain restores NOTHING and does not update metadata**: the row is not inserted, the `skipped`
count rises, and the existing row's metadata is left exactly as it was. The same is true
per-event: restoring an export into a database that already contains those event ids adds no
duplicate and rewrites no event. This is consistent with the backup contract's existing "never
deletes or overwrites" guarantee, and it is acceptable — but it is a real consequence and is
stated rather than implied. Note one sharp edge the id-keying introduces: restoring an events
export into a database whose `blacklist_events` AUTOINCREMENT counter has already passed those
ids (because it has its own, different events) will collide on `id` and skip the imported rows —
so a full-database restore of the training set must target a wiped tablespace, which is the
normal recovery path. Two things follow for the operator: a restore is additive, not a
reconciliation, and restoring into a wiped (or fresh) database preserves the metadata and the
event history in full.

## Testing Decisions

Test external behaviour at the highest seam, not implementation details: assert on HTTP
responses and on the generated feed bytes, never on private helpers or column ordering.

The single seam is the HTTP API on the blacklist endpoints. Tests cover:

- **REGRESSION — the feed has exactly one line per destination even when a destination is blocked
  many times (highest priority).** This is the acceptance test for the operator's second
  requirement and it is kept first in priority. Block one destination from three different URLs —
  e.g. `https://porn-site.com/video/123`, `https://porn-site.com/other`, and
  `https://porn-site.com/third` — via three separate adds, then assert (a) the events table holds
  **THREE** rows, each preserving its own full `url`, and (b) `urls.txt` (and its on-disk file)
  contains exactly **ONE** line for `porn-site.com`. Three blocks, one feed line: that is the
  whole design in one assertion, and it fails if anyone reintroduces per-block rows into the
  enforcement table or adds a second source of feed lines.
- **REGRESSION — feed bytes are unchanged: CRLF, trailing CRLF, bare value, no metadata (highest
  priority, kept alongside the above).** After creating entries both with and without metadata
  and with multiple events per destination, fetch (and read the on-disk file for) each feed and
  assert the content is exactly the bare domains / bare IPs, one per line, CRLF-terminated with a
  trailing CRLF, `ORDER BY value` — with **no `url`, `category`, `note`, `id`, `source`, or
  `created_at` text anywhere** and no other field bleeding in. This must fail loudly if a future
  refactor widens the feed query or points it at `blacklist_events`, because it is the guarantee
  that a leaked metadata field or a duplicate cannot break parsing on the device.
- **add with metadata** — an add carrying `url`/`category`/`note` persists all three **on the
  event**, and the event's `url` is stored as supplied while its `value` is the normalized bare
  host; the destination exists exactly once in `blacklist_entries`.
- **add without metadata (back-compat)** — a value-only add still returns 201 and succeeds; the
  event's metadata is empty; the ordinary feed reflects the new host.
- **re-block appends a new event and does not collapse.** Block the SAME domain twice via two
  different URLs, with metadata supplied on the second call. Assert there are **two** event rows
  for that domain, the first still holding its original URL and the second holding its own (no
  `COALESCE`, no overwrite), and exactly one `blacklist_entries` row. This is the test that pins
  the reversal: it fails if anyone regresses to the old upsert or to `INSERT OR IGNORE`-only for
  the event.
- **bulk with metadata** — a bulk add with shared metadata applies it to the batch's events,
  deriving each event's URL from its own supplied full URL where applicable; a metadata-free bulk
  import behaves exactly as today; a batch naming one destination twice appends two events and
  leaves one enforcement row and one feed line.
- **list returning metadata and history** — the list endpoint exposes each destination's
  metadata and its event history (or the two are separately addressable), empty for destinations
  that never had metadata, alongside the existing fields.
- **events survive an unblock.** Block a destination from two URLs, then `DELETE` it (and, in a
  second case, `POST /bulk-delete` it). Assert the destination is gone from
  `blacklist_entries` and from the feed, **while both `blacklist_events` rows remain unchanged**
  with their URLs and metadata. Then re-block the destination and assert a third event is
  appended and the destination is back in the feed with exactly one line. This pins the
  no-cascade decision so a tidy-up refactor cannot quietly delete the training set.
- **events survive an upstream prune, and the history shows it was blocked by upstream.** Insert
  an upstream-enforcement row with a corresponding event (recorded via the operator path with
  `source='upstream'`, or with the row promoted appropriately), run a prune that drops the
  destination from `blacklist_entries` (feed loses the line), and assert the event rows remain and
  still record the destination as having been blocked by upstream. Also assert an upstream sync
  never writes `blacklist_events` and never flips an existing operator-owned enforcement row's
  `source`.
- **an operator add promotes an upstream-owned destination and cannot be adopted-and-deleted.**
  Populate a destination as `source='upstream'`, then block it via the operator path: assert the
  enforcement row becomes `source='manual'` (per the promotion variant of statement (b)), a new
  event row exists, and a subsequent upstream prune (the delete at
  `app/services/upstream_blacklist.py:194-198`) leaves the enforcement row and the events
  untouched.
- **backup round-trip preserves events and metadata, and restore-collision is a no-op.** Seed
  (or add) a destination with metadata and several events, export, wipe the tables, import, and
  assert the metadata is present on the restored rows **and the events table round-trips with the
  same count and the same `id`s / URLs** — not just the destination's existence. This is the test
  the explicit-column export and the id-keyed events section require: a count-only round-trip (as
  the existing backup test asserts) would pass while the per-block history was being dropped. Add
  the collision case explicitly: importing the same export into a database that already holds
  those destinations and event ids restores nothing, does not update metadata, and raises the
  `skipped` count for both sections.

`tests/test_blacklist.py` is the prior art: it already exercises add-normalization, add
duplicate idempotency, the public CRLF feeds, the bare-domain-only feed endpoints, list
splitting, bulk add/delete, and delete paths, and the shared `client` fixture (with a temp DB
and temp feed directory) is what the new tests build on.

## Out of Scope

- **No automatic classification.** Applying a category is a human judgement, made by manual
  inspection, always. The `category` field on the raw proxy documents exists but the operator
  confirmed it is not reliable enough to use as a classification signal, so it is never used to
  label anything automatically.
- **No workflow for the `url_patterns` table's own `name` / `category` / `notes`.** Those columns
  exist but no editor, API, or UI for them is added here.
- **No change to the feed format.** The `.txt` feeds keep their exact content and CRLF format.
- **No change to `jaillist`** — neither its table, its feed, its routes, nor its UI.
- **No DENY persistence.** Recording DENY (enforcements) as first-class stored rows is a
  separate, deferred decision, not part of this spec.

**An append-only per-block table was considered, rejected, and then REVERSED by operator decision
— the history of the decision is recorded here deliberately, not deleted.** The earlier version of
this spec rejected one-row-per-block on the grounds that duplicate labels for one host add no new
training signal while inflating one class, and that a parallel table would be a second source of
truth that could drift from what the firewall blocks (the deletes at
`app/routes/blacklist.py:135-138` and `:175-178`, the upstream prune at
`app/services/upstream_blacklist.py:194-198`, and the flat `GET /entries` shape at
`app/routes/blacklist.py:49-55` all govern the single `blacklist_entries` row). **The operator has
now overruled that decision, in their own words: the dataset for training must not collapse into
one row per domain, while the consumer device's list must not contain duplicates.** The reason the
rejection was wrong is concrete: the operator needs the per-block URL history — `video/123` and
`other` on the same host are different training examples, which is exactly the signal the
one-row-per-domain design threw away.

The second objection — the drifting second source of truth — is answered by the design rather than
dismissed. There is still exactly one enforcement source of truth, `blacklist_entries`, with its
`UNIQUE (kind, value)` intact, and the feed still reads only it; the events table is
**append-only history and never enforcement**, so it cannot drift from what the firewall blocks
because it does not claim to say what is blocked *now* — the projection does. The reconciliation
the old paragraph feared is exactly the delete/prune interaction specified above: deletes and
prunes touch the projection only, and the events survive as history. The rejection is recorded
here, in its original terms, so the reversal is auditable and the design is not silently revived
in a third direction later.


## Further Notes

- **Prior art for the field naming, and the schema caveat:** `url_patterns` carries unused
  `name`, `category`, and `notes` columns that are NULL for every row. Note the asymmetry between
  declared and live schema so a reader who greps the code is not misled: the table's
  `CREATE TABLE IF NOT EXISTS` declares only `pattern`, `pattern_type`, `created_at`, and
  `updated_at`, while the live table on disk has the three metadata columns appended after them —
  the shape a later out-of-band `ALTER TABLE ADD COLUMN` leaves behind. The columns genuinely
  exist on any database that has been migrated; they are simply not in the create statement. They
  are also entirely unwired: the pattern create, update, and bulk routes insert only
  `pattern` / `pattern_type`, and the update handler accepts only those two fields, so nothing in
  the API can read or write the three columns. The codebase anticipated operator-authored pattern
  metadata and never built the workflow for it; this feature extends that same intention to
  blacklist entries, which is why the naming here (`url`, `category`, `note`) is consistent with
  it. Unwiring the pattern columns themselves remains out of scope.
- **Why neutral language is a constraint, not a style choice:** the app must never assert a
  judgement the operator has not personally made. Describing a hit as "harmful", "malicious", or
  "confirmed" would put words in the operator's mouth and misrepresent an over-matching pattern
  hit as a verified finding. Neutral framing ("matched a pattern", "candidate") keeps the
  recorded judgement attributable to the human who made it.
- **Why `category` is never sourced from the raw proxy documents:** the raw documents carry a
  `category` field, but the operator confirmed it is not reliable enough to use as a
  classification source. `category` in this feature is operator-authored free text only, and it
  is never populated from, or reconciled against, the proxy's own field.
- **The stated purpose is training data — with the trade-offs stated up front, relocated rather
  than removed.** The operator's purpose for this feature is stated directly: the blacklist is
  used as *training data* for the sites that must be blocked, and, by operator decision, that
  dataset is **one labelled row per block, not one row per domain**. That is why `url` is the FULL
  URL rather than just the host — a bare domain trains on a host, whereas the complete URL carries
  the path that led to the block, and three blocks of one host from three paths are three examples
  rather than one. It is also why `category` is free text: the label is the operator's judgement,
  recorded as-is. Three honesty caveats belong here rather than being left implicit:
  (a) **the events table grows unboundedly and will need a retention or archive story.** One row
  per block has no natural cap, and this spec does not add one; the table will grow for as long as
  the operator blocks things. A retention policy (age- or size-based pruning, or an export-and-
  archive step) is a real follow-up that this spec deliberately does not design — it is named here
  so the growth is a known accepted cost, not a surprise.
  (b) **the deduped feed is no longer a 1:1 view of the rows.** The device feed lists destinations
  and the dataset lists blocks, so counting feed lines no longer counts training rows, and a
  destination that is blocked five times contributes one line and five rows. This is the intended
  split, and it means the feed cannot be used to measure dataset size or vice versa — anyone
  reasoning about "how many things are blocked" from a feed line count is reading a different
  number from "how many labelled examples exist".
  (c) the signal is only as useful as its provenance, which is why populating `finding_id` from
  the Findings row action onto each event is part of the design and not an optional extra — without
  it the label has no anchor to the device and log line that produced it. The device feed is
  deliberately excluded from this purpose: it stays bare domain only, deduped, and only the
  management-side dataset grows.
