# Decision: Phase 2 (de-dup radar primitives into this driver) — declined for now

**Date:** 2026-06-21
**Status:** Decided — do NOT de-duplicate (keep the radar's copy and this driver's copy independent).

## Context

Phase 1 extracted the generic TradingView primitives into this repo
(`src/driver.ts`). The radar project's `scripts/sync-tv-watchlist.ts` still has
its own copies of the same primitives. Phase 2 was to have the radar IMPORT this
driver and delete its copies (DRY).

## What the scouting found

- The primitives are **byte-identical** between the two repos, with **one**
  intentional divergence: the radar's `readCurrentSymbols` throws on the scroll
  deadline in `--replace` mode (a stall-hardening guard); this driver's version
  always breaks (it has no replace concept). Easy to reconcile with an option.
- The real cost is the **cross-repo dependency**, not the divergence:
  - The radar is **ESM** (`type: module`); this repo is **CommonJS**. Interop
    needs reconciliation (exports map / build).
  - This repo has **no `exports` map and no build** — the radar would import from
    `~/tradingview-mcp/src/driver.ts` by absolute path.
  - Net result: the **production nightly would depend on this second repo's
    path/build**. If this repo moves or its build breaks, the nightly breaks.

## Decision & rationale

**Keep the duplication.** De-duping would trade a *non-problem* (stable,
byte-identical, rarely-changing primitives) for **real coupling on the most
important script** (the nightly TradingView sync). The reuse goal that motivated
the split is **already achieved** — this standalone MCP works on its own.

## When to revisit

Revisit ONLY if:
- The two copies start to **drift** and keeping them in sync becomes a real chore, OR
- A **third consumer** appears and the shared code genuinely needs one home.

If revisited, prefer the **clean route** (publish this driver as a built,
versioned package — `tsc` → `dist/`, proper `exports` — and have consumers depend
on the artifact), NOT a `file:`-path dependency hack into a production script.

## Maintenance note (until/unless de-duped)

The primitives live in **two** places. If a TradingView **selector** breaks, fix
it in BOTH:
- `~/tradingview-mcp/src/driver.ts` (this repo)
- `~/.gemini/antigravity/projects/smart-volume-radar/scripts/sync-tv-watchlist.ts`
