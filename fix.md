# fix.md — Pathfinder Architecture Remediation Plan

**Status:** Proposed
**Scope:** Chrome extension only. `cli/` and `MCP/` are removed as deliverables.
**Baseline:** v1.4 — `src/` is 33,975 lines of TS/TSX across 8 top-level modules.

---

## 0. Objective & Non-Goals

### Objective

Reduce Pathfinder to **one product, one runtime, one execution path**: a Chrome
extension that autonomously explores a web app, generates a deterministic test
suite, executes it, and reports results — with a measurable false-positive rate
and a safety model that cannot mutate production by accident.

### Non-Goals (explicitly dropped)

| Dropped | Why |
|---|---|
| `cli/` package | Duplicate engine built on `playwright-core`. Not the product. |
| `MCP/` package | Second duplicate engine + MySQL harness. Not the product. |
| CI-runner / GitHub annotations | Requires a headless runtime the extension cannot provide. Replaced by export artifacts (§11). |
| Playwright driver | No non-Chrome target remains. CDP only. |

### Guiding Constraints

1. **AI proposes, the engine verifies.** No probabilistic output ever reaches a
   live action without deterministic validation. (Ref: `CLAUDE.md` §8.0.)
2. **The MV3 service worker will be evicted mid-run.** Every long-running
   operation must be resumable, not merely retryable.
3. **The user's production data is not a test fixture.** Safety is enforced at
   the driver layer, where no caller can bypass it.
4. **File budget:** no file > 300 lines, no function > 50. Currently violated by
   at least 8 files (`dom-actions.ts` 1464, `explorer-agent.ts` 1392,
   `service-worker.ts` 1105, `content-script.ts` 1034, `crawler.ts` 957,
   `flow-learner.ts` 922, `test-importer.ts` 846, `test-executor.ts` 816).

---

## 1. Delete `cli/` and `MCP/`

### Current state

Both packages vendor their own `node_modules` (including `playwright-core`,
`typescript`, `onnxruntime-web`) and implement a parallel version of the
crawl → generate → execute pipeline. Together they are **124 of 349 tracked
files** in the repo.

Verified: **`src/` imports nothing from either package.** The only coupling is
three test files.

### Steps

```bash
git rm -r --cached cli MCP
rm -rf cli MCP
rm -rf test/unit/cli            # config.test.ts, github-reporter.test.ts
```

Then:

1. Remove `MCP/*` entries from `.gitignore` (lines ~59-67) and the
   `!cli/templates/*.zip` negation (line ~23).
2. Grep for orphaned docs: `docs/`, `README.md`, `SKILLS.md` references to CLI
   or MCP usage must be deleted, not left as instructions for a package that no
   longer exists.
3. Confirm `npm run typecheck && npm run test:run` is green — no `src/` import
   should break.

### What is genuinely lost

CI gating. Pathfinder can no longer fail a pipeline. **Accept this** — it was
already aspirational, since the extension and the CLI had divergent engines and
therefore divergent results. §11 replaces it with export artifacts that a CI job
can consume, without maintaining a second engine to produce them.

---

## 2. Portable core, one driver port

### Problem

The extension's business logic imports `chrome.*` directly throughout, which
makes the core untestable without a browser and was the original motivation for
the CLI fork.

### Target structure

```
src/
  core/          ← pure TS. MUST NOT import chrome.* — enforced by lint rule
    driver.ts    ← the Driver interface (port)
    ...
  drivers/
    cdp-driver.ts    ← chrome.debugger implementation
    fake-driver.ts   ← in-memory, for unit tests
  extension/
    background/  ← job pump only
    sidepanel/   ← UI
```

```ts
export interface Driver {
  navigate(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  resolve(locator: Locator): Promise<ElementHandle | null>;
  click(el: ElementHandle): Promise<void>;
  type(el: ElementHandle, text: string): Promise<void>;
  waitFor(cond: Actionability, timeoutMs: number): Promise<void>;
  screenshot(): Promise<Blob>;
  onRequest(cb: (r: NetworkRequest) => RequestVerdict): void;
}
```

`fake-driver.ts` is the point of the exercise: it makes the planner, the
executor, the graph, and the healing logic unit-testable with no browser, no
tab, and no API key.

**Enforcement:** ESLint `no-restricted-globals` / `no-restricted-imports`
banning `chrome` inside `src/core/**`. Without the lint rule this boundary
erodes within a month.

---

## 3. One execution substrate (CDP)

### Problem

Two implementations of the same capability:

- `src/content/dom-actions.ts` — 1464 lines, synthetic DOM events
- `src/core/cdp/cdp-action-runner.ts` — 447 lines, real input events

Bugs fixed in one persist in the other, and observed behaviour depends on which
path a given run happened to take.

### Decision: CDP wins

