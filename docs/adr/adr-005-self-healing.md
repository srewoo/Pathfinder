# ADR-005: Self-Healing Test Selectors Strategy

**Status**: Accepted
**Date**: 2026-03-01

## Context

CSS selectors break when UIs change (class renames, DOM restructuring, framework updates). A QA tool that requires manual selector maintenance loses its value proposition. pathfinder needs a strategy to automatically recover from broken selectors without requiring user intervention.

## Decision

Implement a **three-tier self-healing cascade**:

1. **Alternative selectors** (pre-generated): Multiple selectors for the same element are generated at planning time. On failure, try alternates first (zero AI cost).
2. **DOM similarity matching** (heuristic): Scan the live DOM for elements with similar text, ARIA label, or role to the failed target. Cosine-like comparison of element attributes (zero AI cost).
3. **AI selector regeneration** (fallback): Pass the failing selector + surrounding DOM context to the LLM and ask it to suggest working selectors (AI API cost, used only when tiers 1 and 2 fail).

Healed selectors are logged as `HealingAttempt` records in the `TestResult` for user visibility and debugging.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Three-tier cascade** | Escalates cost only when necessary, transparent audit trail | More code paths to maintain |
| AI-only healing | Simple implementation | High API cost on every failure, slow |
| Visual AI healing (screenshot + vision model) | Most robust to radical UI changes | Very expensive, requires vision model support, slow |
| No healing | Zero complexity | Tests break constantly, poor UX |
| Record-and-replay with stable IDs | Robust if app adds `data-testid` | Requires app instrumentation, pathfinder can't guarantee this |

## Consequences

- **Transparency**: Every healing attempt (method, original selector, healed selector, success) is stored and surfaced in the Results panel. Users can see exactly what pathfinder changed.
- **Cost control**: Tiers 1 and 2 are free. Tier 3 (AI) is only invoked when both fail, bounding unexpected API spend.
- **Not infallible**: If the target element is completely removed from the UI (not just re-styled), healing will fail gracefully and the test is marked `failed` with a clear error message and screenshot.
- **Healed selector persistence**: Healed selectors are not automatically written back to the execution plan. Users must confirm updates (planned future feature) to avoid silent plan drift.
