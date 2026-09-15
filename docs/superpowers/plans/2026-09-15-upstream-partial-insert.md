# Upstream partial insert — tolerant parsing + observability

## Context
uNetWatch upstream sync (blacklist + jaillist) drops valid-looking feed lines. Diagnosis (tests/test_upstream_partial_repro.py, green, uncommitted): hosts-style `0.0.0.0 host` and `evil.com # inline` lines land in errors[]; pre-existing rows count as skipped via INSERT OR IGNORE; no per-line logging. Partial insert is by-design behavior against feed formats the parser doesn't support.

## Global Constraints
- Backend only: app/services/upstream_blacklist.py (parse_upstream_body), app/services/blacklist.py only if needed, tests. Jaillist shares parse_upstream_body — keep compatible (bare IPs, :port strip, IPv6 canonical, reject hostname/URL/CIDR per app/services/jaillist.py).
- No new endpoints; sync return dict shape unchanged ({ok,added,skipped,errors,fetched}); status shape unchanged.
- Verification: pytest tests/test_upstream_blacklist.py tests/test_upstream_jaillist.py tests/test_upstream_partial_repro.py, then full pytest -q; admin-ui untouched (no frontend build needed).
- No new deps. Follow existing patterns (_run_sync seam, monkeypatched _fetch_text, db_path fixture, get_settings.cache_clear).
- Commit per task. No subagents; never spawn reviewers (review arrives separately).
- Ruling authority: this plan; conflicts resolved against the bucket table in tests/test_upstream_partial_repro.py.

## Task 1 — Tolerant upstream line parsing
Files: app/services/upstream_blacklist.py (parse_upstream_body), app/services/blacklist.py only if needed, tests/test_upstream_blacklist.py, tests/test_upstream_partial_repro.py.
Change:
1. parse_upstream_body: strip inline comments (whitespace + `#` or `;` to EOL) before the normalizer; support hosts-file lines: exactly 2 whitespace-separated tokens with the first a valid IPv4 address (e.g. 0.0.0.0, 127.0.0.1) → use the second token. Lines with other spaces still go to the normalizer to reject (errors, never silent).
2. Still reject bare `localhost` and bare IPv6 into the blacklist (errors) — note why in a code comment.
3. Update tests/test_upstream_partial_repro.py expectations: hosts-style + inline-comment lines now added; assert new exact counts + exact DB rows; keep truly-invalid errors (localhost, ::1, multi-space garbage).
4. Add unit cases in tests/test_upstream_blacklist.py for parse_upstream_body (hosts line, inline `#`, inline `;`, full-line comment, blank).
Acceptance: repro test green with new counts; upstream blacklist + jaillist test files green; no jaillist regression.

## Task 2 — Sync observability + full verification
Files: app/services/upstream_blacklist.py (logging only), app/services/upstream_jaillist.py (logging only).
Change:
1. Per-sync summary log line (info or debug matching existing logger `unetwatch`): added/skipped/errors/fetched + feed name, plus first few error values at debug/warning without secrets. Keep existing top-level warning behavior for total failure.
2. Run FULL pytest -q; report tail. Repro + upstream files must be green.
3. Update the repro test docstring to reflect tolerant behavior.
Acceptance: full suite green; per-sync summary visible in logs; no behavior change beyond Task 1.