| Capability | Content script | CDP |
|---|---|---|
| Trusted input events | ✗ synthetic `dispatchEvent` | ✓ `Input.dispatchMouseEvent` |
| Cross-origin iframes | ✗ needs `all_frames` injection | ✓ native |
| Shadow DOM | partial | ✓ native |
| Survives navigation | ✗ re-injection race | ✓ session persists |
| Network interception | ✗ | ✓ `Fetch.enable` |
| Tracing / screenshots | ✗ | ✓ built in |

### Steps

1. Port every action in `dom-actions.ts` to `cdp-action-runner.ts`, one action
   at a time, each with a `fake-driver` unit test.
2. Shrink `content-script.ts` (1034 lines) to only what CDP cannot do:
   - DOM mutation observation (`dom-observer.ts`)
   - page structure extraction (`element-detector.ts`)
   - SPA route-change signals
3. Delete `dom-actions.ts`. Target: content script under 300 lines total.
4. Drop `all_frames: true` from the manifest once frame traversal is CDP-side.

---

## 4. Durable job state machine

### Problem

`service-worker.ts` (1105 lines) orchestrates multi-minute crawls as in-memory
`async` loops. MV3 evicts the worker after ~30s idle — hence the `alarms`
permission — so eviction mid-crawl loses the run.

### Target

Model a crawl as a persisted job whose worker is disposable.

```ts
interface Job {
  id: string;
  kind: 'crawl' | 'explore' | 'generate' | 'execute';
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed';
  cursor: number;              // next step index
  frontier: QueuedTarget[];    // BFS queue — persisted, not in-memory
  visited: string[];
  budget: { pagesLeft: number; msLeft: number; tokensLeft: number };
  updatedAt: number;
}
```

The worker becomes a pump with exactly one responsibility:

```
wake → load job → execute ONE step → commit transactionally → re-arm alarm → exit
```

### Rules

- Every step is **idempotent** — re-running after a crash mid-commit is safe.
- Frontier and visited set live in IndexedDB, never only in a closure.
- Commit is one IndexedDB transaction: step result + cursor advance together.
  Partial commits are the failure mode that corrupts a resumed run.

### Free consequences

Pause/resume, mid-run inspection in the side panel, crash forensics, and
progress that survives a browser restart — all as properties of the model rather
than features to build.

`explorer-agent.ts` (1392 lines, ~20 imports) decomposes here into one handler
per step type. That is the natural fix for the god object; do not attempt to
split it before this refactor.

---

## 5. Locator strategy — demote self-healing to a fallback

### Problem

`core/healing/` is four modules (`self-healer`, `dom-similarity`,
`selector-generator`, `attribute-selector`) that exist because locators are
guessed from raw DOM structure and are therefore brittle by construction.
Healing treats the symptom.

### Target: a three-tier resolution ladder

```ts
type Locator =
  | { kind: 'testid'; value: string }
  | { kind: 'semantic'; role: AriaRole; name: string; scope?: Locator }
  | { kind: 'structural'; css: string; fingerprint: DomFingerprint };
```

1. **`data-testid`** — preferred. When absent, emit a
   **Testability Report** naming the pages and elements that lack stable IDs.
   Telling the team how to make their app testable is a legitimate product
   output, not a failure.
2. **Semantic** — `role + accessible name + scoping ancestor`. Survives CSS
   refactors, class renames, and DOM re-nesting, which are precisely the changes
   that break CSS selectors.
3. **Structural** — CSS + DOM fingerprint, healed via `dom-similarity` only when
   tiers 1 and 2 miss.

### Non-negotiable rules

- Locators are stored as **structured data**, never as serialized strings.
- **Every heal is surfaced in the report** with before/after. Silent healing is
  how a test keeps passing while asserting nothing — the worst failure mode this
  product has.
- A test that healed ≥ 2 locators in one run is flagged `NEEDS_REVIEW`, not
  `PASS`.

---

## 6. Typed test IR + hard determinism boundary

### Problem

LLM output currently flows toward execution with validation applied
inconsistently (`validators.ts`, `isAgentActionsShape`). Reruns are not
guaranteed reproducible, and test changes are not reviewable.

### Target

The **only** artifact an LLM may produce is a versioned test IR.

```ts
const TestIR = z.object({
  irVersion: z.literal('1'),
  id: z.string(),
  name: z.string(),
  provenance: {
    source: z.enum(['exploration', 'documentation', 'hybrid', 'user']),
    promptVersion: z.string(),
    model: z.string(),
    generatedAt: z.number(),
  },
  steps: z.array(Step),
  assertions: z.array(Assertion),
});
```

### Boundary rules

- The executor accepts **only** validated IR and contains **zero** LLM calls.
  Enforce with a lint rule banning `core/ai/**` imports inside
  `core/executor/**`.
- IR is persisted and **exportable as JSON** — diffable, git-committable, and
  hand-editable. A generated test suite becomes a reviewable artifact.
- Exploration follows the same rule: the AI ranks candidate actions, and the
  ranked list is **intersected with the actually-scanned element set** before
  anything executes. A hallucinated selector is dropped, not attempted.
- `promptVersion` is recorded per test, so §10's benchmark can attribute a
  regression to a specific prompt change.

---

