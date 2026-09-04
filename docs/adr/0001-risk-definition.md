# ADR 0001 — Risk Definition

**Status:** Accepted
**Date:** 2026-09-04

## Context

uNetWatch's purpose is to monitor user internet behaviour related to prohibited sites. We need a precise definition of what counts as a *risk* so that findings, analytics, and dashboards report the same thing. The proxy records an `action` per request (`ALLOW` / `DENY`; `FLAG` is absent from our data). Historically the analytics layer treated `DENY`/`FLAG` as "blocked" and counted them among risk metrics, which conflates "the proxy already stopped it" with "the user actually reached a prohibited site".

## Decision

**Risk = a request whose URL matched a block pattern, with proxy action `ALLOW`, and that is not whitelisted.**

- `DENY` is **not** a risk — the proxy enforced the policy; the request was handled. Denied requests are reported separately as **"Enforcements (handled)"**.
- Whitelisted URLs are fully excluded from Findings and risk counts; they remain visible in the raw stream (Query).
- `FLAG` is ignored (absent from the data); risk is effectively ALLOW-only.
- **Findings** = risk rows only. The persistence pipeline already gates on `actions=("ALLOW",)` + whitelist exclusion (`result_processor.apply_filters`); this ADR makes that the canonical, labeled definition across all surfaces.

## Consequences

- Analytics endpoints and Dashboard cards must count risk as ALLOW pattern-matches only, and report DENY under an "enforcements" framing.
- Findings already match this definition; no persistence change needed.
- The raw stream (Query) remains the place to see every action including DENY and whitelisted rows.
