# ADR 0006 — Single Source Risk Model

**Status:** Accepted
**Date:** 2026-09-21

## Context

The graded host risk model lived twice. The backend owned it in `app/routes/hosts.py` — fourteen named constants plus `_risk_from_shares` — and the frontend carried a hand-maintained numeric mirror in `admin-ui/src/api.ts` (`hostRiskFromShares` and a second copy of the same constants). The two were kept in lockstep by hand across a language seam: a change to any threshold had to be repeated in TypeScript, and nothing enforced the repetition.

Only the backend copy carried the reasoning. `hosts.py` states in comments why `ATTEMPT_CAP` must stay below the minimum possible reach score (`REACH_BASE + REACH_PER_HIT_WEIGHT`), so a reach always dominates intent evidence, and it marks the thresholds `PROVISIONAL` because they were calibrated against an effectively empty database (2 findings rows, 1 distinct base_url, 0 blacklist entries — unmeasurable). The frontend copy carried none of that. An operator reading a score the client computed could not see which branch produced it or why any constant had its value.

They had already diverged. The mirror's findings rung hardcoded `enforcements = 0`, under a comment asserting the findings table holds ALLOW rows only. That comment was stale: a later change made the poll persist DENY rows as ATTEMPT evidence. The same rung also passed `blacklistedDistinct: 0`, silently forfeiting the entire breadth term — up to `DISTINCT_DEST_WEIGHT × DISTINCT_DEST_SATURATION` points. A host graded from persisted findings scored lower than the same evidence graded by the backend, and nothing in the product said so.

No test could reach the mirror. There is no frontend test runner: `admin-ui/package.json` has no `test` script, and neither vitest nor jest is a dependency (see `CONTEXT.md` §Conventions). A rule implemented on that side was untestable by construction — the divergence above was not a slip, it was the only outcome available.

The project had already shipped the bug class this structure hides. Commit `86b4a5e` records that `GET /api/hosts/{ip}` was never registered and fell through to the SPA catch-all, returning HTML with HTTP 200. The client-side fallback ladder masked it: `getHostProfile` caught the parse failure, fell back to a live ES query, then to findings aggregation, then to the wireframe, so the Host Inspector always rendered a plausible profile and a dead route looked like an empty one.

## Decision

**The graded host risk model has exactly one implementation, in the backend.**

- `GET /api/hosts/{ip}` is the single source of a risk score. It grades the live Elasticsearch block-pattern window when available and falls back to the persisted findings table when it is not, so the answer comes from one place regardless of which store replied. `_risk_from_shares` is called in both branches and nowhere else.
- The frontend renders what it is handed, or an explicit unavailable state. It does not own the rule, its constants, or its operator-facing reason text. `hostRiskFromShares` and the mirrored constants are deleted.
- The client-side profile ladder no longer computes. Its two fallback rungs supply identity, byte totals and raw counts only, and their risk fields are the explicit unavailable state (`reason: "risk_not_computed_client_side"`). When no source can answer, the ladder throws `HOST_PROFILE_LOOKUP_FAILED` rather than inventing a clean-looking host.
- The response states which store answered. The existing `sources` block names the live window versus the persisted ledger, so a score's provenance is never implied.

## Consequences

- Recalibrating the `PROVISIONAL` thresholds is now a one-file, one-language edit: fourteen constants in `app/routes/hosts.py` and nowhere else. No TypeScript constant needs to move with them.
- **A real cost.** When neither store can answer, the host surfaces now show an explicit unavailable state instead of a client-computed number. The operator sees "not measured" more often than before. This is deliberate — that state is truthful and the previous number was not — but it is a behaviour change, and a host that was previously given a fabricated LOW now reads as unmeasured.
- The rule became testable: the model now lives where the test suite can reach it. `tests/test_hosts.py` holds 24 tests, 16 of them covering the graded model, the risk reason and the persisted-findings fallback — including `test_host_profile_fallback_counts_real_enforcements_not_zero` (pinning the input the mirror hardcoded to 0), `test_host_profile_fallback_counts_real_distinct_blacklisted_dests` (pinning the breadth term the mirror forfeited) and `test_host_profile_fallback_grades_a_dedup_collapsed_population` (pinning that a dedup-collapsed population still grades rather than reading as no-traffic). None of these could exist against the mirror.
- **The mirror must NOT be reintroduced for resilience.** The temptation is real: "what if the backend is down?" The answer is that a client-side copy of the rule is exactly what diverged — it forfeited the breadth term, zeroed the enforcement evidence, and drifted from its backend twin in the same release that shipped it. If the endpoint is unreachable, the honest UI is the unavailable state, not a second implementation. A second implementation is a second answer, and two answers that disagree are worse than one honest "not measured".