## 7. Side effects and permissions — enforced at the driver

### Problem

`submitForms` against a live app using the user's real session cookies is a
one-incident-ends-adoption risk. The manifest requests
`<all_urls>` + `debugger` + `cookies` — a combination that also blocks Web Store
review.

### Controls, all implemented in `cdp-driver.ts` so no caller can bypass them

1. **Origin allowlist per project.** `Fetch.enable` aborts any request to an
   origin outside the project's declared list. Prevents accidental crawls into
   production or third-party admin panels.
2. **Method gate.** `POST`/`PUT`/`PATCH`/`DELETE` are blocked unless the run is
   explicitly flagged mutating **and** the target origin is allowlisted.
3. **Isolated session.** Log in through the existing auth preset
   (`executor/auth-manager.ts`) into a dedicated context. **Drop the `cookies`
   permission entirely** — never borrow the user's live session.
4. **Mutation ledger.** Every permitted mutating request is recorded, so a run
   ends with an exact statement of what it changed.
5. **Scoped host permissions.** Replace `<all_urls>` with
   `optional_host_permissions`, requested at runtime per project. This is also
   what users want: consent to test *their* app, not every site they visit.

### Target manifest delta

```diff
   "permissions": [
     "activeTab", "sidePanel", "storage", "scripting",
     "tabs", "alarms", "debugger",
-    "cookies"
   ],
-  "host_permissions": ["<all_urls>"],
+  "optional_host_permissions": ["http://*/*", "https://*/*"],
```

---

## 8. Actionability preconditions replace ad-hoc waits

### Problem

`waitForNetworkIdle` / `waitForDomSettle` are heuristics applied at call sites
that remember to call them. This is the dominant source of E2E flake.

### Target

The driver asserts a precondition set before **every** action, auto-retrying
until timeout:

| Check | Meaning |
|---|---|
| attached | node is in the document |
| visible | non-empty box, not `visibility:hidden` / `display:none` |
| stable | bounding box unchanged across 2 animation frames |
| enabled | not `disabled`, not `aria-disabled` |
| receives events | hit-test at the click point resolves to this node or a descendant |

Solved once in the driver, no prompt and no test author ever writes a wait
again. Delete explicit sleeps from IR steps entirely — if a step needs a wait,
that is a driver bug.

---

## 9. Spend LLM tokens only on judgement

### Deterministic (zero tokens)

- Crawling, link checking, redirect and 4xx/5xx detection
- Accessibility audit (`analysis/accessibility-audit.ts`)
- **Constraint-derived negative tests** — `required`, `minLength`, `maxLength`,
  `pattern`, `type`, and `<option>` sets each mechanically imply boundary and
  invalid-input cases. `constraint-test-generator.ts` (471 lines) should need
  **no** tokens.
- API contract validation against a parsed OpenAPI spec
- Local embeddings — already correct via Transformers.js, keep as is

### LLM-worthy

- Ranking which elements are likely to reveal new functionality
- Naming and prioritising flows; inferring semantic intent
- Writing assertions about *meaning* rather than structure

### Routing

Cheap model for ranking and classification; the expensive model only for
generation. `budget-guard.ts` and `token-tracker.ts` already exist — enforce a
hard per-run ceiling that **fails the run loudly** rather than silently
degrading coverage.

---

## 10. Build the benchmark first

**This is the highest-priority item in the document.** A tool whose job is
finding bugs currently has no way to know whether it works.

### Fixture suite

- ~20 small apps plus deliberately broken forks of real OSS apps
- A manifest of injected defects per fixture: broken link, validation bypass,
  500 on submit, a11y violation, dead button, state that fails to persist
- Fixtures served locally so runs are hermetic and free

### Scored metrics, per run, in CI

| Metric | Why it matters |
|---|---|
| **Recall** of injected defects | Is it actually finding bugs? |
| **False-positive rate** | The metric that decides adoption. A noisy autonomous QA tool gets switched off. |
| **Cost** (tokens, USD) per app | Unit economics |
| **Wall-clock** per app | Usability |
| **Flake rate** across 3 identical reruns | Must be ~0 given §6 and §8 |

### Consequence

No prompt change in `prompt-versions.ts` merges without a benchmark delta. Until
this exists, every claim about §5, §6, §8, and §9 is unfalsifiable.

---

## 11. Export artifacts replace the CLI

The CLI is gone, so the extension must be the source of shareable output:

- **Test IR** as JSON (§6) — committable, reviewable, re-importable
- **Results** as JUnit XML + JSON — a CI job can consume these from a repo
  without Pathfinder running in CI
- **Run trace** — screenshots, network log, mutation ledger, heal log, bundled
  per run for debugging a failure after the fact
- **Testability report** (§5) — pages and elements lacking stable IDs
- Existing knowledge/exploration export (`storage/*-export.ts`) is kept and
  moved onto the same versioned-schema discipline as §12

Scheduled runs via `chrome.alarms` cover the recurring-regression use case that
motivated the CLI, for anyone willing to leave a browser open.

---

