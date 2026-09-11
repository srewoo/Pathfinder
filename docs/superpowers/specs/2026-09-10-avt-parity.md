# Spec: AVT Parity Features

**Date:** 2026-09-10
**Source:** Comparative analysis of Pathfinder against `ai-virtual-tester-automation`
(AVT) — a server-side Node/Express service that generates Playwright code from
TestRail cases, executes it, and syncs results back to TestRail/ReportPortal.

## Background

Pathfinder is architecturally ahead of AVT (structured IR, locator ladder,
self-healing, safety policy, budget guards, multi-provider AI). AVT is wired
into the *organisation* — that is where the transferable value is. Seven gaps
were identified. This spec defines all seven.

## Global constraints

- **ADR-002 holds.** No backend service is introduced. Everything runs in the
  extension; network calls go directly from the browser to the user's chosen
  endpoint with the user's own credentials.
- **ADR-004 holds.** No provider-specific AI code outside `src/core/ai/`.
- TypeScript `strict: true`. No `any` — `unknown` + type guards.
- No file > 300 lines, no function > 50 lines (CLAUDE.md §1).
- Every new module ships unit tests under `test/unit/core/`.
- The IR remains the determinism boundary: an LLM may only produce IR, and
  everything downstream consumes validated IR.
- Generated artifacts must never contain silent `TODO`s. Anything that cannot
  be expressed is reported to the user as a `dropped` item, mirroring the
  existing `describeDropped` pattern in `src/core/ir/ir-bridge.ts`.

## F1 — Playwright code export

**Problem:** Pathfinder exports *results* (JUnit/JSON/HTML) but never exports
*tests*. Its tests cannot run in CI, cannot be code-reviewed, and do not
survive as artifacts.

**Requirement:** Deterministically transpile a validated `TestIR` into a
runnable `@playwright/test` spec file. No LLM involvement. The locator ladder
maps directly: `testid` → `getByTestId`, `semantic` → `getByRole`,
`structural` → `locator`. Assertion kinds that cannot be expressed statically
(`api_called`, `api_not_called`, `api_status`) are reported as dropped, never
emitted as comments.

**Acceptance:** For any IR that passes `TestIRSchema`, the emitter produces a
file that `tsc` accepts and `npx playwright test` runs; every step and
assertion is either emitted or listed in `dropped`.

## F2 — Vision-assisted self-healing

**Problem:** `test-executor.ts` captures a screenshot at the exact moment of
step failure and only attaches it to the report. All three healing strategies
are DOM/text-only, so an icon-only button or a canvas widget is unhealable.

**Requirement:** Add a fourth healing strategy that sends the failure
screenshot plus the step intent to the vision model and asks for a selector.
Runs last (most expensive). Only invoked when a screenshot is available, and
only when the cheaper tiers failed — mirroring AVT's cost control of attaching
the image only when an error is present.

**Acceptance:** `healStep` accepts an optional context carrying the screenshot;
with all DOM strategies stubbed to fail and a stubbed vision client returning a
valid selector, the step heals and records `method: 'visual'`.

## F3 — Data-driven execution

**Problem:** No parameterisation exists anywhere in `src/`. AVT drives the same
scenario over N spreadsheet rows.

**Requirement:** A `TestCase` may carry a `dataSet` (columns + rows, parsed
from pasted CSV). Executing such a test fans out to one result per row, with
`{{column}}` in step values resolved from that row. The existing
`resolveStepVariables` / `capturedValues` mechanism is reused — data columns
are seeded into `capturedValues` before the step walk. A data column name may
not collide with a captured variable name.

**Acceptance:** A 3-row dataset produces 3 `TestResult`s whose titles carry
the row index, each having typed that row's values.

## F4 — Test-management-system sync (TestRail)

**Problem:** Pathfinder has Slack/Jira/Linear formatters and webhooks but no
TMS. An enterprise QA org lives in TestRail.

**Requirement:** Import a TestRail run's cases as Pathfinder `TestCase`s
(title + steps), and push results back per case: status, elapsed, error
message, and the failure screenshot as an attachment. Basic auth with the
user's own TestRail email + API key, stored like every other credential.
Status mapping follows TestRail defaults: passed=1, blocked=2, untested=3,
retest=4, failed=5.

**Acceptance:** Against a stubbed `fetch`, importing a run yields TestCases and
pushing results issues one `add_result_for_case` per test plus one
`add_attachment_to_result` per failure with a screenshot.

## F5 — Pre-acceptance stability gate

**Problem:** `flake-detector.ts` is post-hoc over historical runs. There is no
"run this newly generated test N times now and quarantine it if unstable"
gate — the trust problem with AI-generated tests.

**Requirement:** Run a test N times back-to-back (default 3), feed the results
to the existing `detectFlakes`, and return a verdict: `stable` (all passed),
`unstable` (mixed outcomes), or `failing` (all failed). An unstable test is
marked quarantined and excluded from suite runs unless explicitly included.

**Acceptance:** Given a stubbed executor returning pass/fail/pass, the gate
returns `unstable` and sets `quarantined: true`.

## F6 — Resume from last good step

**Problem:** Debugging step 28 of a 30-step scenario means replaying all 27
preceding steps. Pathfinder has resume for exploration and for background jobs,
but not for test execution.

**Requirement:** `ExecutionOptions.startFromStep` skips steps below that order,
recording them as `skipped` rather than pretending they passed, and navigates
to the test's `startUrl` first so the run begins from a defined state. The
results UI offers "resume from here" on the first failing step.

**Acceptance:** With `startFromStep: 3`, steps 0–2 appear as `skipped` and the
runner's first real dispatch is step 3.

## F7 — Hashed class-name guard

**Problem:** Nothing in `prompt-templates.ts` or the healing modules rejects
CSS-in-JS build hashes. The selector ladder ends at `.unique-class`, so the
model happily picks `.sc-1e593sq-0.beZfZu`, which changes on every deploy — a
silent, permanent self-healing tax. `locator.ts:34` already *documents* this
requirement for fingerprint attributes but nothing enforces it.

**Requirement:** A deterministic `isHashedClassName` predicate covering
styled-components (`sc-<hash>` and its sibling hash), emotion/JSS
(`css-1x2y3z`), CSS-modules (`Button_root__a1b2c`), and generic
high-entropy tokens. Hash-only selectors are filtered out of every generated
selector candidate list, treated as a testability gap, and named explicitly in
the prompt guidance.

**Acceptance:** `isHashedClassName` classifies a documented corpus of real and
counter-example class names correctly, and a candidate list containing only
hashed-class selectors comes back empty.
