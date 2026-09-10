# ADR 0003 — Notion-Style Redesign

**Status:** Accepted
**Date:** 2026-09-10

## Context

The admin UI used a neobrutalist system (Archivo Black + Space Grotesk, paper `#F6F2E8`, ink `#0A0A0A`, hazard `#FF3B30`/`#FFD60A`, 2.5–3px borders, hard offset shadows, all-caps mono stamps). It was visually loud for a monitoring console operators stare at all day, and the hardcoded ink/paper hexes fought dark mode (20+ `dark:` overrides with contrast regressions).

## Decision

Adopt a Notion-style system on the existing stack (React + Vite + Tailwind v4, CSS-first tokens — no framework migration):

- **Type:** Inter for UI, JetBrains Mono for data only (IPs, URLs, timestamps, counts). Sentence case; `mono-label` (11px/600/0.06em/uppercase) reserved for field labels and table headers.
- **Color:** white `#FFFFFF` / ink `#37352F`, single blue accent `#2383E2` (dark: `#529CCA`), hairline `#E9E9E8` borders, soft `0 1px 3px` shadows, 6px radius. Semantic tones: success `#0F7B6C`, warning `#DFAB01`, danger `#EB5757`, info `#2383E2`. Warm-charcoal dark mode (`#191919`/`#202020`/`#2F2F2F`). Literal ink/paper/hazard hexes banned from components.
- **Motion:** 150ms ease-out, `scale(0.98)` press, shared `animate-in`/`fade-in` utilities; `prefers-reduced-motion` + `data-paused` tab-visibility gate preserved.
- **Charts:** ECharts fallbacks and Sankey `LAYER_COLORS` re-themed to the same tokens (single blue + gray + danger-red for high-risk only).
- **States:** every async view gets loading (skeleton), empty (`EmptyState` with action), and error (inline panel + retry, not toast-only) via shared primitives. Toast copy sentence-cased.

## Consequences

- All 24 component files converted className-only; no logic, layout, copy, or routing changes. `Sidebar` nav structure and `AppShell` shell unchanged.
- Deleted as dead after migration: `brutal-*`/`stamp`/`halftone`/`hazard-bar`/`grid-paper`/`grain`/`mesh`/`glass`/`spotlight` CSS aliases, `Toaster` null stub, unused `statToneBar` map (replaced by tone-tinted `StatCard` icon tile). `StatTone` prop API unchanged.
- Verification: `tsc` clean, `vite build` clean, `oxlint` clean (pre-existing fast-refresh warnings only), 184 pytest pass. Zero-grep gate on `0A0A0A|F6F2E8|FFD60A|FF3B30|brutal-|hazard-bar|font-display|border-[2.5px]|border-[3px]` in components.
- `CONTEXT.md` theme line updated to the Notion tokens.