## 12. Storage: one versioned schema with migrations

### Problem

`storage/schemas.ts` is 741 lines, and state is split across IndexedDB
(`indexed-db.ts`, 602 lines) and `chrome.storage` (`chrome-storage.ts`) with no
stated rule for which holds what.

### Target

- **Rule:** `chrome.storage` holds settings and secrets only. Every entity
  (graph, jobs, IR, results, knowledge chunks) lives in IndexedDB.
- One `schemaVersion` with an explicit forward-migration chain. The interaction
  graph shape *will* change, and users will have existing data.
- Zod validation at every read boundary — a corrupt record must fail loudly at
  load, not surface as a mystery `undefined` three modules later.
- Split `schemas.ts` per domain: `graph.ts`, `ir.ts`, `results.ts`,
  `knowledge.ts`, `jobs.ts`.

---

## 13. Naming and decomposition

| Current | Problem | Rename to |
|---|---|---|
| `core/explorer/agent-explorer.ts` | Anagram-adjacent to its sibling; costs a reader an hour every few months | `core/explorer/action-ranker.ts` |
| `core/explorer/explorer-agent.ts` | 1392 lines, ~20 imports, god object | `core/explorer/crawl-steps/` (one handler per step, via §4) |

Files over budget, with their remediation section:

| File | Lines | Fixed by |
|---|---|---|
| `content/dom-actions.ts` | 1464 | §3 — deleted |
| `core/explorer/explorer-agent.ts` | 1392 | §4 — decomposed into step handlers |
| `background/service-worker.ts` | 1105 | §4 — becomes a job pump |
| `content/content-script.ts` | 1034 | §3 — observation only |
| `core/knowledge/crawler.ts` | 957 | §4 — crawl steps |
| `core/flow/flow-learner.ts` | 922 | §6 — split generate / validate / persist |
| `core/test-gen/test-importer.ts` | 846 | §6 — one IR parser replaces format-specific branches |
| `core/executor/test-executor.ts` | 816 | §8 — waits move to driver; §6 removes AI paths |
| `storage/schemas.ts` | 741 | §12 — split per domain |

---

## 14. Phasing

Ordered so each phase is independently shippable and de-risks the next.

### Phase 0 — Clear the deck (small) — ✅ DONE

Branch `refactor/phase0-remove-cli-mcp`.

- §1 deleted `cli/`, `MCP/`, `test/unit/cli/` (423 MB, 124 tracked files)
- Cleaned `.gitignore`: dropped `!cli/templates/*.zip` and the 8-line
  `MCP/*` runtime-data block
- §13 renamed `agent-explorer.ts` → `action-ranker.ts` (+ logger tag and its 2
  importers). The `explorer-agent.ts` split stays deferred to Phase 3 per §4.
- **Exit met:** typecheck clean; 56 files / 559 tests pass (baseline was
  58 / 584 — the −2 files / −25 tests are exactly the removed `test/unit/cli`);
  `vite build` green.

**Deviations from the written steps:**

- No doc cleanup was needed. `docs/` holds only extension ADRs, and README's
  Playwright mentions are competitive comparisons, not CLI usage instructions.
- `MCP/.env` was gitignored and held a live `AI_API_KEY` and `MYSQL_PASSWORD`.
  Backed up outside the repo before deletion rather than destroyed.

**Pre-existing breakage found, not fixed (out of Phase 0 scope):**
`package.json` `test:e2e` runs `playwright test test/e2e/`, but
`@playwright/test` is not a root dependency — this script has been broken
independently of this work. `test/e2e/` tests the *extension* via Playwright,
which is legitimate and unrelated to the deleted engines; §16.1's "no
`playwright-core` anywhere" refers to the duplicate engines only. Decide
separately whether to add the dev dependency or drop `test/e2e/`.

### Phase 1 — Make correctness measurable — ✅ DONE (built after Phases 2–5)

Built out of order, at the point where it became clear the remaining work would
change what tests get generated and how results are judged — exactly the class of
change that needs a before/after number.

- §10 fixture suite + scoring harness + CI gate: `test/benchmark/`
- `npm run benchmark`; runs in the normal `vitest run` sweep too

**Design.** Fixtures come in PAIRS — a `correct` variant and a `broken` variant
with exactly one injected defect. The same detector set runs against both, so:

- catching the defect on `broken` = **recall**
- any finding at all on `correct` = **false positive**

Pairing is what makes the false-positive rate measurable. A broken-only suite can
only report recall, and recall alone is the metric a noisy tool optimises while
becoming useless.

**First baseline (v1.4 + Phases 2–5, deterministic detectors):**

```
Fixtures:            7
Recall:              100%  (7 caught, 0 missed)
False positives:     0  (rate 0%)
Precision:           100%
Tokens:              0
Wall-clock:          373ms
Flake:               0% across 3 identical runs
```

Defect classes covered: validation bypass (×2 — malformed input and a maxlength
boundary), 500-on-submit, dead control, state not persisted, missing accessible
name, broken link.

