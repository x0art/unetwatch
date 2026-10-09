"""Derived "Domain Blacklist" feed, sanctioned from the URL blacklist.

The domain feed has NO upstream of its own. It is DERIVED: every distinct
host in ``blacklist_entries`` rows of ``kind='url'`` is collapsed to its
domain form and stored as ``(kind='domain', value=<domain>, source='sanction')``.
The public file is ``domains.txt`` in the blacklist directory (the shared
``_feed_path`` already yields this) and is served at
``/api/blacklist/domains.txt`` next to ``urls.txt`` / ``ips.txt``.

Reduction rule (chosen, deterministic, no third-party dependency)
------------------------------------------------------------------
"Domain" = the URL host exactly as normalised by
``blacklist.normalize_blacklist_value`` — i.e. the bare, lowercased FQDN with
protocol, userinfo, port, path, query and fragment stripped. No registrable-
domain / eTLD+1 logic is attempted: that would require a Public Suffix List
parser (a new dependency, against project convention), and a naive heuristic
would be wrong for e.g. ``evil.co.uk``. Because both a URL row and its
sanctioned domain row carry the same bare FQDN, a URL host is its own domain
catch: the derivation is honest and testable rather than inventing a
registrable domain. URL rows already normalise to the bare host on entry, so
in practice ``url_host_to_domain`` is the identity for stored rows; it is
still a pure, tested function so a future stricter rule can replace it in one
place.

Safety
------
Pruning only ever deletes ``kind='domain' AND source='sanction'`` rows, so
manual/finding/redirect/upstream rows of any kind are never touched. The prune
runs only when the URL read succeeded; if the read failed (exception) the
function returns ``ok=False`` and leaves both the rows and the feed untouched.
An empty URL set legitimately empties the derived feed (the URL rows ARE the
source of truth), so it is NOT treated as "missing data" — only a failed read
is.
"""

import logging

log = logging.getLogger("unetwatch")


def url_host_to_domain(host: str) -> str:
    """Collapse a stored URL host to its domain form.

    The chosen rule is the identity on the bare, lowercased FQDN that
    ``normalize_blacklist_value`` already produces for URL rows (see the module
    docstring). Pure and synchronous so it is trivially unit-testable.
    """
    return host.strip().lower()


async def _distinct_url_hosts(db) -> list[str]:
    """Distinct ``kind='url'`` host values, in stable order."""
    cursor = await db.execute(
        "SELECT DISTINCT value FROM blacklist_entries WHERE kind = 'url' ORDER BY value"
    )
    return [row[0] for row in await cursor.fetchall()]


async def _prune_stale_domains(db, keep: set[str]) -> list[str]:
    """Delete sanctioned domain rows not in ``keep``; return the stale values.

    Scoped to ``source='sanction'`` so derived-feed maintenance can never
    remove a hand-added or imported domain row.
    """
    cursor = await db.execute(
        "SELECT value FROM blacklist_entries"
        " WHERE kind = 'domain' AND source = 'sanction' ORDER BY value"
    )
    existing = [row[0] for row in await cursor.fetchall()]
    stale = sorted(v for v in existing if v not in keep)
    if stale:
        placeholders = ",".join("?" for _ in stale)
        await db.execute(
            "DELETE FROM blacklist_entries"
            " WHERE kind = 'domain' AND source = 'sanction'"
            f" AND value IN ({placeholders})",
            (*stale,),
        )
    return stale


async def sanction_domains(db) -> dict:
    """Regenerate the derived domain feed from the current URL rows.

    Reads every distinct ``kind='url'`` host, reduces each to its domain
    (``url_host_to_domain``), inserts missing ``(kind='domain',
    source='sanction')`` rows, prunes sanctioned domains no longer derivable,
    and rewrites ``domains.txt`` when anything changed. Idempotent: a second
    run with an unchanged URL set adds nothing and prunes nothing.

    Returns ``{"ok", "scanned", "added", "skipped", "pruned"}``. ``ok`` is
    ``False`` only when the URL read failed — in that case nothing is written
    or pruned.
    """
    from app.services.feeds import sync_regenerate

    try:
        hosts = await _distinct_url_hosts(db)
    except Exception as e:  # failed read: never prune on missing data
        log.warning("domain sanction: reading url rows failed: %s", e)
        return {"ok": False, "scanned": 0, "added": 0, "skipped": 0, "pruned": 0}

    want = {url_host_to_domain(h) for h in hosts}
    scanned = len(hosts)

    # Existing sanctioned domains — lets us classify add vs skip exactly and
    # keeps the operation idempotent.
    cursor = await db.execute(
        "SELECT value FROM blacklist_entries WHERE kind = 'domain' AND source = 'sanction'"
    )
    have = {row[0] for row in await cursor.fetchall()}

    added = 0
    for domain in sorted(want - have):
        cursor = await db.execute(
            "INSERT OR IGNORE INTO blacklist_entries (kind, value, source)"
            " VALUES ('domain', ?, 'sanction')",
            (domain,),
        )
        if cursor.rowcount:
            added += 1
    skipped = len(want & have)

    pruned = len(await _prune_stale_domains(db, want))

    await db.commit()

    if added or pruned:
        # Keep the on-disk domains.txt in step with the DB.
        await sync_regenerate(db, ("domain",))

    return {"ok": True, "scanned": scanned, "added": added, "skipped": skipped, "pruned": pruned}