**The harness caught a real problem on its first run** — a false positive traced
to the `state-not-persisted` fixture accidentally containing a *second* defect (an
unlabelled input). The fixture was at fault, not the detector, which is precisely
the kind of error a benchmark exists to surface before it becomes a wrong number.

**Fidelity, stated so the number is not over-read.** `test/benchmark/jsdom-driver.ts`
evaluates the *same* injected page scripts the CDP driver sends to a real browser,
so the production locator ladder, accessible-name computation and assertion
semantics are genuinely exercised. What it cannot exercise:

- trusted input events and real layout (jsdom has neither, so geometry checks are
  relaxed — the harness cannot catch layout-caused flake)
- LLM-generated tests, which need an API key; the token/cost columns read 0
- multi-page crawling; each fixture is a single page

**Gate:** zero false positives (zero-tolerance — these are mechanical checks
against ground truth, so a spurious finding is a detector bug), recall ≥ 80%,
zero flake. The scoring logic has its own 23 unit tests, because a scoring bug
that flatters the tool is worse than no benchmark.

**New product code this required:** `src/core/analysis/deterministic-detectors.ts`
— six zero-token detectors, each returning evidence alongside its message. They
take a `Driver`, so the code that produces the benchmark number is the code that
ships.

### Phase 2 — Substrate and safety — ✅ DONE

| Item | Status | Landed as |
|---|---|---|
| §2 Driver port | ✅ | `src/core/driver.ts` — 20-method port, zero `chrome.*` |
| §2 `fake-driver` | ✅ | `src/drivers/fake-driver.ts` — real state machine (typing mutates values, clicks fire handlers, animation simulated so `stable` is genuinely exercised) |
| §2 lint enforcement | ✅ | `.eslintrc.cjs` — **created from scratch**; there was no ESLint config at all, so `npm run lint` had never run |
| §8 actionability | ✅ | `src/core/actionability.ts` (pure decision logic) + driver polling; per-action required-check sets |
| §7 origin allowlist + method gate | ✅ | `src/core/safety/origin-policy.ts`, installed via `Fetch.enable` in `src/drivers/cdp-safety.ts` |
| §7 mutation ledger | ✅ | `src/core/safety/mutation-ledger.ts` — bounded, query strings stripped |
| §7 drop `cookies` | ✅ | `Network.setCookie` replaces `chrome.cookies.set`; the read/borrow path is **deleted** |
| §7 drop `<all_urls>` | ✅ | `optional_host_permissions` + `src/drivers/host-permissions.ts` |
| §3 CDP driver | ✅ | `src/drivers/cdp-driver.ts` + `page-scripts.ts` (hit-testing, accessible-name computation, native-setter writes) |
| **§3 delete `dom-actions.ts`** | ✅ | Deleted (1464 lines). All 11 `EXECUTE_ACTION` call sites migrated. |
| §3 delete duplicate CDP actions | ✅ | `cdp-action-runner.ts` deleted (447 lines); replaced by `cdp-session.ts` (session lifecycle only). |
| §3 drop `all_frames` | ✅ | Removed from the manifest — frame traversal is CDP-side. |

**How §3 was completed.** A bridge, `drivers/step-runner.ts`, executes a legacy
`ExecutionStep` against the Driver and returns the same `{ success, error }`
shape the content script used to. That let all 11 call sites migrate without
first being rewritten around `TestIR`:

| File | Sites |
|---|---|
| `core/explorer/explorer-agent.ts` | 7 |
| `core/executor/action-runner.ts` | 1 |
| `core/executor/assertion-engine.ts` | 1 |
| `core/planner/interactive-planner.ts` | 1 |
| `messaging/messages.ts` | 1 (the message type — deleted) |

Then `dom-actions.ts` and its content-script handler were removed, along with the
now-dead `EXECUTE_ACTION` / `ACTION_RESULT` message types.

**A second duplicate, found while doing this.** `cdp-action-runner.ts` held its
*own* copy of every action and fell back to the content script in 10 places —
`test-executor` chose between two runners with `options.cdpActive ? … : …`. That
is the same dual-path divergence §3 exists to remove, one level up. Both runners
now collapse into `runStep → step-runner → driver`, and the file is gone.

**Assertion semantics were ported, not rewritten.** `drivers/assert-scripts.ts`
preserves the behaviours that are load-bearing and quiet to lose:
case-insensitive substring matching, the toast/snackbar fallback for transient
success messages (all 14 selectors, each covered by a test), animation settling
before visibility checks, shadow-DOM piercing, and the page URL appended to every
error. 27 tests run these against a real DOM.

**§2 violations this migration introduced — and fixed.** Migrating the call sites
made `src/core` import concrete driver modules, which the §2 lint rule caught
immediately. Rather than adding them to the burn-down list, two ports were
introduced so the dependency points drivers → core:

- `core/step-executor.ts` — step execution, `canExecute`, tab release
- `core/cookie-port.ts` — cookie injection (write-only by design, §7.3)

`src/core` now imports **zero** driver modules. The registry is a bounded
compromise, documented in the port: when §4's explorer decomposition lands, each
step handler will receive its driver explicitly and the registry disappears.

**Exit status:** no path to mutate a non-allowlisted origin ✅ (enforced in the
driver, 21 policy tests). One execution substrate ✅. Flake rate ⛔ unmeasured —
needs Phase 1.

### Phase 3 — Durability — ✅ DONE

- §4 `src/core/jobs/job-model.ts` (pure state machine) + `job-runner.ts` (pump)
  + `src/storage/job-db.ts` (transactional commit) + `src/background/job-pump.ts`
  (alarm-driven)
- §12 `src/storage/migrations.ts` — explicit numbered chain replacing the pile of
  existence guards; DB v2 → v3 adds `jobs` and `run_artifacts`; zod validation on
  every job read
- **Exit met:** worker eviction is simulated in tests — a job left `running` is
  reclaimed after a staleness window and continues from its cursor, and a crawl
  drained across 20 evictions visits every page exactly once.

Two real bugs were caught here by the tests, both worth recording:

1. **Claim/step conflation.** `pumpBatch` re-claimed the job each iteration, so
   after the first commit the staleness guard (correctly) refused to hand it back
   and the batch stalled at one step. Fixed by splitting `pumpOnce` (claims) from
   `stepJob` (advances a job the caller already holds).
2. **`runMigrations` ignored the target version.** Opening at v1 ran *every*
   migration including v3. Invisible in production (we always open at
   `DB_VERSION`) but wrong, and it made the "upgrade from v1" test fail.

### Phase 4 — Determinism and cost — ✅ DONE

- §6 `src/core/ir/test-ir.ts` — zod `TestIR`, canonical serialization,
  `parseTestIR` as the single gate
- §6 `src/core/ir/ir-bridge.ts` — legacy `ExecutionStep[]` ⇄ `TestIR`, the
  migration seam
- §6 `src/core/executor/execution-ports.ts` + `core/planner/ai-execution-services.ts`
  — the executor's AI dependencies inverted into injected ports
- §5 `src/core/locator.ts` + `core/report/heal-ledger.ts` +
  `core/report/result-adapter.ts` (heal recording, `NEEDS_REVIEW`, testability)
- §9 constraint tests at zero tokens — already satisfied by
  `test-gen/constraint-test-generator.ts`; the cap now discloses truncation
- **Exit met:** identical IR across runs ✅ (asserted byte-for-byte). Executor
  contains zero AI ✅ (lint with no exemptions + a source-level test).

#### How the §6 boundary was actually achieved

The executor could not simply stop importing the AI layer — it genuinely needed
planning, healing and assertion generation mid-run. Moving files would have been
cosmetic. So the dependency was **inverted**:

| Before | After |
|---|---|
| `test-executor` → `planner/test-planner` (AI) | `test-executor` → `PlanProvider` type |
| `test-executor` → `healing/self-healer` (AI) | `test-executor` → `StepHealer` type |
| `test-executor` → `executor/assertion-generator` (AI) | `test-executor` → `AssertionSuggester` type |
| `test-executor` → `ai/budget-guard` | `test-executor` → `budget/budget-guard` |

`executeTest(testCase, aiClient, …)` became `executeTest(testCase, services, …)`.
The caller composes services; `createAiExecutionServices(aiClient)` supplies the
AI-backed set, and `DETERMINISTIC_SERVICES` / `storedPlanServices()` supply sets
that make **no model calls at all** — which is what lets execution be measured
without an API key.

Two files moved because they were in the wrong place, not because the rule was
inconvenient:

- `ai/budget-guard.ts` → `budget/budget-guard.ts`. It never calls a model; it
  counts what others spent. Living under `ai/` made a spend cap look like an AI
  dependency.
- `executor/assertion-generator.ts` → `planner/assertion-generator.ts`. It is a
  generation concern that needs a model.

**The §6 burn-down list is now empty**, and the ESLint override carries no
`excludedFiles`.

#### Three things worth recording

- **An empty `excludedFiles: []` silently disables an ESLint override.** Emptying
  the burn-down list switched the §6 rule OFF rather than tightening it. Caught by
  re-running the deliberate-violation probe. The key is now omitted entirely, and
  `test/integration/execution-boundary.test.ts` asserts the boundary at source
  level too, so a disabled rule cannot hide it again.
- **The IR needed positional assertions.** Legacy plans interleave assertions with
  actions, asserting about *intermediate* state. The original IR ran all
  assertions at the end, which would have silently changed what every migrated
  test checks. `Assertion.afterStep` pins an assertion to a step; the executor
  honours it and stops the run when a positional assertion fails, because the
  state it described is transient.
- **Conversion is lossy, and says so.** `wait`, `if_visible`, `loop` and
  `use_captured` have no IR equivalent. Each is reported in
  `ConversionResult.dropped` with a reason rather than silently omitted — a step
  that vanishes in conversion is a test that quietly stops checking something.
  `use_captured` is preserved as `{{placeholder}}` interpolation.

### Phase 5 — Output — ✅ DONE

- §11 `src/core/report/junit-export.ts` (JUnit XML + canonical JSON),
  `run-trace.ts` (bundle: results, heals, mutation ledger, testability, network,
  capped screenshots, embedded IR)
- Scheduled runs: `src/background/scheduled-runs.ts` — enqueues a durable job
  rather than running inline, so a scheduled run inherits eviction survival
- **Exit met:** a CI job can consume `junit.xml` / `results.json` from the repo
  with Pathfinder never running in CI.

`NEEDS_REVIEW` is emitted as a passing testcase with a `<system-out>` note, not a
failure. Downgrading a real pass to a failure would train teams to ignore the
signal, which defeats its purpose.

---

## 14b. Wiring pass (post-audit)

An audit after Phases 2–5 found that **10 of 28 new modules had no caller**. They
were correct and tested in isolation while contributing nothing to the running
product — the gap between "the architecture exists" and "the product uses it".
Phase status had been reported as ✅ on the strength of tests alone, which was
misleading.

| Module | Before | Now |
|---|---|---|
| §7 origin allowlist + method gate | ❌ inert | ✅ installed in `initCDPSession` and per explorer tab |
| §7 mutation ledger | ❌ inert | ✅ per-run, summarised at teardown |
| §7 runtime host permissions | ❌ inert | ✅ requested from the user's click |
| §5 `NEEDS_REVIEW` verdict | ❌ inert | ✅ computed from legacy heal records |
| §5 testability report | ❌ inert | ✅ export handler + UI button |
| §11 JUnit exporter | ❌ inert (duplicate) | ✅ replaced the old generator |
| §11 run trace | ❌ inert | ✅ `EXPORT_RUN_TRACE` handler |
| §4 job executors | ❌ inert | ✅ `crawl` + `explore` registered at startup |
| §6 `ir-executor` | ❌ inert | ❌ **still inert** — see below |
| §9 `constraint-ir-generator` | ❌ inert | ❌ deliberately inert (successor, not a parallel) |

### Three things the audit exposed

**1. A regression I had introduced.** Dropping `<all_urls>` for
`optional_host_permissions` without wiring the grant flow left the extension with
**no host access at all** — every run would have failed on every request. Now
requested per app from the user's click, in both the explorer and the test runner.

**2. Two more duplicate implementations**, the §3 mistake repeated in other
layers:

- `utils/html-reporter.ts` already had a `generateJUnitXml`. My §11 exporter was a
  second one. The old one is **deleted**; the richer exporter (verdicts, heal
  records, testability context, XML-safety) is now the only one.
- `test-gen/constraint-test-generator.ts` already derived constraint tests
  deterministically and was **already wired**. §9's "should need no tokens" was
  therefore already satisfied in the product. `constraint-ir-generator.ts` is
  documented as its IR-emitting successor — to replace it, not run beside it.

**3. §5 was a reporting gap, not a missing feature.** `StepResult.healingAttempt`
and `TestResult.healingAttempts` have always recorded heals; nothing surfaced
them. `report/result-adapter.ts` computes `NEEDS_REVIEW` from data the legacy
executor already produced — so §5's guarantee is live without waiting for the IR
migration.

Also fixed: the constraint-test generator capped output at 25 per flow and logged
only what it kept. A silent cap reads as full coverage, so the drop is now
reported.

### What remains inert, and why

`ir-executor.ts` (§6). Wiring it means changing what `test-generator.ts` and
`test-importer.ts` emit — from `ExecutionStep` to `TestIR` — which is the last
large migration. The benchmark now exists to measure it, which is the right order.

---

## 14a. Implementation summary (as built)

**New modules (28):**

```
src/core/driver.ts                      the port
src/core/locator.ts                     three-tier ladder
src/core/actionability.ts               precondition decision logic
src/core/safety/origin-policy.ts        allowlist + method gate
src/core/safety/mutation-ledger.ts      what the run changed
src/core/jobs/job-model.ts              durable job state machine
src/core/jobs/job-runner.ts             the pump
src/core/ir/test-ir.ts                  the determinism boundary
src/core/ir/constraint-ir-generator.ts  zero-token negative tests
src/core/executor/ir-executor.ts        IR → driver, no AI
src/core/step-executor.ts               step-execution port (§2/§3)
src/core/cookie-port.ts                 cookie-injection port (write-only)
src/core/cdp/cdp-session.ts             CDP session lifecycle (replaces action-runner)
src/core/report/heal-ledger.ts          heals + NEEDS_REVIEW + testability
src/core/report/junit-export.ts         JUnit + JSON
src/core/report/run-trace.ts            trace bundle
src/drivers/cdp-driver.ts               chrome.debugger implementation
src/drivers/fake-driver.ts              in-memory, for tests
src/drivers/page-scripts.ts             injected DOM analysis
src/drivers/cdp-safety.ts               Fetch interception
src/drivers/cdp-cookies.ts             CDP cookie writes
src/drivers/host-permissions.ts         runtime grants
src/drivers/step-runner.ts              legacy ExecutionStep → Driver bridge
src/drivers/assert-scripts.ts           ported assertion semantics
src/storage/migrations.ts               explicit chain
src/storage/job-db.ts                   transactional job store
src/background/job-pump.ts              alarm-driven pump
src/background/scheduled-runs.ts        recurring runs
```

**Deleted (2911 lines of duplicate execution logic):**

```
src/content/dom-actions.ts          1464   synthetic-event action path
src/core/cdp/cdp-action-runner.ts    447   second copy of every action
cli/  MCP/  test/unit/cli/          ~1000   duplicate engines (Phase 0)
```

**Verification:** `tsc --noEmit` clean · 829 tests / 71 files pass (from 559) ·
`vite build` clean · 0 lint errors in new code.

**Dependency added:** `zod@3.25.76` (§6/§12 both specify it; pure JS, no `eval`,
CSP-safe).

**Lint burn-down (in `.eslintrc.cjs`, blocking new violations):**

- §2 — 9 files under `src/core` still using `chrome.*`
- §6 — 2 files (`test-executor.ts`, `assertion-generator.ts`) still importing
  `core/ai`. This is the violation §6 exists to stop: an LLM call on the execution
  path. `ir-executor.ts` is the clean replacement.

**Pre-existing issues found, not fixed (out of scope, no behaviour change):**

- 28 lint errors in pre-existing files (18 × `no-explicit-any`,
  4 × `no-async-promise-executor` in `indexed-db.ts`, plus minor)
- `npm run test:e2e` references `@playwright/test`, which is not installed

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Phase 2 is a large rewrite of the hot path | Phase 1's benchmark makes regressions visible per-PR instead of at release |
| `optional_host_permissions` adds an onboarding prompt | Request once per project at creation; explain it in the setup flow |
| Dropping `cookies` breaks users relying on an existing browser session | Auth presets already exist; make preset setup part of project creation before shipping the change |
| CDP-only loses coverage where `chrome.debugger` cannot attach (e.g. `chrome://`, Web Store pages) | Out of scope — these are not test targets. Fail with a clear message. |
| Losing CI gating reduces perceived value | §11 exports; be explicit in the README that Pathfinder authors and validates suites, and CI consumes the artifacts |
| The benchmark itself becomes stale or gamed | Add a fixture with every confirmed field-reported false positive |

---

## 16. Definition of Done

| # | Criterion | Status |
|---|---|---|
| 1 | One package, no duplicate engines | ✅ |
| 2 | `src/core` imports zero `chrome.*` | 🟡 Core imports zero DRIVER modules ✅ (via ports); 9 files still call `chrome.*` — burn-down list |
| 3 | One action implementation (CDP) | ✅ `dom-actions.ts` (1464) + `cdp-action-runner.ts` (447) deleted |
| 4 | Crawl survives eviction | ✅ Machinery proven in tests AND executors registered, so a durable crawl is now runnable |
| 5 | Executor has zero LLM calls | ✅ `core/executor/**` imports no AI at all. Lint rule has **no exemptions**; a source-level test backs it up |
| 6 | No `cookies`, no `<all_urls>` | ✅ — and the runtime grant flow `<all_urls>` was hiding is now wired |
| 7 | Benchmark in CI, FP rate measured | ✅ **7 fixtures · recall 100% · 0 false positives · 0 flake · 0 tokens** |
| 8 | No file over 300 lines | ❌ **36** files over budget (31 `.ts` + 5 `.tsx`). An earlier count of 12 in this document was wrong — it came from a truncated listing. Every NEW module is within budget. |

### Remaining work, in priority order

1. **Generators emit IR directly.** `ir-bridge.ts` converts on the way out, which
   makes the IR canonical without rewriting generation. The remaining step is for
   `test-generator.ts` / `test-importer.ts` to produce `TestIR` natively, at which
   point `constraint-ir-generator.ts` replaces its legacy predecessor and
   `approximateTestability()` can be replaced by exact numbers (structured
   locators instead of inferred tiers).
2. **Route execution through `ir-executor`.** The ports are in place and the
   legacy executor is AI-free, so this is now a swap rather than a redesign —
   measured against the benchmark at each step.
3. **Grow the benchmark.** 7 fixtures is a floor. Add one for every confirmed
   field-reported false positive (§15), and add LLM-generated tests once an API key
   is available in CI so cost and flake stop reading zero.
4. **§4 migration.** Move the explorer's click/modal/form interaction onto job
   steps. Retires the service-worker keepalive, decomposes the two largest files,
   clears most of the §2 `chrome.*` burn-down, and lets the step-executor registry
   be replaced by explicit driver injection.
5. **§12 completion.** Split `storage/schemas.ts` (741 lines) per domain.
6. **§13 file budget.** 36 files remain over 300 lines — 31 `.ts` and 5 `.tsx`.
   Items 1 and 4 address the largest `.ts` offenders; the `.tsx` sidepanel
   components are untouched by this plan and need their own pass.
