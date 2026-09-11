# AVT Parity Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the seven organisationally-valuable capabilities found in `ai-virtual-tester-automation` into Pathfinder without abandoning its client-side architecture.

**Architecture:** Every feature is additive and lands as a focused module under `src/core/**` with unit tests, then a thin wiring change at the seam that consumes it. Two features extend an existing port (`StepHealer`, `ExecutionOptions`); the rest are new modules. No backend, no new runtime dependency.

**Tech Stack:** TypeScript 5.4 strict, Zod 3.25, Vitest 1.4, React 18 + Zustand (side panel), Chrome MV3, CDP.

**Spec:** `docs/superpowers/specs/2026-09-10-avt-parity.md`

## Global Constraints

- ADR-002 holds: no backend. All network calls go browser → user's chosen endpoint with the user's own credentials.
- ADR-004 holds: no provider-specific AI code outside `src/core/ai/`. Consume `AIClientInterface` only.
- `strict: true`. Never `any` — use `unknown` plus a type guard.
- No file > 300 lines. No function > 50 lines. One primary export per module.
- Every new module gets a test file under `test/unit/core/`.
- Test names follow `given_<state>_when_<action>_then_<expectation>`.
- Test command is `npx vitest run <path>`. Typecheck is `npm run typecheck`. Lint is `npm run lint`.
- The IR is the determinism boundary. An LLM produces IR and nothing else.
- Generated artifacts never contain silent `TODO`s. Unexpressible items go into a `dropped` array surfaced to the user, mirroring `describeDropped` in `src/core/ir/ir-bridge.ts:274`.
- Commit after every task using Conventional Commits, and end each message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

---

## File Structure

**New modules**

| File | Responsibility |
|---|---|
| `src/core/healing/class-stability.ts` | Deterministic hashed/CSS-in-JS class-name detection (F7) |
| `src/core/export/playwright-locator.ts` | `Locator` → Playwright locator expression (F1) |
| `src/core/export/playwright-emitter.ts` | `TestIR` → runnable `.spec.ts` source (F1) |
| `src/core/healing/visual-locator.ts` | Vision-model healing strategy (F2) |
| `src/core/test-gen/dataset.ts` | CSV → `DataSet`, row → variable map (F3) |
| `src/core/executor/stability-gate.ts` | Run-N-times acceptance gate (F5) |
| `src/core/integrations/testrail-client.ts` | TestRail REST transport (F4) |
| `src/core/integrations/testrail-sync.ts` | TestRail ⇄ Pathfinder mapping (F4) |

**Modified**

| File | Change |
|---|---|
| `src/storage/schemas.ts` | `HealingAttempt.method` gains `'visual'`; `TestCase` gains `dataSet`, `quarantined`; `Settings` gains `testrail` |
| `src/core/healing/selector-generator.ts` | Filter hashed-class candidates |
| `src/core/healing/attribute-selector.ts` | Filter hashed-class candidates |
| `src/core/locator.ts` | `isTestabilityGap` treats hash-only structural locators as a gap |
| `src/core/ai/prompt-templates.ts` | Explicit hashed-class prohibition |
| `src/core/executor/execution-ports.ts` | `StepHealer` gains optional `HealContext` |
| `src/core/planner/ai-execution-services.ts` | Pass context through to `healStep` |
| `src/core/healing/self-healer.ts` | Fourth (visual) strategy |
| `src/core/executor/test-executor.ts` | Pass failure screenshot to healer; seed data row; `startFromStep` |
| `src/core/ir/test-ir.ts` | `dataKeys` seeds the placeholder-capture set |
| `src/sidepanel/components/results/ResultsPanel.tsx` | Playwright export + TestRail push buttons |
| `src/sidepanel/components/results/FailureDetail.tsx` | "Resume from this step" |
| `src/sidepanel/components/tests/TestCaseInput.tsx` | Dataset paste |
| `src/sidepanel/components/settings/SettingsPanel.tsx` | TestRail credentials |
| `manifest.json` | Optional host permission for the TestRail host |

---

## Task Order and Dependencies

```
Task 1 ─ Task 2                     (F7 — no dependencies, do first: improves every later selector)
Task 3 ─ Task 4 ─ Task 5            (F1 — Task 4 consumes Task 3)
Task 6 ─ Task 7                     (F2 — Task 7 consumes the port change in Task 6)
Task 8 ─ Task 9 ─ Task 10           (F3)
Task 11 ─ Task 12                   (F5 — Task 11 uses TestCase.quarantined from Task 8's schema edit)
Task 13 ─ Task 14                   (F6)
Task 15 ─ Task 16 ─ Task 17         (F4)
```

---

# Feature F7 — Hashed class-name guard

### Task 1: Hashed class-name detector

**Files:**
- Create: `src/core/healing/class-stability.ts`
- Test: `test/unit/core/class-stability.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isHashedClassName(cls: string): boolean`
  - `stableClassesOf(classAttr: string): string[]`
  - `isHashOnlySelector(selector: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/class-stability.test.ts
import { describe, it, expect } from 'vitest';
import {
  isHashedClassName,
  stableClassesOf,
  isHashOnlySelector,
} from '../../../src/core/healing/class-stability';

describe('isHashedClassName', () => {
  // Real-world hashes observed in styled-components, emotion and CSS modules.
  const hashed = [
    'sc-1e593sq-0',              // styled-components component id
    'beZfZu',                    // styled-components generated class
    'css-1x2y3z',                // emotion
    'jss123',                    // JSS
    'Button_root__a1b2c',        // CSS modules
    'styles__StyledLink-sc-1e593sq-0',
    'x1n2onr6',                  // atomic css (meta-style)
    'a8Kd92Lf',
  ];
  it.each(hashed)('given_hashed_class_%s_when_tested_then_true', (cls) => {
    expect(isHashedClassName(cls)).toBe(true);
  });

  // Human-authored names must never be rejected — a false positive here
  // discards the only usable selector.
  const stable = [
    'btn', 'btn-primary', 'nav-link', 'login-container', 'share-icon',
    'form-group', 'is-active', 'col-md-6', 'mt-4', 'dashboard-dropdown-menu-item',
    'modal', 'primary', 'header', 'sidebar-nav', 'text-sm',
    'mtdls-typography-label-medium-default',
  ];
  it.each(stable)('given_authored_class_%s_when_tested_then_false', (cls) => {
    expect(isHashedClassName(cls)).toBe(false);
  });

  it('given_empty_string_when_tested_then_false', () => {
    expect(isHashedClassName('')).toBe(false);
  });
});

describe('stableClassesOf', () => {
  it('given_mixed_class_attribute_when_filtered_then_keeps_only_authored_names', () => {
    const attr = 'styles__StyledLink-sc-1e593sq-0 beZfZu mtdls-typography-label-medium-default expanded-state-route-item';
    expect(stableClassesOf(attr)).toEqual([
      'mtdls-typography-label-medium-default',
      'expanded-state-route-item',
    ]);
  });

  it('given_all_hashed_when_filtered_then_empty', () => {
    expect(stableClassesOf('sc-abc12-3 beZfZu')).toEqual([]);
  });

  it('given_extra_whitespace_when_filtered_then_ignores_blanks', () => {
    expect(stableClassesOf('  btn   primary  ')).toEqual(['btn', 'primary']);
  });
});

describe('isHashOnlySelector', () => {
  it('given_selector_of_only_hashed_classes_then_true', () => {
    expect(isHashOnlySelector('.sc-1e593sq-0.beZfZu')).toBe(true);
  });

  it('given_selector_with_one_authored_class_then_false', () => {
    expect(isHashOnlySelector('.sc-1e593sq-0.nav-link')).toBe(false);
  });

  it('given_selector_with_stable_attribute_then_false', () => {
    expect(isHashOnlySelector('[data-testid="save"].beZfZu')).toBe(false);
  });

  it('given_id_selector_then_false', () => {
    expect(isHashOnlySelector('#submit-btn')).toBe(false);
  });

  it('given_selector_with_no_classes_then_false', () => {
    expect(isHashOnlySelector('button[type="submit"]')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/class-stability.test.ts`
Expected: FAIL — `Failed to resolve import ".../class-stability"`

- [ ] **Step 3: Write the implementation**

```ts
// src/core/healing/class-stability.ts
/**
 * Detection of build-generated class names.
 *
 * `locator.ts` already states the rule — "stable-looking attributes only, never
 * generated/hashed class names" — but nothing enforced it, so the selector
 * ladder's last rung (`.unique-class`) would happily pick
 * `.sc-1e593sq-0.beZfZu`. Those change on every build, so the test breaks on
 * the next deploy and healing pays for it forever. Cheaper to never pick them.
 *
 * Deliberately conservative: a false positive discards a usable selector, which
 * is worse than keeping a brittle one. Every pattern below is anchored to a
 * generator's documented output shape rather than to entropy alone.
 */

/** styled-components component id: `sc-` + base-36 hash + `-` + index. */
const STYLED_COMPONENTS_ID = /(^|-)sc-[a-z0-9]{5,}(-\d+)?$/i;

/** emotion (`css-1x2y3z`), JSS (`jss42`), goober (`go1234`). */
const CSS_IN_JS_PREFIXED = /^(css|jss|go|emotion)-?\d[a-z0-9]*$/i;

/** CSS modules: `Block_element__hash`. The double underscore is the tell. */
const CSS_MODULE_SUFFIXED = /__[a-z0-9]{4,}$/i;

/**
 * Generic high-entropy token: no separator, mixed case or digit-mixed, and no
 * vowel run a human would type. `beZfZu`, `x1n2onr6`, `a8Kd92Lf`.
 */
function looksHighEntropy(cls: string): boolean {
  if (cls.length < 5 || cls.length > 24) return false;
  if (/[-_]/.test(cls)) return false;

  const hasUpper = /[A-Z]/.test(cls);
  const hasLower = /[a-z]/.test(cls);
  const digits = (cls.match(/\d/g) ?? []).length;

  // Mixed case with no word boundary — camelCase authored names are rare in
  // class attributes and almost always separator-delimited when they occur.
  const mixedCaseNoBoundary = hasUpper && hasLower && !/^[a-z]+[A-Z][a-z]+$/.test(cls);
  // Digits interleaved with letters rather than a trailing ordinal (`col6` is
  // authored; `x1n2onr6` is not).
  const interleavedDigits = digits >= 2 && !/^[a-z-]+\d{1,2}$/i.test(cls);

  return mixedCaseNoBoundary || interleavedDigits;
}

export function isHashedClassName(cls: string): boolean {
  const trimmed = cls.trim();
  if (!trimmed) return false;
  if (STYLED_COMPONENTS_ID.test(trimmed)) return true;
  if (CSS_IN_JS_PREFIXED.test(trimmed)) return true;
  if (CSS_MODULE_SUFFIXED.test(trimmed)) return true;
  return looksHighEntropy(trimmed);
}

/** Split a `class` attribute and drop every generated name. */
export function stableClassesOf(classAttr: string): string[] {
  return classAttr
    .split(/\s+/)
    .filter((c) => c.length > 0)
    .filter((c) => !isHashedClassName(c));
}

/**
 * True when a CSS selector's ONLY distinguishing signal is generated class
 * names. Such a selector is worthless past the next deploy.
 *
 * A selector carrying anything else — an id, an attribute, a stable class — is
 * kept: the hash is then redundant decoration, not the load-bearing part.
 */
export function isHashOnlySelector(selector: string): boolean {
  const classes = [...selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
  if (classes.length === 0) return false;
  if (!classes.every(isHashedClassName)) return false;
  // Any non-class signal rescues it.
  const withoutClasses = selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, '').trim();
  return !/[#[]/.test(withoutClasses);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/core/class-stability.test.ts && npm run typecheck`
Expected: PASS, all cases green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/healing/class-stability.ts test/unit/core/class-stability.test.ts
git commit -m "feat(healing): detect build-generated class names

Selector candidates could previously land on styled-components and emotion
build hashes, which change every deploy and turn into permanent healing cost."
```

---

### Task 2: Reject hashed-class selectors across the selector pipeline

**Files:**
- Modify: `src/core/healing/selector-generator.ts`
- Modify: `src/core/healing/attribute-selector.ts`
- Modify: `src/core/locator.ts:172` (`isTestabilityGap`)
- Modify: `src/core/ai/prompt-templates.ts:173-186` and `:627`
- Test: `test/unit/core/class-stability-wiring.test.ts`

**Interfaces:**
- Consumes: `isHashOnlySelector`, `isHashedClassName` from Task 1.
- Produces: no new exports. Behaviour change only.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/class-stability-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { parseAlternatives } from '../../../src/core/healing/selector-generator';
import { isTestabilityGap, fromCss, fromTestId } from '../../../src/core/locator';
import { PROMPTS } from '../../../src/core/ai/prompt-templates';

describe('parseAlternatives', () => {
  it('given_ai_returns_hash_only_selectors_when_parsed_then_they_are_dropped', () => {
    const raw = JSON.stringify([
      '.sc-1e593sq-0.beZfZu',
      '[data-testid="save"]',
      '.css-1x2y3z',
      'button.save-btn',
    ]);
    expect(parseAlternatives(raw)).toEqual(['[data-testid="save"]', 'button.save-btn']);
  });

  it('given_all_candidates_hashed_when_parsed_then_empty', () => {
    expect(parseAlternatives(JSON.stringify(['.beZfZu', '.sc-abc12-0']))).toEqual([]);
  });
});

describe('isTestabilityGap', () => {
  it('given_structural_locator_of_only_hashed_classes_then_gap', () => {
    expect(isTestabilityGap(fromCss('.sc-1e593sq-0.beZfZu'))).toBe(true);
  });

  it('given_testid_locator_then_not_a_gap', () => {
    expect(isTestabilityGap(fromTestId('save'))).toBe(false);
  });
});

describe('prompt guidance', () => {
  it('given_planning_prompt_then_it_names_the_generated_class_prohibition', () => {
    const text = PROMPTS.testPlanning.system;
    expect(text).toMatch(/styled-components|generated class/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/class-stability-wiring.test.ts`
Expected: FAIL — `parseAlternatives` is not exported, and the prompt assertion fails.

- [ ] **Step 3: Implement the wiring**

In `src/core/healing/selector-generator.ts`, export `parseAlternatives` and filter inside it:

```ts
import { isHashOnlySelector } from './class-stability';

/**
 * Parse the model's selector list.
 *
 * Hash-only candidates are dropped here rather than at use sites: the model is
 * told not to produce them, and when it does anyway there is no point carrying
 * them one layer further.
 */
export function parseAlternatives(raw: string): string[] {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim())
    .filter((s) => !isHashOnlySelector(s));
}
```

In `src/core/healing/attribute-selector.ts`, add the same filter to the returned list — append `.filter((s) => !isHashOnlySelector(s))` to the final chain in `buildAttributeSelectors`, and import `isHashOnlySelector` and `stableClassesOf` from `./class-stability`. Where `deriveSelectors` builds a class-based selector from an element's `className`, use `stableClassesOf(el.className)` instead of the raw attribute.

In `src/core/locator.ts`, extend `isTestabilityGap` so a structural-only locator whose CSS is hash-only counts as a gap:

```ts
import { isHashOnlySelector } from './healing/class-stability';

export function isTestabilityGap(loc: Locator): boolean {
  if (loc.testid) return false;
  if (loc.semantic) return false;
  // Structural-only was already a gap. A structural locator resting entirely on
  // build hashes is the worst case — it will not survive the next deploy.
  return true || isHashOnlySelector(loc.structural?.css ?? '');
}
```

> Note for the implementer: read the existing body of `isTestabilityGap` first. If it already returns `true` for structural-only locators, no change is needed there — instead add the hash check to the *reporting* path so a hash-only locator is flagged with a distinct reason. Keep the function under 15 lines and do not write `true || …`; that placeholder above is illustrative of the condition, not code to paste.

In `src/core/ai/prompt-templates.ts`, add to the strict locator-priority block (around line 173) and to the healing prompt (around line 627):

```
- NEVER use build-generated class names. These change on every deploy and the
  test will break: styled-components (`sc-1e593sq-0`, `beZfZu`), emotion
  (`css-1x2y3z`), JSS (`jss42`), CSS modules (`Button_root__a1b2c`). Prefer a
  class that reads as English and describes purpose (`btn-primary`, `nav-link`).
  If an element's only classes are generated, fall back to a stable ancestor
  plus role/text instead of the class.
- When several elements match, disambiguate by scoping to a stable ancestor or
  by adding a text filter — not by index.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/class-stability-wiring.test.ts test/unit/core/selector-generator.test.ts test/unit/core/attribute-selector.test.ts && npm run typecheck && npm run lint`
Expected: PASS. If `selector-generator.test.ts` or `attribute-selector.test.ts` asserted on hash-like fixtures, update those fixtures — the new behaviour is intended.

- [ ] **Step 5: Commit**

```bash
git add src/core/healing src/core/locator.ts src/core/ai/prompt-templates.ts test/unit/core/class-stability-wiring.test.ts
git commit -m "feat(healing): reject build-hash class selectors end to end

Filters hash-only candidates out of both selector strategies, counts a
hash-only structural locator as a testability gap, and names the prohibition
in the planning and healing prompts."
```

---

# Feature F1 — Playwright code export

### Task 3: Locator → Playwright expression

**Files:**
- Create: `src/core/export/playwright-locator.ts`
- Test: `test/unit/core/playwright-locator.test.ts`

**Interfaces:**
- Consumes: `Locator`, `AriaRole` from `src/core/locator.ts`.
- Produces:
  - `type LocatorEmit = { expr: string } | { unsupported: string }`
  - `emitLocator(loc: Locator, root?: string): LocatorEmit`
  - `quote(value: string): string`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/playwright-locator.test.ts
import { describe, it, expect } from 'vitest';
import { emitLocator, quote } from '../../../src/core/export/playwright-locator';
import type { Locator } from '../../../src/core/locator';

function loc(partial: Partial<Locator>): Locator {
  return { preferredTier: 'structural', ...partial } as Locator;
}

describe('quote', () => {
  it('given_plain_text_then_single_quoted', () => {
    expect(quote('Save')).toBe("'Save'");
  });

  it('given_apostrophe_then_escaped', () => {
    expect(quote("User's name")).toBe("'User\\'s name'");
  });

  it('given_backslash_then_escaped', () => {
    expect(quote('a\\b')).toBe("'a\\\\b'");
  });

  it('given_newline_then_escaped_not_literal', () => {
    expect(quote('a\nb')).toBe("'a\\nb'");
  });
});

describe('emitLocator', () => {
  it('given_testid_tier_then_getByTestId', () => {
    const r = emitLocator(loc({ testid: 'save-btn', preferredTier: 'testid' }));
    expect(r).toEqual({ expr: "page.getByTestId('save-btn')" });
  });

  it('given_semantic_tier_then_getByRole_with_name', () => {
    const r = emitLocator(loc({
      semantic: { role: 'button', name: 'Save', exact: true },
      preferredTier: 'semantic',
    }));
    expect(r).toEqual({ expr: "page.getByRole('button', { name: 'Save', exact: true })" });
  });

  it('given_semantic_without_exact_then_omits_exact', () => {
    const r = emitLocator(loc({
      semantic: { role: 'link', name: 'Assets' },
      preferredTier: 'semantic',
    }));
    expect(r).toEqual({ expr: "page.getByRole('link', { name: 'Assets' })" });
  });

  it('given_scoped_semantic_then_chains_from_the_scope', () => {
    const r = emitLocator(loc({
      semantic: {
        role: 'button',
        name: 'Save',
        scope: { preferredTier: 'testid', testid: 'billing-form' },
      },
      preferredTier: 'semantic',
    }));
    expect(r).toEqual({
      expr: "page.getByTestId('billing-form').getByRole('button', { name: 'Save' })",
    });
  });

  it('given_structural_tier_then_locator_with_css', () => {
    const r = emitLocator(loc({ structural: { css: '.login-container .primary-btn' } }));
    expect(r).toEqual({ expr: "page.locator('.login-container .primary-btn')" });
  });

  // 'generic' is in ARIA_ROLES but is not a Playwright role — falling through
  // to a lower tier beats emitting code that throws at runtime.
  it('given_generic_role_then_falls_through_to_structural', () => {
    const r = emitLocator(loc({
      semantic: { role: 'generic', name: 'thing' },
      structural: { css: '#thing' },
      preferredTier: 'semantic',
    }));
    expect(r).toEqual({ expr: "page.locator('#thing')" });
  });

  it('given_testid_preferred_but_absent_then_uses_next_available_tier', () => {
    const r = emitLocator(loc({
      semantic: { role: 'button', name: 'Go' },
      preferredTier: 'testid',
    }));
    expect(r).toEqual({ expr: "page.getByRole('button', { name: 'Go' })" });
  });

  it('given_no_usable_tier_then_unsupported_with_reason', () => {
    const r = emitLocator(loc({ semantic: { role: 'generic', name: 'x' }, preferredTier: 'semantic' }));
    expect(r).toEqual({ unsupported: 'locator has no emittable tier' });
  });

  it('given_custom_root_then_chains_from_it', () => {
    const r = emitLocator(loc({ testid: 'row', preferredTier: 'testid' }), 'frame');
    expect(r).toEqual({ expr: "frame.getByTestId('row')" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/playwright-locator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/export/playwright-locator.ts
/**
 * `Locator` → Playwright locator expression.
 *
 * The locator ladder maps onto Playwright's own API one rung at a time, which
 * is why this transpiler needs no model: `testid` → `getByTestId`, `semantic`
 * → `getByRole`, `structural` → `locator`. Emission walks the tiers in
 * durability order starting at `preferredTier`, so a test exported today keeps
 * the strongest identifier it was captured with.
 *
 * Failure is a value, never a silently-wrong string. A locator with nothing
 * emittable returns `unsupported` and the caller reports it to the user —
 * emitting a comment in its place would produce a spec file that passes while
 * testing nothing.
 */
import type { AriaRole, Locator, LocatorTier } from '../locator';

export type LocatorEmit = { expr: string } | { unsupported: string };

/**
 * Roles Playwright's `getByRole` does not accept. `generic` is a real ARIA role
 * and is in our own enum, but passing it to Playwright throws at runtime, so it
 * must fall through to a lower tier at emit time rather than at test time.
 */
const NON_PLAYWRIGHT_ROLES: ReadonlySet<string> = new Set(['generic']);

/** Single-quote a value for embedding in generated TypeScript. */
export function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

const TIER_ORDER: readonly LocatorTier[] = ['testid', 'semantic', 'structural'];

/** Tiers to try, best-first, starting from the locator's preferred tier. */
function tiersToTry(loc: Locator): LocatorTier[] {
  const start = TIER_ORDER.indexOf(loc.preferredTier);
  const from = start === -1 ? 0 : start;
  return [...TIER_ORDER.slice(from), ...TIER_ORDER.slice(0, from)];
}

function emitRole(role: AriaRole, name: string, exact: boolean | undefined): string {
  const opts = [`name: ${quote(name)}`];
  if (exact) opts.push('exact: true');
  return `getByRole(${quote(role)}, { ${opts.join(', ')} })`;
}

export function emitLocator(loc: Locator, root = 'page'): LocatorEmit {
  for (const tier of tiersToTry(loc)) {
    if (tier === 'testid' && loc.testid) {
      return { expr: `${root}.getByTestId(${quote(loc.testid)})` };
    }
    if (tier === 'semantic' && loc.semantic && !NON_PLAYWRIGHT_ROLES.has(loc.semantic.role)) {
      const { role, name, exact, scope } = loc.semantic;
      let base = root;
      if (scope) {
        const scoped = emitLocator(scope, root);
        if ('unsupported' in scoped) return scoped;
        base = scoped.expr;
      }
      return { expr: `${base}.${emitRole(role, name, exact)}` };
    }
    if (tier === 'structural' && loc.structural?.css) {
      return { expr: `${root}.locator(${quote(loc.structural.css)})` };
    }
  }
  return { unsupported: 'locator has no emittable tier' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/core/playwright-locator.test.ts && npm run typecheck`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/export/playwright-locator.ts test/unit/core/playwright-locator.test.ts
git commit -m "feat(export): map the locator ladder onto Playwright locators

First half of Playwright export. Tier walk starts at preferredTier so an
exported test keeps the strongest identifier it was captured with."
```

---

### Task 4: TestIR → runnable spec file

**Files:**
- Create: `src/core/export/playwright-emitter.ts`
- Test: `test/unit/core/playwright-emitter.test.ts`

**Interfaces:**
- Consumes: `emitLocator`, `quote` from Task 3; `TestIR`, `Step`, `Assertion` from `src/core/ir/test-ir.ts`.
- Produces:
  - `interface EmitResult { source: string; dropped: string[] }`
  - `emitPlaywrightTest(ir: TestIR): EmitResult`
  - `emitPlaywrightSuite(irs: TestIR[]): EmitResult`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/playwright-emitter.test.ts
import { describe, it, expect } from 'vitest';
import { emitPlaywrightTest, emitPlaywrightSuite } from '../../../src/core/export/playwright-emitter';
import { IR_VERSION, type TestIR } from '../../../src/core/ir/test-ir';

function ir(overrides: Partial<TestIR> = {}): TestIR {
  return {
    irVersion: IR_VERSION,
    id: 't1',
    name: 'User can sign in',
    startUrl: 'https://app.example.com/login',
    provenance: {
      source: 'user',
      promptVersion: 'n/a',
      model: 'n/a',
      generatedAt: 0,
      deterministic: true,
    },
    steps: [],
    assertions: [
      { order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'home' }, description: 'Home visible', confidence: 'grounded' },
    ],
    tags: [],
    ...overrides,
  } as TestIR;
}

describe('emitPlaywrightTest', () => {
  it('given_ir_then_emits_import_and_test_block', () => {
    const { source } = emitPlaywrightTest(ir());
    expect(source).toContain("import { test, expect } from '@playwright/test';");
    expect(source).toContain("test('User can sign in'");
    expect(source).toContain('async ({ page }) => {');
    expect(source.trimEnd().endsWith('});')).toBe(true);
  });

  it('given_tags_then_emits_playwright_tag_option', () => {
    const { source } = emitPlaywrightTest(ir({ tags: ['smoke', 'auth'] }));
    expect(source).toContain("{ tag: ['@smoke', '@auth'] }");
  });

  it('given_start_url_then_navigates_first', () => {
    const { source } = emitPlaywrightTest(ir());
    expect(source).toContain("await page.goto('https://app.example.com/login');");
    expect(source).toContain("await page.waitForLoadState('load');");
  });

  it('given_click_and_type_steps_then_emits_actions_with_intent_comments', () => {
    const { source } = emitPlaywrightTest(ir({
      steps: [
        { order: 0, action: 'type', locator: { preferredTier: 'testid', testid: 'email' }, value: 'a@b.com', description: 'Enter the email' },
        { order: 1, action: 'click', locator: { preferredTier: 'semantic', semantic: { role: 'button', name: 'Sign in' } }, description: 'Submit the form' },
      ],
    }));
    expect(source).toContain('// Enter the email');
    expect(source).toContain("await page.getByTestId('email').fill('a@b.com');");
    expect(source).toContain('// Submit the form');
    expect(source).toContain("await page.getByRole('button', { name: 'Sign in' }).click();");
  });

  it('given_capture_then_declares_a_const_and_later_step_uses_a_template_literal', () => {
    const { source } = emitPlaywrightTest(ir({
      steps: [
        { order: 0, action: 'capture', locator: { preferredTier: 'testid', testid: 'order-no' }, captureAs: 'orderNo', captureFrom: 'text', description: 'Read the order number' },
        { order: 1, action: 'type', locator: { preferredTier: 'testid', testid: 'search' }, value: 'order {{orderNo}}', description: 'Search for it' },
      ],
    }));
    expect(source).toContain("const orderNo = await page.getByTestId('order-no').innerText();");
    expect(source).toContain('await page.getByTestId(\'search\').fill(`order ${orderNo}`);');
  });

  it('given_drag_drop_then_uses_the_stepped_helper', () => {
    const { source } = emitPlaywrightTest(ir({
      steps: [
        {
          order: 0,
          action: 'drag_drop',
          locator: { preferredTier: 'testid', testid: 'card' },
          targetLocator: { preferredTier: 'testid', testid: 'lane' },
          description: 'Drag the card into the lane',
        },
      ],
    }));
    expect(source).toContain('async function smoothDragTo(');
    expect(source).toContain("await smoothDragTo(page, page.getByTestId('card'), page.getByTestId('lane'));");
  });

  it('given_no_drag_step_then_helper_is_not_emitted', () => {
    const { source } = emitPlaywrightTest(ir());
    expect(source).not.toContain('smoothDragTo');
  });

  it('given_assertions_then_emits_expect_calls', () => {
    const { source } = emitPlaywrightTest(ir({
      assertions: [
        { order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'banner' }, description: 'Banner shows', confidence: 'grounded' },
        { order: 1, kind: 'text', locator: { preferredTier: 'testid', testid: 'banner' }, expected: 'Saved', description: 'Banner says saved', confidence: 'grounded' },
        { order: 2, kind: 'url', expected: 'https://app.example.com/home', description: 'Landed on home', confidence: 'grounded' },
        { order: 3, kind: 'exact_count', locator: { preferredTier: 'testid', testid: 'row' }, expected: '3', description: 'Three rows', confidence: 'grounded' },
      ],
    }));
    expect(source).toContain("await expect(page.getByTestId('banner')).toBeVisible();");
    expect(source).toContain("await expect(page.getByTestId('banner')).toContainText('Saved');");
    expect(source).toContain("await expect(page).toHaveURL('https://app.example.com/home');");
    expect(source).toContain("await expect(page.getByTestId('row')).toHaveCount(3);");
  });

  it('given_after_step_assertion_then_it_is_interleaved_not_appended', () => {
    const { source } = emitPlaywrightTest(ir({
      steps: [
        { order: 0, action: 'click', locator: { preferredTier: 'testid', testid: 'save' }, description: 'Click save' },
        { order: 1, action: 'click', locator: { preferredTier: 'testid', testid: 'away' }, description: 'Navigate away' },
      ],
      assertions: [
        { order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'toast' }, description: 'Toast appears', confidence: 'grounded', afterStep: 0 },
      ],
    }));
    const toastAt = source.indexOf('toast');
    const awayAt = source.indexOf('away');
    expect(toastAt).toBeGreaterThan(-1);
    expect(toastAt).toBeLessThan(awayAt);
  });

  // Network assertions have no static equivalent in a plain spec file. They are
  // reported, never emitted as a comment that would silently weaken the test.
  it('given_api_assertion_then_it_is_dropped_with_a_reason', () => {
    const { source, dropped } = emitPlaywrightTest(ir({
      assertions: [
        { order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'ok' }, description: 'ok', confidence: 'grounded' },
        { order: 1, kind: 'api_status', expected: '200', description: 'API returned 200', confidence: 'grounded' },
      ],
    }));
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatch(/api_status/);
    expect(source).not.toContain('api_status');
  });

  it('given_unemittable_locator_then_step_is_dropped_with_its_description', () => {
    const { source, dropped } = emitPlaywrightTest(ir({
      steps: [
        { order: 0, action: 'click', locator: { preferredTier: 'semantic', semantic: { role: 'generic', name: 'x' } }, description: 'Click the mystery thing' },
      ],
    }));
    expect(dropped.join(' ')).toContain('Click the mystery thing');
    expect(source).not.toContain('mystery');
  });

  it('given_apostrophe_in_name_then_test_title_is_escaped', () => {
    const { source } = emitPlaywrightTest(ir({ name: "User's profile loads" }));
    expect(source).toContain("test('User\\'s profile loads'");
  });
});

describe('emitPlaywrightSuite', () => {
  it('given_two_irs_then_one_file_with_one_import_and_two_tests', () => {
    const { source } = emitPlaywrightSuite([ir({ id: 'a', name: 'A' }), ir({ id: 'b', name: 'B' })]);
    expect(source.match(/import \{ test, expect \}/g)).toHaveLength(1);
    expect(source).toContain("test('A'");
    expect(source).toContain("test('B'");
  });

  it('given_two_irs_then_dropped_items_are_merged', () => {
    const { dropped } = emitPlaywrightSuite([
      ir({ id: 'a', name: 'A', assertions: [
        { order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'ok' }, description: 'ok', confidence: 'grounded' },
        { order: 1, kind: 'api_called', description: 'called', confidence: 'grounded' },
      ] }),
      ir({ id: 'b', name: 'B', assertions: [
        { order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'ok' }, description: 'ok', confidence: 'grounded' },
        { order: 1, kind: 'api_not_called', description: 'not called', confidence: 'grounded' },
      ] }),
    ]);
    expect(dropped).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/playwright-emitter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/export/playwright-emitter.ts
/**
 * `TestIR` → runnable `@playwright/test` source.
 *
 * This is the artifact boundary. Pathfinder executes tests in-browser via CDP,
 * which is excellent for authoring and useless for CI, code review, or keeping
 * a test after the extension is uninstalled. The IR already holds everything a
 * spec file needs, so the transpiler is deterministic — no model, no
 * non-reproducibility, and a diff a reviewer can read.
 *
 * Anything not expressible in a plain spec file is returned in `dropped`
 * instead of being emitted as a comment. A test that looks complete but
 * silently asserts less than the original is worse than one the user knows is
 * partial.
 */
import type { Assertion, Step, TestIR } from '../ir/test-ir';
import { PLACEHOLDER_RE } from '../ir/test-ir';
import { emitLocator, quote } from './playwright-locator';

export interface EmitResult {
  source: string;
  /** Human-readable reasons, one per step or assertion that could not be emitted. */
  dropped: string[];
}

const HEADER = "import { test, expect } from '@playwright/test';";

/**
 * Playwright's own `dragTo` is unreliable against drag libraries that require
 * intermediate pointer movement — the same finding AVT documented against
 * microsoft/playwright#20254. Stepped mouse movement is the workaround.
 */
const DRAG_HELPER = `
/**
 * Drag with intermediate pointer movement. Libraries that listen for
 * dragover (react-dnd, SortableJS) ignore a single-jump dragTo.
 */
async function smoothDragTo(page, source, target) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag source or target has no bounding box');
  const fromX = from.x + from.width / 2;
  const fromY = from.y + from.height / 2;
  const toX = to.x + to.width / 2;
  const toY = to.y + to.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(fromX + ((toX - fromX) / steps) * i, fromY + ((toY - fromY) / steps) * i);
  }
  await page.mouse.up();
}
`.trim();

/** Emit a value as a quoted string, or a template literal when it interpolates. */
function emitValue(value: string): string {
  PLACEHOLDER_RE.lastIndex = 0;
  if (!PLACEHOLDER_RE.test(value)) return quote(value);
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, '${$1}');
  return `\`${body}\``;
}

const CAPTURE_READERS: Record<string, string> = {
  text: 'innerText()',
  value: 'inputValue()',
};

/** One IR step → one or more lines of source, or a drop reason. */
function emitStep(step: Step): { lines: string[] } | { dropped: string } {
  let target = '';
  if (step.locator) {
    const emitted = emitLocator(step.locator);
    if ('unsupported' in emitted) {
      return { dropped: `step ${step.order} (${step.action}) "${step.description}": ${emitted.unsupported}` };
    }
    target = emitted.expr;
  }

  switch (step.action) {
    case 'navigate':
      return { lines: [`await page.goto(${emitValue(step.value ?? '')});`, `await page.waitForLoadState('load');`] };
    case 'click':
      return { lines: [`await ${target}.click();`] };
    case 'double_click':
      return { lines: [`await ${target}.dblclick();`] };
    case 'type':
      return { lines: [`await ${target}.fill(${emitValue(step.value ?? '')});`] };
    case 'clear':
      return { lines: [`await ${target}.clear();`] };
    case 'hover':
      return { lines: [`await ${target}.hover();`] };
    case 'check':
      return { lines: [`await ${target}.check();`] };
    case 'uncheck':
      return { lines: [`await ${target}.uncheck();`] };
    case 'select':
      return { lines: [`await ${target}.selectOption(${emitValue(step.value ?? '')});`] };
    case 'press_key':
      return { lines: [`await page.keyboard.press(${quote(step.key ?? 'Enter')});`] };
    case 'upload_file':
      return { lines: [`await ${target}.setInputFiles(${emitValue(step.value ?? '')});`] };
    case 'scroll':
      return {
        lines: target
          ? [`await ${target}.scrollIntoViewIfNeeded();`]
          : ['await page.mouse.wheel(0, 600);'],
      };
    case 'drag_drop': {
      if (!step.targetLocator) {
        return { dropped: `step ${step.order} (drag_drop) "${step.description}": no target locator` };
      }
      const dropTarget = emitLocator(step.targetLocator);
      if ('unsupported' in dropTarget) {
        return { dropped: `step ${step.order} (drag_drop) "${step.description}": target ${dropTarget.unsupported}` };
      }
      return { lines: [`await smoothDragTo(page, ${target}, ${dropTarget.expr});`] };
    }
    case 'capture': {
      const reader = step.captureFrom === 'attribute'
        ? `getAttribute(${quote(step.attribute ?? '')})`
        : CAPTURE_READERS[step.captureFrom ?? 'text'];
      return { lines: [`const ${step.captureAs} = await ${target}.${reader};`] };
    }
    default:
      return { dropped: `step ${step.order}: unsupported action "${String(step.action)}"` };
  }
}

/** Assertion kinds with no static equivalent in a plain spec file. */
const NETWORK_KINDS: ReadonlySet<string> = new Set(['api_called', 'api_not_called', 'api_status']);

/** One IR assertion → one line of source, or a drop reason. */
function emitAssertion(a: Assertion): { line: string } | { dropped: string } {
  if (NETWORK_KINDS.has(a.kind)) {
    return {
      dropped:
        `assertion ${a.order} (${a.kind}) "${a.description}": network assertions need ` +
        `route interception and are not emitted — verify this in Pathfinder or add a page.route() handler by hand`,
    };
  }
  if (a.kind === 'url') {
    return { line: `await expect(page).toHaveURL(${quote(a.expected ?? '')});` };
  }
  if (!a.locator) {
    return { dropped: `assertion ${a.order} (${a.kind}) "${a.description}": no locator` };
  }
  const emitted = emitLocator(a.locator);
  if ('unsupported' in emitted) {
    return { dropped: `assertion ${a.order} (${a.kind}) "${a.description}": ${emitted.unsupported}` };
  }
  const subject = `expect(${emitted.expr})`;
  const expected = a.expected ?? '';
  switch (a.kind) {
    case 'visible':      return { line: `await ${subject}.toBeVisible();` };
    case 'not_visible':  return { line: `await ${subject}.not.toBeVisible();` };
    case 'exists':       return { line: `await ${subject}.toBeAttached();` };
    case 'not_exists':   return { line: `await ${subject}.not.toBeAttached();` };
    case 'text':         return { line: `await ${subject}.toContainText(${quote(expected)});` };
    case 'not_text':     return { line: `await ${subject}.not.toContainText(${quote(expected)});` };
    case 'value':        return { line: `await ${subject}.toHaveValue(${quote(expected)});` };
    case 'attribute':    return { line: `await ${subject}.toHaveAttribute(${quote(a.attribute ?? '')}, ${quote(expected)});` };
    case 'enabled':      return { line: `await ${subject}.toBeEnabled();` };
    case 'disabled':     return { line: `await ${subject}.toBeDisabled();` };
    case 'exact_count':  return { line: `await ${subject}.toHaveCount(${Number(expected) || 0});` };
    case 'count':        return { line: `expect(await ${emitted.expr}.count()).toBeGreaterThanOrEqual(${Number(expected) || 0});` };
    default:             return { dropped: `assertion ${a.order}: unsupported kind "${String(a.kind)}"` };
  }
}

/** The body of one `test()` block, indented two spaces. */
function emitBody(ir: TestIR, dropped: string[]): string[] {
  const lines: string[] = [];
  if (ir.startUrl) {
    lines.push(`await page.goto(${quote(ir.startUrl)});`, `await page.waitForLoadState('load');`, '');
  }

  const byStep = new Map<number, Assertion[]>();
  const deferred: Assertion[] = [];
  for (const a of [...ir.assertions].sort((x, y) => x.order - y.order)) {
    if (a.afterStep === undefined) { deferred.push(a); continue; }
    const bucket = byStep.get(a.afterStep) ?? [];
    bucket.push(a);
    byStep.set(a.afterStep, bucket);
  }

  const pushAssertions = (list: Assertion[]) => {
    for (const a of list) {
      const out = emitAssertion(a);
      if ('dropped' in out) dropped.push(out.dropped);
      else lines.push(out.line);
    }
  };

  for (const step of [...ir.steps].sort((a, b) => a.order - b.order)) {
    const out = emitStep(step);
    if ('dropped' in out) { dropped.push(out.dropped); continue; }
    lines.push(`// ${step.description}`, ...out.lines);
    const after = byStep.get(step.order);
    if (after) pushAssertions(after);
    lines.push('');
  }

  if (deferred.length > 0) {
    lines.push('// Final assertions');
    pushAssertions(deferred);
  }
  return lines;
}

function emitTestBlock(ir: TestIR, dropped: string[]): string {
  const tagOpt = ir.tags.length > 0
    ? `, { tag: [${ir.tags.map((t) => quote(`@${t}`)).join(', ')}] }`
    : '';
  const body = emitBody(ir, dropped).map((l) => (l === '' ? '' : `  ${l}`)).join('\n');
  return `test(${quote(ir.name)}${tagOpt}, async ({ page }) => {\n${body}\n});`;
}

function needsDragHelper(irs: TestIR[]): boolean {
  return irs.some((ir) => ir.steps.some((s) => s.action === 'drag_drop'));
}

function assemble(irs: TestIR[], blocks: string[], dropped: string[]): EmitResult {
  const parts = [HEADER, ''];
  if (needsDragHelper(irs)) parts.push(DRAG_HELPER, '');
  parts.push(blocks.join('\n\n'), '');
  return { source: parts.join('\n'), dropped };
}

export function emitPlaywrightTest(ir: TestIR): EmitResult {
  const dropped: string[] = [];
  return assemble([ir], [emitTestBlock(ir, dropped)], dropped);
}

export function emitPlaywrightSuite(irs: TestIR[]): EmitResult {
  const dropped: string[] = [];
  const blocks = irs.map((ir) => emitTestBlock(ir, dropped));
  return assemble(irs, blocks, dropped);
}
```

> Implementer note: this file will land close to the 300-line limit. If it exceeds it, split the assertion emitter into `src/core/export/playwright-assertions.ts` and re-export.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/core/playwright-emitter.test.ts && npm run typecheck && npm run lint`
Expected: PASS (15 tests).

- [ ] **Step 5: Verify the output actually compiles as Playwright**

Write one emitted sample to a scratch file and typecheck it against the real Playwright types:

```bash
mkdir -p /tmp/pf-emit && npx vitest run test/unit/core/playwright-emitter.test.ts --reporter=dot
node -e "
const { emitPlaywrightTest } = require('./dist-noop');" 2>/dev/null || true
```

Because the emitter is ESM TypeScript, do this instead — add a temporary test that writes the file and asserts on its shape rather than shelling out:

```ts
// append to test/unit/core/playwright-emitter.test.ts
it('given_emitted_source_then_it_is_balanced_and_has_no_placeholder_markers', () => {
  const { source } = emitPlaywrightTest(ir({
    steps: [{ order: 0, action: 'click', locator: { preferredTier: 'testid', testid: 'x' }, description: 'Click x' }],
  }));
  expect(source).not.toMatch(/TODO|FIXME|undefined/);
  const opens = (source.match(/\{/g) ?? []).length;
  const closes = (source.match(/\}/g) ?? []).length;
  expect(opens).toBe(closes);
});
```

Run: `npx vitest run test/unit/core/playwright-emitter.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/export/playwright-emitter.ts test/unit/core/playwright-emitter.test.ts
git commit -m "feat(export): transpile TestIR into runnable Playwright specs

Deterministic — no model call. Unexpressible items (network assertions,
locators with no emittable tier) are returned as dropped rather than emitted
as comments that would weaken the test silently."
```

---

### Task 5: Playwright export in the results UI

**Files:**
- Modify: `src/sidepanel/components/results/ResultsPanel.tsx`
- Modify: `src/core/ir/ir-bridge.ts` (only if `testCaseToIR` needs a plan-only overload — read it first)
- Test: `test/unit/core/playwright-export-wiring.test.ts`

**Interfaces:**
- Consumes: `emitPlaywrightSuite` (Task 4); `testCaseToIR` from `src/core/ir/ir-bridge.ts:83`.
- Produces: `buildPlaywrightExport(inputs: ExportInput[]): EmitResult` in `src/core/export/playwright-emitter.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/playwright-export-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { buildPlaywrightExport } from '../../../src/core/export/playwright-emitter';
import type { TestCase, ExecutionStep } from '../../../src/storage/schemas';

const steps: ExecutionStep[] = [
  { order: 0, action: 'navigate', value: 'https://app.example.com/login', description: 'Open login' },
  { order: 1, action: 'type', selector: "[data-testid='email']", value: 'a@b.com', description: 'Enter email' },
  { order: 2, action: 'click', selector: "[data-testid='submit']", description: 'Submit' },
  { order: 3, action: 'assert', assertType: 'visible', selector: "[data-testid='home']", description: 'Home visible' },
];

const testCase: TestCase = {
  id: 'tc1',
  title: 'User can sign in',
  description: 'happy path',
  type: 'positive',
  source: 'generated',
  status: 'passed',
  createdAt: '2026-09-10T00:00:00.000Z',
  startUrl: 'https://app.example.com/login',
  preplan: steps,
};

describe('buildPlaywrightExport', () => {
  it('given_a_test_case_with_a_plan_then_emits_a_spec_containing_its_actions', () => {
    const { source, dropped } = buildPlaywrightExport([{ testCase, steps }]);
    expect(source).toContain("import { test, expect } from '@playwright/test';");
    expect(source).toContain("test('User can sign in'");
    expect(source).toContain(".fill('a@b.com')");
    expect(source).toContain('.click()');
    expect(dropped).toEqual([]);
  });

  it('given_a_plan_with_no_assertions_then_it_is_reported_not_silently_emitted', () => {
    const noAssert = steps.filter((s) => s.action !== 'assert');
    const { dropped } = buildPlaywrightExport([{ testCase, steps: noAssert }]);
    expect(dropped.join(' ')).toMatch(/assert/i);
  });

  it('given_no_inputs_then_empty_source_and_no_throw', () => {
    const { source, dropped } = buildPlaywrightExport([]);
    expect(source).toContain('@playwright/test');
    expect(dropped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/playwright-export-wiring.test.ts`
Expected: FAIL — `buildPlaywrightExport` is not exported.

- [ ] **Step 3: Implement `buildPlaywrightExport` and the UI button**

Append to `src/core/export/playwright-emitter.ts`:

```ts
import type { ExecutionStep, TestCase } from '../../storage/schemas';
import { testCaseToIR } from '../ir/ir-bridge';

export interface ExportInput {
  testCase: TestCase;
  steps: ExecutionStep[];
}

/**
 * Bridge from stored test cases to emitted source.
 *
 * `testCaseToIR` is the existing, tested conversion and it already reports what
 * it had to drop — a plan with no assertions among them. Reusing it means the
 * exporter inherits the IR's guarantees instead of re-deriving them.
 */
export function buildPlaywrightExport(inputs: ExportInput[]): EmitResult {
  const irs: TestIR[] = [];
  const dropped: string[] = [];
  for (const { testCase, steps } of inputs) {
    const converted = testCaseToIR(testCase, steps);
    if (converted.ir) irs.push(converted.ir);
    for (const d of converted.dropped ?? []) {
      dropped.push(typeof d === 'string' ? d : JSON.stringify(d));
    }
  }
  const emitted = emitPlaywrightSuite(irs);
  return { source: emitted.source, dropped: [...dropped, ...emitted.dropped] };
}
```

> Implementer note: read `testCaseToIR` at `src/core/ir/ir-bridge.ts:83` before writing this. Match its actual parameter list and the real shape of `ConversionResult` — the `.ir` / `.dropped` names above must be corrected to whatever it truly returns, and `describeDropped` (line 274) is likely the right formatter for the drop reasons rather than `JSON.stringify`.

In `src/sidepanel/components/results/ResultsPanel.tsx`, add a handler beside `handleExportJUnit`, following the existing `downloadBlob` pattern exactly:

```tsx
const handleExportPlaywright = async () => {
  const inputs = await collectExportInputs(results);   // reads plans from planDB by testCaseId
  const { source, dropped } = buildPlaywrightExport(inputs);
  downloadBlob(source, `pathfinder-tests-${Date.now()}.spec.ts`, 'text/plain');
  if (dropped.length > 0) setExportNotice(dropped);    // render in the existing notice area
};
```

Add the button to the same toolbar as the other exports, labelled `Playwright`, and render `exportNotice` as a list under the toolbar so dropped items are visible rather than silent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/playwright-export-wiring.test.ts && npm run typecheck && npm run lint && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Manual verification**

```bash
npm run build:chrome
```
Load `dist/` in `chrome://extensions`, run any test, open Results, click **Playwright**, and confirm the downloaded `.spec.ts` opens with a valid `import`, one `test()` per result, and that any dropped items are listed in the panel.

- [ ] **Step 6: Commit**

```bash
git add src/core/export src/sidepanel/components/results/ResultsPanel.tsx test/unit/core/playwright-export-wiring.test.ts
git commit -m "feat(export): add Playwright spec export to the results toolbar

Tests can now leave the extension and run in CI. Dropped items are shown in
the panel rather than omitted quietly."
```

---
# Feature F2 — Vision-assisted self-healing

### Task 6: Carry the failure screenshot to the healer

**Files:**
- Modify: `src/core/executor/execution-ports.ts:59-64` (`StepHealer`)
- Modify: `src/core/planner/ai-execution-services.ts:59-62`
- Modify: `src/core/executor/test-executor.ts:686-700`
- Modify: `src/storage/schemas.ts:585-592` (`HealingAttempt.method`)
- Modify: `src/core/healing/self-healer.ts:86` (`healStep` signature)
- Test: `test/unit/core/heal-context.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface HealContext { screenshot?: string }` exported from `src/core/executor/execution-ports.ts`
  - `StepHealer` gains a 5th optional parameter `context?: HealContext`
  - `healStep(step, error, tabId, aiClient, stepRunner?, context?)`
  - `HealingAttempt.method` union gains `'visual'`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/heal-context.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { HealContext, StepHealer } from '../../../src/core/executor/execution-ports';
import type { ExecutionStep, HealingAttempt } from '../../../src/storage/schemas';

describe('StepHealer contract', () => {
  it('given_a_healer_when_called_with_a_context_then_it_receives_the_screenshot', async () => {
    const seen: HealContext[] = [];
    const healer: StepHealer = async (_step, _error, _tabId, _runner, context) => {
      if (context) seen.push(context);
      return {
        success: false,
        attempt: { stepOrder: 0, originalSelector: '#a', method: 'visual', success: false },
      };
    };

    const step: ExecutionStep = { order: 0, action: 'click', selector: '#a', description: 'Click' };
    await healer(step, 'not found', 1, vi.fn(), { screenshot: 'BASE64PNG' });

    expect(seen).toEqual([{ screenshot: 'BASE64PNG' }]);
  });

  it('given_a_healer_called_without_a_context_then_it_still_type_checks', async () => {
    const healer: StepHealer = async () => ({
      success: false,
      attempt: { stepOrder: 0, originalSelector: '#a', method: 'similarity', success: false },
    });
    const step: ExecutionStep = { order: 0, action: 'click', selector: '#a', description: 'Click' };
    const out = await healer(step, 'boom', 1, vi.fn());
    expect(out.success).toBe(false);
  });

  it('given_a_visual_healing_attempt_then_the_method_is_a_valid_union_member', () => {
    const attempt: HealingAttempt = {
      stepOrder: 2,
      originalSelector: '#save',
      method: 'visual',
      healedSelector: "[data-testid='save']",
      success: true,
    };
    expect(attempt.method).toBe('visual');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/heal-context.test.ts`
Expected: FAIL — `HealContext` is not exported and `'visual'` is not in the `method` union (typecheck error).

- [ ] **Step 3: Make the port and schema changes**

In `src/storage/schemas.ts`, widen the union:

```ts
export interface HealingAttempt {
  stepOrder: number;
  originalSelector: string;
  /**
   * `visual` is the vision-model tier: it reads the failure screenshot rather
   * than the DOM, which is the only way to resolve an icon-only control or a
   * canvas-rendered widget.
   */
  method: 'alternative' | 'similarity' | 'ai' | 'visual';
  healedSelector?: string;
  success: boolean;
  error?: string;
}
```

In `src/core/executor/execution-ports.ts`, add the context type and extend the healer:

```ts
/**
 * Evidence about the failure that the healer may use.
 *
 * The executor already captures a screenshot at the exact moment of failure
 * (before healing perturbs the page) and previously only attached it to the
 * report. Passing it here is what makes a vision tier possible.
 */
export interface HealContext {
  /** Base64 PNG captured at the moment the step failed. */
  screenshot?: string;
}

export type StepHealer = (
  step: ExecutionStep,
  error: string,
  tabId: number,
  runner: StepRunner,
  context?: HealContext
) => Promise<HealOutcome>;
```

In `src/core/healing/self-healer.ts`, add the parameter (unused for now — Task 7 consumes it):

```ts
export async function healStep(
  step: ExecutionStep,
  error: string,
  tabId: number,
  aiClient: AIClientInterface,
  stepRunner: typeof runStep = runStep,
  context?: HealContext
): Promise<HealingResult> {
```

Import `HealContext` from `../executor/execution-ports`.

In `src/core/planner/ai-execution-services.ts`, thread it through:

```ts
const heal: StepHealer | undefined = allowAiHealing
  ? (step, error, tabId, runner, context) => healStep(step, error, tabId, aiClient, runner, context)
  : undefined;
```

> Implementer note: read lines 55-65 of that file first and preserve whatever the existing `allowAiHealing` condition actually is — only the parameter list changes.

In `src/core/executor/test-executor.ts`, pass the screenshot that is already in hand at line ~697:

```ts
const healed = services.heal
  ? await services.heal(step, result.error ?? '', tabId, activeRunner, { screenshot: failScreenshot })
  : null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/heal-context.test.ts test/unit/core/self-healer.test.ts && npm run typecheck`
Expected: PASS. `self-healer.test.ts` must still pass untouched — the new parameter is optional.

- [ ] **Step 5: Commit**

```bash
git add src/storage/schemas.ts src/core/executor/execution-ports.ts src/core/executor/test-executor.ts src/core/healing/self-healer.ts src/core/planner/ai-execution-services.ts test/unit/core/heal-context.test.ts
git commit -m "feat(healing): carry the failure screenshot into the healing port

The executor already captured a screenshot at the moment of failure and only
attached it to the report. This makes it available to healing strategies."
```

---

### Task 7: Vision healing strategy

**Files:**
- Create: `src/core/healing/visual-locator.ts`
- Modify: `src/core/healing/self-healer.ts` (add as final strategy)
- Modify: `src/core/ai/prompt-templates.ts` (add `visualHealing` prompt)
- Test: `test/unit/core/visual-locator.test.ts`

**Interfaces:**
- Consumes: `HealContext` (Task 6); `AIClientInterface` and its `Message` content-part type from `src/core/ai/ai-client.ts` (the image part is `{ type: 'image', data: string, mimeType: string }`); `isHashOnlySelector` (Task 1).
- Produces: `proposeSelectorFromScreenshot(args: VisualHealArgs): Promise<string[]>`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/visual-locator.test.ts
import { describe, it, expect, vi } from 'vitest';
import { proposeSelectorFromScreenshot } from '../../../src/core/healing/visual-locator';
import type { AIClientInterface } from '../../../src/core/ai/ai-client';

function client(reply: string): AIClientInterface {
  return {
    chat: vi.fn(async () => reply),
    embed: vi.fn(async () => [[0]]),
  } as unknown as AIClientInterface;
}

const args = {
  description: 'Click the share icon',
  failedSelector: '.icon.share-icon',
  error: 'element not found',
  screenshot: 'BASE64PNG',
  domContext: "<button aria-label='Share'><span class='beZfZu'></span></button>",
};

describe('proposeSelectorFromScreenshot', () => {
  it('given_a_json_array_reply_then_returns_the_candidates_in_order', async () => {
    const ai = client(JSON.stringify(["[aria-label='Share']", 'button.share']));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai }))
      .resolves.toEqual(["[aria-label='Share']", 'button.share']);
  });

  it('given_a_fenced_json_reply_then_still_parses', async () => {
    const ai = client("```json\n[\"[aria-label='Share']\"]\n```");
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai }))
      .resolves.toEqual(["[aria-label='Share']"]);
  });

  it('given_hash_only_candidates_then_they_are_filtered_out', async () => {
    const ai = client(JSON.stringify(['.beZfZu', "[aria-label='Share']"]));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai }))
      .resolves.toEqual(["[aria-label='Share']"]);
  });

  it('given_the_screenshot_then_it_is_sent_as_an_image_content_part', async () => {
    const ai = client(JSON.stringify(['#x']));
    await proposeSelectorFromScreenshot({ ...args, aiClient: ai });
    const messages = (ai.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const parts = messages[messages.length - 1].content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: 'BASE64PNG', mimeType: 'image/png' }),
      ])
    );
  });

  it('given_no_screenshot_then_no_ai_call_is_made', async () => {
    const ai = client(JSON.stringify(['#x']));
    await expect(proposeSelectorFromScreenshot({ ...args, screenshot: undefined, aiClient: ai }))
      .resolves.toEqual([]);
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('given_a_data_uri_screenshot_then_the_prefix_is_stripped', async () => {
    const ai = client(JSON.stringify(['#x']));
    await proposeSelectorFromScreenshot({ ...args, screenshot: 'data:image/png;base64,ABC', aiClient: ai });
    const messages = (ai.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const parts = messages[messages.length - 1].content;
    expect(parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ data: 'ABC' })])
    );
  });

  it('given_an_unparseable_reply_then_returns_empty_rather_than_throwing', async () => {
    const ai = client('I could not identify the element.');
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([]);
  });

  it('given_the_ai_call_throws_then_returns_empty', async () => {
    const ai = { chat: vi.fn(async () => { throw new Error('429'); }) } as unknown as AIClientInterface;
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([]);
  });

  it('given_more_than_three_candidates_then_caps_at_three', async () => {
    const ai = client(JSON.stringify(['#a', '#b', '#c', '#d', '#e']));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai }))
      .resolves.toEqual(['#a', '#b', '#c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/visual-locator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/healing/visual-locator.ts
/**
 * Vision tier of self-healing.
 *
 * The three DOM strategies all reason over text: alternative selectors, Jaccard
 * text similarity, and attribute derivation. None can resolve a control whose
 * identity is purely visual — an icon-only button, a canvas-rendered widget, or
 * two DOM-identical rows the user distinguishes by position on screen.
 *
 * The executor already holds a screenshot from the exact moment of failure. This
 * tier is the only consumer that can use it, and it runs LAST because it is the
 * most expensive: a vision call costs several times a text call, so it is only
 * paid once the cheap tiers have all declined. That mirrors the cost control in
 * the reference implementation, which attached the image only when an error was
 * already in hand.
 */
import type { AIClientInterface } from '../ai/ai-client';
import { PROMPTS } from '../ai/prompt-templates';
import { isHashOnlySelector } from './class-stability';
import { createLogger } from '../../utils/logger';

const log = createLogger('visual-locator');

/** Beyond three, candidate validation costs more than the healing is worth. */
const MAX_CANDIDATES = 3;

export interface VisualHealArgs {
  /** The step's human-readable intent — what the test was trying to do. */
  description: string;
  /** The selector that failed, as a negative example. */
  failedSelector: string;
  error: string;
  /** Base64 PNG, with or without a data-URI prefix. */
  screenshot?: string;
  /** Compressed DOM of the failing page, so the model proposes selectors that exist. */
  domContext: string;
  aiClient: AIClientInterface;
}

/** Strip a data-URI prefix; providers want raw base64. */
function rawBase64(image: string): string {
  return image.replace(/^data:image\/[a-z+]+;base64,/i, '');
}

/** Parse a selector array out of a model reply, tolerating code fences. */
function parseCandidates(raw: string): string[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fenced ? fenced[1] : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => s.trim());
}

export async function proposeSelectorFromScreenshot(args: VisualHealArgs): Promise<string[]> {
  if (!args.screenshot) return [];

  const prompt = PROMPTS.visualHealing;
  let raw: string;
  try {
    raw = await args.aiClient.chat(
      [
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              data: undefined,
              text: prompt.user(args.description, args.failedSelector, args.error, args.domContext),
            },
            { type: 'image', data: rawBase64(args.screenshot), mimeType: 'image/png' },
          ],
        },
      ],
      { temperature: 0, maxTokens: 300 }
    );
  } catch (err) {
    log.warn('Vision healing call failed', err);
    return [];
  }

  return parseCandidates(raw)
    .filter((s) => !isHashOnlySelector(s))
    .slice(0, MAX_CANDIDATES);
}
```

> Implementer note: the exact shape of a text content part is defined in `src/core/ai/ai-client.ts` around line 14. Read it and match it — the `{ type: 'text', ... }` part above is written speculatively and must be corrected to the real discriminated-union member (it almost certainly has no `data` field). Do not invent a shape.

Add the prompt to `src/core/ai/prompt-templates.ts`, following the existing `PROMPTS` object style:

```ts
visualHealing: {
  system:
    'You locate a UI element in a screenshot and return CSS selectors for it.\n' +
    'Return ONLY a JSON array of 1-3 CSS selector strings, best first. No prose.\n' +
    'Rules:\n' +
    '- The selector must exist in the DOM you are given. Never invent attributes.\n' +
    '- Prefer, in order: [data-testid], #id, [aria-label], [name], [placeholder], [role], a class that reads as English.\n' +
    '- NEVER use build-generated class names (styled-components sc-1e593sq-0/beZfZu, emotion css-1x2y3z, JSS jss42, CSS modules Button_root__a1b2c) — they change every deploy.\n' +
    '- NEVER use :has-text(), :contains(), or any Playwright/jQuery pseudo-selector — they throw SyntaxError in a browser.\n' +
    '- If the element is genuinely not visible in the screenshot, return [].',
  user: (description: string, failedSelector: string, error: string, domContext: string) =>
    `The test step was: ${description}\n\n` +
    `This selector no longer matches: ${failedSelector}\n` +
    `Failure: ${error}\n\n` +
    `Find the element in the screenshot that the step intended, then give selectors for it from this DOM:\n${domContext}`,
},
```

Wire it into `healStep` in `src/core/healing/self-healer.ts` as the final strategy, after the existing three:

```ts
// Vision tier — last, because it is the most expensive and the only one that
// needs an image. Skipped entirely when no screenshot was captured.
if (context?.screenshot) {
  const visual = await proposeSelectorFromScreenshot({
    description: step.description,
    failedSelector: step.selector ?? '',
    error,
    screenshot: context.screenshot,
    domContext: await getDOMContext(tabId),
    aiClient,
  });
  for (const candidate of visual) {
    if (await candidateResolves(step, candidate, tabId, stepRunner)) {
      registerHealedSelector(step.selector ?? '', candidate);
      return {
        success: true,
        healedStep: { ...step, selector: candidate },
        attempt: {
          stepOrder: step.order,
          originalSelector: step.selector ?? '',
          method: 'visual',
          healedSelector: candidate,
          success: true,
        },
      };
    }
  }
}
```

> Implementer note: `getDOMContext` is currently a private helper in `selector-generator.ts:35`. Export it from there and import it, rather than duplicating it. Match the exact return shape of the existing strategies' `HealingResult` construction in this file — copy the neighbouring block's structure rather than the sketch above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/visual-locator.test.ts test/unit/core/self-healer.test.ts && npm run typecheck && npm run lint`
Expected: PASS (10 new tests, existing healer tests still green).

- [ ] **Step 5: Add an integration test proving the tier is reached last**

```ts
// append to test/unit/core/self-healer.test.ts
it('given_all_dom_strategies_fail_and_a_screenshot_exists_then_healing_uses_the_visual_tier', async () => {
  // Runner accepts only the selector the vision model will propose, so the
  // earlier tiers cannot succeed by accident.
  const runner = vi.fn(async (step) => ({
    step,
    status: step.selector === "[aria-label='Share']" ? 'passed' : 'failed',
    duration: 1,
  }));
  const aiClient = { chat: vi.fn(async () => JSON.stringify(["[aria-label='Share']"])) };

  const result = await healStep(
    { order: 0, action: 'click', selector: '.icon.share-icon', description: 'Click the share icon' },
    'element not found',
    1,
    aiClient as never,
    runner as never,
    { screenshot: 'BASE64PNG' }
  );

  expect(result.success).toBe(true);
  expect(result.attempt.method).toBe('visual');
  expect(result.healedStep?.selector).toBe("[aria-label='Share']");
});
```

> Implementer note: this test needs the same content-script mocks the existing tests in this file already set up. Reuse that file's existing `vi.mock` blocks rather than adding new ones.

Run: `npx vitest run test/unit/core/self-healer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/healing/visual-locator.ts src/core/healing/self-healer.ts src/core/ai/prompt-templates.ts test/unit/core/visual-locator.test.ts test/unit/core/self-healer.test.ts
git commit -m "feat(healing): add a vision tier that reads the failure screenshot

Icon-only controls, canvas widgets and DOM-identical siblings were unhealable
by the three text strategies. Runs last, and only when a screenshot exists, so
the vision call is only paid once the cheap tiers decline."
```

---

# Feature F3 — Data-driven execution

### Task 8: Dataset parsing and schema

**Files:**
- Create: `src/core/test-gen/dataset.ts`
- Modify: `src/storage/schemas.ts` (`TestCase.dataSet`, `TestCase.quarantined`)
- Modify: `src/core/ir/test-ir.ts` (`dataKeys` seeds the capture set)
- Test: `test/unit/core/dataset.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DataSet { columns: string[]; rows: string[][] }`
  - `parseDataSet(csv: string): { dataSet?: DataSet; errors: string[] }`
  - `rowVariables(dataSet: DataSet, rowIndex: number): Map<string, string>`
  - `dataRowLabel(dataSet: DataSet, rowIndex: number): string`
  - `TestCase.dataSet?: DataSet`, `TestCase.quarantined?: boolean`
  - `TestIRSchema` accepts `dataKeys?: string[]`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/dataset.test.ts
import { describe, it, expect } from 'vitest';
import { parseDataSet, rowVariables, dataRowLabel } from '../../../src/core/test-gen/dataset';

describe('parseDataSet', () => {
  it('given_a_header_and_two_rows_then_parses_columns_and_rows', () => {
    const { dataSet, errors } = parseDataSet('email,password\na@b.com,secret\nc@d.com,hunter2');
    expect(errors).toEqual([]);
    expect(dataSet).toEqual({
      columns: ['email', 'password'],
      rows: [['a@b.com', 'secret'], ['c@d.com', 'hunter2']],
    });
  });

  it('given_quoted_fields_with_commas_then_they_are_preserved', () => {
    const { dataSet } = parseDataSet('name,note\n"Smith, John","says ""hi"""');
    expect(dataSet?.rows).toEqual([['Smith, John', 'says "hi"']]);
  });

  it('given_crlf_line_endings_then_they_are_handled', () => {
    const { dataSet } = parseDataSet('a,b\r\n1,2\r\n');
    expect(dataSet?.rows).toEqual([['1', '2']]);
  });

  it('given_blank_lines_then_they_are_skipped', () => {
    const { dataSet } = parseDataSet('a\n1\n\n2\n');
    expect(dataSet?.rows).toEqual([['1'], ['2']]);
  });

  it('given_only_a_header_then_it_is_an_error', () => {
    const { dataSet, errors } = parseDataSet('email,password');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/no data rows/i);
  });

  it('given_empty_input_then_it_is_an_error', () => {
    const { dataSet, errors } = parseDataSet('   ');
    expect(dataSet).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('given_a_row_with_the_wrong_column_count_then_it_is_reported_with_its_line_number', () => {
    const { dataSet, errors } = parseDataSet('a,b\n1,2\n3\n4,5');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/line 3/);
  });

  // Column names become {{placeholders}}, so they must be valid identifiers or
  // the substitution silently never fires.
  it('given_a_column_name_that_is_not_a_valid_placeholder_then_it_is_reported', () => {
    const { dataSet, errors } = parseDataSet('user email,pw\na,b');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/user email/);
  });

  it('given_duplicate_column_names_then_it_is_reported', () => {
    const { dataSet, errors } = parseDataSet('email,email\na,b');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/duplicate/i);
  });

  // These are set by the loop primitive in step-extensions.ts; a data column of
  // the same name would be silently overwritten mid-loop.
  it('given_a_column_named_loop_index_then_it_is_reported_as_reserved', () => {
    const { errors } = parseDataSet('loop_index\n1');
    expect(errors.join(' ')).toMatch(/reserved/i);
  });
});

describe('rowVariables', () => {
  const dataSet = { columns: ['email', 'pw'], rows: [['a@b.com', 's3cret']] };

  it('given_a_row_index_then_maps_column_names_to_values', () => {
    expect([...rowVariables(dataSet, 0)]).toEqual([['email', 'a@b.com'], ['pw', 's3cret']]);
  });

  it('given_an_out_of_range_index_then_returns_an_empty_map', () => {
    expect(rowVariables(dataSet, 9).size).toBe(0);
  });
});

describe('dataRowLabel', () => {
  it('given_a_row_then_labels_it_with_the_first_column_value', () => {
    expect(dataRowLabel({ columns: ['email', 'pw'], rows: [['a@b.com', 'x']] }, 0))
      .toBe('row 1: a@b.com');
  });

  it('given_a_long_first_value_then_it_is_truncated', () => {
    const long = 'x'.repeat(60);
    expect(dataRowLabel({ columns: ['v'], rows: [[long]] }, 0).length).toBeLessThan(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/dataset.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/test-gen/dataset.ts
/**
 * Data-driven test input.
 *
 * One authored scenario times N rows of data is the cheapest coverage there is:
 * the AI cost is paid once at planning time and every extra row is free. The
 * substitution mechanism already exists — `resolveStepVariables` in
 * `core/executor/step-extensions.ts` resolves `{{name}}` from a map — so a data
 * row is just that map, seeded before the step walk instead of accumulated
 * during it.
 *
 * Validation is strict and up-front. A column name that is not a valid
 * placeholder identifier, or one that collides with a reserved loop variable,
 * would fail silently at run time by typing the literal text `{{user email}}`
 * into a field. Better to refuse the sheet.
 */

export interface DataSet {
  columns: string[];
  rows: string[][];
}

export interface ParseResult {
  dataSet?: DataSet;
  errors: string[];
}

/** Set by `executeLoopStep`; a data column of the same name would be clobbered. */
const RESERVED = new Set(['loop_index', 'loop_iteration']);

const VALID_COLUMN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Split one CSV line, honouring double-quoted fields and `""` escapes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { out.push(field.trim()); field = ''; continue; }
    field += ch;
  }
  out.push(field.trim());
  return out;
}

function validateColumns(columns: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const col of columns) {
    if (!VALID_COLUMN.test(col)) {
      errors.push(
        `Column "${col}" is not a valid placeholder name. Use letters, digits and underscores, starting with a letter or underscore.`
      );
    }
    if (RESERVED.has(col)) {
      errors.push(`Column "${col}" is reserved — it is set by loop steps during execution.`);
    }
    if (seen.has(col)) errors.push(`Duplicate column name "${col}".`);
    seen.add(col);
  }
  return errors;
}

export function parseDataSet(csv: string): ParseResult {
  const lines = csv
    .split(/\r?\n/)
    .map((l, i) => ({ text: l, lineNo: i + 1 }))
    .filter((l) => l.text.trim().length > 0);

  if (lines.length === 0) return { errors: ['No data — paste a CSV with a header row and at least one data row.'] };

  const columns = splitLine(lines[0].text);
  const errors = validateColumns(columns);

  const rows: string[][] = [];
  for (const { text, lineNo } of lines.slice(1)) {
    const cells = splitLine(text);
    if (cells.length !== columns.length) {
      errors.push(`line ${lineNo}: expected ${columns.length} value(s) but found ${cells.length}.`);
      continue;
    }
    rows.push(cells);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push('The CSV has a header but no data rows.');
  }
  if (errors.length > 0) return { errors };
  return { dataSet: { columns, rows }, errors: [] };
}

export function rowVariables(dataSet: DataSet, rowIndex: number): Map<string, string> {
  const row = dataSet.rows[rowIndex];
  if (!row) return new Map();
  return new Map(dataSet.columns.map((col, i) => [col, row[i] ?? '']));
}

/** Short human label so a fanned-out result is identifiable in the results list. */
export function dataRowLabel(dataSet: DataSet, rowIndex: number): string {
  const first = dataSet.rows[rowIndex]?.[0] ?? '';
  const trimmed = first.length > 28 ? `${first.slice(0, 27)}…` : first;
  return `row ${rowIndex + 1}${trimmed ? `: ${trimmed}` : ''}`;
}
```

In `src/storage/schemas.ts`, add to `TestCase` (after `startUrl`):

```ts
  /**
   * Data-driven input. When present the test runs once per row, with
   * `{{column}}` in step values resolved from that row.
   */
  dataSet?: DataSet;
  /**
   * Excluded from suite runs because the stability gate saw it produce
   * different outcomes across identical runs. Set by the gate, cleared by the
   * user.
   */
  quarantined?: boolean;
```

Import `DataSet` from `../core/test-gen/dataset`. If that import direction is disallowed by the existing lint boundaries, move the `DataSet` interface into `schemas.ts` and have `dataset.ts` import it from there instead — check `.eslintrc.cjs` for an import-boundary rule before choosing.

In `src/core/ir/test-ir.ts`, add the field to `TestIRSchema` and seed the capture set inside `superRefine`:

```ts
    /**
     * Names supplied externally per run (data-driven columns). They satisfy
     * `{{placeholder}}` references without an earlier capture step.
     */
    dataKeys: z.array(z.string()).default([]),
```

and in the placeholder loop, replace `const captured = new Set<string>();` with:

```ts
    const captured = new Set<string>(ir.dataKeys);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/dataset.test.ts test/unit/core/ir-bridge.test.ts && npm run typecheck`
Expected: PASS. `ir-bridge.test.ts` must stay green — `dataKeys` defaults to `[]`, so existing IR is unaffected.

- [ ] **Step 5: Add the IR seeding test**

```ts
// append to test/unit/core/ir-bridge.test.ts (or test/unit/core/test-ir.test.ts if one exists)
it('given_dataKeys_when_a_step_references_one_then_the_ir_validates', () => {
  const parsed = TestIRSchema.safeParse({
    irVersion: IR_VERSION,
    id: 'x', name: 'Data-driven login',
    provenance: { source: 'user', generatedAt: 0 },
    dataKeys: ['email'],
    steps: [{ order: 0, action: 'type', locator: { preferredTier: 'testid', testid: 'email' }, value: '{{email}}', description: 'Type the email' }],
    assertions: [{ order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'home' }, description: 'Home' }],
  });
  expect(parsed.success).toBe(true);
});

it('given_no_dataKeys_when_a_step_references_an_uncaptured_name_then_the_ir_is_rejected', () => {
  const parsed = TestIRSchema.safeParse({
    irVersion: IR_VERSION,
    id: 'x', name: 'Broken',
    provenance: { source: 'user', generatedAt: 0 },
    steps: [{ order: 0, action: 'type', locator: { preferredTier: 'testid', testid: 'email' }, value: '{{email}}', description: 'Type the email' }],
    assertions: [{ order: 0, kind: 'visible', locator: { preferredTier: 'testid', testid: 'home' }, description: 'Home' }],
  });
  expect(parsed.success).toBe(false);
});
```

Run: `npx vitest run test/unit/core/ir-bridge.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/test-gen/dataset.ts src/storage/schemas.ts src/core/ir/test-ir.ts test/unit/core/dataset.test.ts test/unit/core/ir-bridge.test.ts
git commit -m "feat(test-gen): parse CSV datasets and let IR reference their columns

Strict validation up front: an invalid column name would otherwise fail
silently at run time by typing the literal placeholder into a field."
```

---

### Task 9: Fan out execution over dataset rows

**Files:**
- Modify: `src/core/executor/test-executor.ts` (seed `capturedValues` at line ~592; fan out in `executeAllTests` at line ~255)
- Test: `test/unit/core/data-driven-execution.test.ts`

**Interfaces:**
- Consumes: `rowVariables`, `dataRowLabel` (Task 8).
- Produces: `ExecutionOptions.dataRowIndex?: number`; `expandDataDrivenCases(testCases: TestCase[]): DataRun[]` exported from `test-executor.ts`, where `DataRun = { testCase: TestCase; dataRowIndex?: number; label: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/data-driven-execution.test.ts
import { describe, it, expect } from 'vitest';
import { expandDataDrivenCases } from '../../../src/core/executor/test-executor';
import type { TestCase } from '../../../src/storage/schemas';

function tc(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc1', title: 'User can sign in', description: '', type: 'positive',
    source: 'generated', status: 'pending', createdAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('expandDataDrivenCases', () => {
  it('given_a_case_with_no_dataset_then_it_yields_exactly_one_run', () => {
    const runs = expandDataDrivenCases([tc()]);
    expect(runs).toHaveLength(1);
    expect(runs[0].dataRowIndex).toBeUndefined();
    expect(runs[0].label).toBe('User can sign in');
  });

  it('given_a_case_with_three_rows_then_it_yields_three_labelled_runs', () => {
    const runs = expandDataDrivenCases([
      tc({ dataSet: { columns: ['email'], rows: [['a@b.com'], ['c@d.com'], ['e@f.com']] } }),
    ]);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.dataRowIndex)).toEqual([0, 1, 2]);
    expect(runs[0].label).toBe('User can sign in [row 1: a@b.com]');
    expect(runs[2].label).toBe('User can sign in [row 3: e@f.com]');
  });

  it('given_a_dataset_with_zero_rows_then_it_yields_one_plain_run', () => {
    const runs = expandDataDrivenCases([tc({ dataSet: { columns: ['email'], rows: [] } })]);
    expect(runs).toHaveLength(1);
    expect(runs[0].dataRowIndex).toBeUndefined();
  });

  it('given_a_quarantined_case_then_it_is_excluded', () => {
    const runs = expandDataDrivenCases([tc({ quarantined: true }), tc({ id: 'tc2' })]);
    expect(runs.map((r) => r.testCase.id)).toEqual(['tc2']);
  });

  it('given_mixed_cases_then_order_is_preserved_and_rows_stay_adjacent', () => {
    const runs = expandDataDrivenCases([
      tc({ id: 'a', dataSet: { columns: ['v'], rows: [['1'], ['2']] } }),
      tc({ id: 'b' }),
    ]);
    expect(runs.map((r) => `${r.testCase.id}:${r.dataRowIndex ?? '-'}`)).toEqual(['a:0', 'a:1', 'b:-']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/data-driven-execution.test.ts`
Expected: FAIL — `expandDataDrivenCases` is not exported.

- [ ] **Step 3: Implement the fan-out and the seeding**

In `src/core/executor/test-executor.ts`, add the option to `ExecutionOptions`:

```ts
  /**
   * Row of `testCase.dataSet` this run uses. Its columns are seeded into the
   * captured-variable map before the step walk, so `{{column}}` resolves
   * through the existing substitution path rather than a parallel one.
   */
  dataRowIndex?: number;
```

Add the expansion helper near `executeAllTests`:

```ts
export interface DataRun {
  testCase: TestCase;
  dataRowIndex?: number;
  /** Title as it should appear in results — carries the row for a data run. */
  label: string;
}

/**
 * One entry per actual run: a plain test yields one, a test with N data rows
 * yields N. Quarantined tests are dropped here so every caller of the suite
 * runner inherits the exclusion rather than each remembering it.
 */
export function expandDataDrivenCases(testCases: TestCase[]): DataRun[] {
  const runs: DataRun[] = [];
  for (const testCase of testCases) {
    if (testCase.quarantined) continue;
    const rowCount = testCase.dataSet?.rows.length ?? 0;
    if (!testCase.dataSet || rowCount === 0) {
      runs.push({ testCase, label: testCase.title });
      continue;
    }
    for (let i = 0; i < rowCount; i++) {
      runs.push({
        testCase,
        dataRowIndex: i,
        label: `${testCase.title} [${dataRowLabel(testCase.dataSet, i)}]`,
      });
    }
  }
  return runs;
}
```

Seed the map where it is created (line ~592):

```ts
  const capturedValues = new Map<string, string>();
  // Data columns are seeded BEFORE the walk so `{{column}}` resolves through
  // `resolveStepVariables` exactly like a captured value. A capture step later
  // in the test may legitimately shadow a column; the dataset parser rejects
  // reserved names, so the only collisions possible are deliberate ones.
  if (testCase.dataSet && options.dataRowIndex !== undefined) {
    for (const [name, value] of rowVariables(testCase.dataSet, options.dataRowIndex)) {
      capturedValues.set(name, value);
    }
  }
```

In `executeAllTests`, replace the direct iteration over test cases with an iteration over `expandDataDrivenCases(...)`, passing `dataRowIndex` into the per-test `options` and using `run.label` for the result title.

> Implementer note: read `executeAllTests` (line 255 onward) fully before editing. It handles concurrency, `testCaseIds` ordering and `rerunAll`; the expansion must slot into the existing ordering logic, and `testCaseIds` filtering must happen *before* expansion so a selected test still fans out over all its rows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/data-driven-execution.test.ts test/unit/core/job-runner.test.ts test/integration/test-execution.test.ts && npm run typecheck`
Expected: PASS, and the existing execution tests unchanged.

- [ ] **Step 5: Add an end-to-end substitution test**

```ts
// append to test/integration/test-execution.test.ts
it('given_a_data_driven_test_when_executed_then_each_row_types_its_own_value', async () => {
  const typed: string[] = [];
  // Use the existing fake driver from this file's setup; record the values it
  // receives for `type` steps.
  const testCase = {
    /* built with this file's existing helper, plus: */
    dataSet: { columns: ['email'], rows: [['a@b.com'], ['c@d.com']] },
    preplan: [
      { order: 0, action: 'type', selector: '#email', value: '{{email}}', description: 'Type the email' },
      { order: 1, action: 'assert', assertType: 'visible', selector: '#ok', description: 'ok' },
    ],
  };

  for (const dataRowIndex of [0, 1]) {
    await executeTest(testCase as never, servicesForTest, tabId, { dataRowIndex });
  }
  expect(typed).toEqual(['a@b.com', 'c@d.com']);
});
```

> Implementer note: use the helpers and fake driver already present in `test/integration/test-execution.test.ts` — `servicesForTest`, `tabId` and the test-case builder above are placeholders for whatever that file already defines. Do not introduce a second driver.

Run: `npx vitest run test/integration/test-execution.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor/test-executor.ts test/unit/core/data-driven-execution.test.ts test/integration/test-execution.test.ts
git commit -m "feat(executor): run a test once per dataset row

Reuses the existing captured-variable substitution rather than adding a
parallel interpolation path. Quarantined tests are excluded during expansion so
every caller inherits it."
```

---

### Task 10: Dataset UI

**Files:**
- Modify: `src/sidepanel/components/tests/TestCaseInput.tsx`
- Modify: `src/sidepanel/components/tests/TestCaseList.tsx` (row-count badge)
- Modify: `src/sidepanel/stores/test-store.ts` (persist `dataSet`)
- Test: `test/unit/core/dataset-ui-state.test.ts`

**Interfaces:**
- Consumes: `parseDataSet` (Task 8).
- Produces: `attachDataSet(testCaseId: string, csv: string)` action on the test store.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/dataset-ui-state.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTestStore } from '../../../src/sidepanel/stores/test-store';

describe('attachDataSet', () => {
  beforeEach(() => {
    useTestStore.setState({
      testCases: [{
        id: 'tc1', title: 'Login', description: '', type: 'positive',
        source: 'user', status: 'pending', createdAt: '2026-09-10T00:00:00.000Z',
      }],
      datasetErrors: {},
    } as never);
  });

  it('given_valid_csv_then_the_dataset_is_attached_and_no_errors_recorded', async () => {
    await useTestStore.getState().attachDataSet('tc1', 'email\na@b.com\nc@d.com');
    const tc = useTestStore.getState().testCases.find((t) => t.id === 'tc1');
    expect(tc?.dataSet).toEqual({ columns: ['email'], rows: [['a@b.com'], ['c@d.com']] });
    expect(useTestStore.getState().datasetErrors['tc1']).toBeUndefined();
  });

  it('given_invalid_csv_then_errors_are_recorded_and_no_dataset_is_attached', async () => {
    await useTestStore.getState().attachDataSet('tc1', 'user email\na');
    const tc = useTestStore.getState().testCases.find((t) => t.id === 'tc1');
    expect(tc?.dataSet).toBeUndefined();
    expect(useTestStore.getState().datasetErrors['tc1']?.length).toBeGreaterThan(0);
  });

  it('given_an_unknown_test_case_id_then_it_is_a_no_op', async () => {
    await useTestStore.getState().attachDataSet('nope', 'a\n1');
    expect(useTestStore.getState().testCases).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/dataset-ui-state.test.ts`
Expected: FAIL — `attachDataSet` does not exist on the store.

- [ ] **Step 3: Implement the store action and the UI**

Add to `src/sidepanel/stores/test-store.ts`, following the file's existing action style and persistence calls:

```ts
  datasetErrors: Record<string, string[]>,

  attachDataSet: async (testCaseId: string, csv: string) => {
    const { dataSet, errors } = parseDataSet(csv);
    if (!dataSet) {
      set((s) => ({ datasetErrors: { ...s.datasetErrors, [testCaseId]: errors } }));
      return;
    }
    const testCase = get().testCases.find((t) => t.id === testCaseId);
    if (!testCase) return;
    const updated = { ...testCase, dataSet };
    await testCaseDB.put(updated);
    set((s) => ({
      testCases: s.testCases.map((t) => (t.id === testCaseId ? updated : t)),
      datasetErrors: { ...s.datasetErrors, [testCaseId]: undefined },
    }));
  },
```

> Implementer note: match the store's real persistence call — read how an existing action such as the one that updates a test case's status writes to IndexedDB, and use that same call rather than `testCaseDB.put` if the name differs.

In `TestCaseInput.tsx`, add a collapsed "Test data (CSV)" textarea. On blur, call `attachDataSet`. Render `datasetErrors[testCaseId]` beneath it as a list — a rejected sheet must say why, since silent rejection is exactly what the strict parser exists to avoid.

In `TestCaseList.tsx`, when `testCase.dataSet` is present, render a badge reading `{rows} rows` using the existing `Badge` component.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/dataset-ui-state.test.ts && npm run typecheck && npm run lint && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Manual verification**

```bash
npm run build:chrome
```
Reload the extension, open Tests, paste `email,password` + two rows onto a test, confirm the `2 rows` badge, run it, and confirm two results appear with `[row 1: …]` / `[row 2: …]` in their titles.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/stores/test-store.ts src/sidepanel/components/tests test/unit/core/dataset-ui-state.test.ts
git commit -m "feat(ui): attach CSV test data to a test case

Parse errors are shown inline — a rejected sheet has to say why, or strict
validation just looks like the feature not working."
```

---
# Feature F5 — Pre-acceptance stability gate

### Task 11: Stability gate

**Files:**
- Create: `src/core/executor/stability-gate.ts`
- Test: `test/unit/core/stability-gate.test.ts`

**Interfaces:**
- Consumes: `detectFlakes` from `src/core/reporting/flake-detector.ts:35`; `TestResult`, `TestCase` from schemas; `TestCase.quarantined` (Task 8).
- Produces:
  - `type StabilityVerdict = 'stable' | 'unstable' | 'failing'`
  - `interface GateReport { verdict: StabilityVerdict; runs: TestResult[]; flake: FlakeStats; quarantine: boolean; summary: string }`
  - `runStabilityGate(args: GateArgs): Promise<GateReport>` where `GateArgs = { testCase: TestCase; attempts?: number; run: (attempt: number) => Promise<TestResult>; signal?: AbortSignal }`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/stability-gate.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runStabilityGate } from '../../../src/core/executor/stability-gate';
import type { TestCase, TestResult } from '../../../src/storage/schemas';

const testCase: TestCase = {
  id: 'tc1', title: 'User can sign in', description: '', type: 'positive',
  source: 'generated', status: 'pending', createdAt: '2026-09-10T00:00:00.000Z',
};

function result(status: TestResult['status'], i: number): TestResult {
  return {
    id: `r${i}`,
    testCaseId: 'tc1',
    testCaseTitle: 'User can sign in',
    status,
    startedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    duration: 100,
    stepResults: [],
  } as TestResult;
}

/** Runner that replays a fixed sequence of outcomes. */
function runnerFor(sequence: Array<TestResult['status']>) {
  return vi.fn(async (attempt: number) => result(sequence[attempt], attempt));
}

describe('runStabilityGate', () => {
  it('given_three_passes_then_verdict_is_stable_and_not_quarantined', async () => {
    const report = await runStabilityGate({ testCase, run: runnerFor(['passed', 'passed', 'passed']) });
    expect(report.verdict).toBe('stable');
    expect(report.quarantine).toBe(false);
    expect(report.runs).toHaveLength(3);
  });

  it('given_pass_fail_pass_then_verdict_is_unstable_and_quarantined', async () => {
    const report = await runStabilityGate({ testCase, run: runnerFor(['passed', 'failed', 'passed']) });
    expect(report.verdict).toBe('unstable');
    expect(report.quarantine).toBe(true);
  });

  // All-failing is a broken test, not a flaky one. Quarantine would hide it;
  // the user needs to see it fail.
  it('given_three_failures_then_verdict_is_failing_and_not_quarantined', async () => {
    const report = await runStabilityGate({ testCase, run: runnerFor(['failed', 'failed', 'failed']) });
    expect(report.verdict).toBe('failing');
    expect(report.quarantine).toBe(false);
  });

  it('given_an_error_outcome_mixed_with_a_pass_then_verdict_is_unstable', async () => {
    const report = await runStabilityGate({ testCase, run: runnerFor(['passed', 'error', 'passed']) });
    expect(report.verdict).toBe('unstable');
  });

  it('given_attempts_of_one_then_one_run_and_no_flake_judgement', async () => {
    const run = runnerFor(['passed']);
    const report = await runStabilityGate({ testCase, attempts: 1, run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.verdict).toBe('stable');
    expect(report.quarantine).toBe(false);
  });

  it('given_attempts_of_five_then_it_runs_five_times', async () => {
    const run = runnerFor(['passed', 'passed', 'passed', 'passed', 'passed']);
    await runStabilityGate({ testCase, attempts: 5, run });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it('given_an_aborted_signal_then_it_stops_early_and_judges_what_it_has', async () => {
    const controller = new AbortController();
    const run = vi.fn(async (attempt: number) => {
      if (attempt === 1) controller.abort();
      return result('passed', attempt);
    });
    const report = await runStabilityGate({ testCase, attempts: 5, run, signal: controller.signal });
    expect(run.mock.calls.length).toBeLessThan(5);
    expect(report.runs.length).toBeGreaterThan(0);
  });

  it('given_a_verdict_then_the_summary_names_the_outcome_counts', async () => {
    const report = await runStabilityGate({ testCase, run: runnerFor(['passed', 'failed', 'passed']) });
    expect(report.summary).toMatch(/2 passed/);
    expect(report.summary).toMatch(/1 failed/);
  });

  it('given_a_runner_that_throws_then_the_attempt_counts_as_an_error_not_a_crash', async () => {
    const run = vi.fn(async (attempt: number) => {
      if (attempt === 1) throw new Error('tab closed');
      return result('passed', attempt);
    });
    const report = await runStabilityGate({ testCase, run });
    expect(report.runs).toHaveLength(3);
    expect(report.runs[1].status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/stability-gate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/executor/stability-gate.ts
/**
 * Pre-acceptance stability gate.
 *
 * `reporting/flake-detector.ts` answers "has this test been flaky?" from
 * history — which only helps after a flaky test has already polluted several
 * runs. The trust problem with a freshly generated test is different: is it
 * repeatable AT ALL? Running it N times back to back and judging the spread
 * answers that before anyone relies on it.
 *
 * The distinction that matters is unstable vs failing. A test that fails every
 * time is broken and must stay visible. A test that disagrees with itself is
 * untrustworthy and is quarantined — kept, excluded from suite runs, and
 * flagged for a human. Conflating the two would hide real breakage.
 *
 * The runner is injected: this module performs no execution and no persistence,
 * so it is testable without a browser.
 */
import type { TestCase, TestResult } from '../../storage/schemas';
import { detectFlakes, type FlakeStats } from '../reporting/flake-detector';
import { createLogger } from '../../utils/logger';

const log = createLogger('stability-gate');

/** Three is the smallest N that can distinguish "flaky" from "just failed". */
const DEFAULT_ATTEMPTS = 3;

export type StabilityVerdict = 'stable' | 'unstable' | 'failing';

export interface GateReport {
  verdict: StabilityVerdict;
  runs: TestResult[];
  flake: FlakeStats;
  /** True only for `unstable`. A failing test must stay visible, not be hidden. */
  quarantine: boolean;
  summary: string;
}

export interface GateArgs {
  testCase: TestCase;
  /** Number of back-to-back runs. Default 3. */
  attempts?: number;
  /** Executes one attempt. Injected so the gate needs no browser to test. */
  run: (attempt: number) => Promise<TestResult>;
  signal?: AbortSignal;
}

function errorResult(testCase: TestCase, attempt: number, err: unknown): TestResult {
  return {
    id: `gate-${testCase.id}-${attempt}`,
    testCaseId: testCase.id,
    testCaseTitle: testCase.title,
    status: 'error',
    startedAt: new Date().toISOString(),
    duration: 0,
    stepResults: [],
    errorMessage: err instanceof Error ? err.message : String(err),
  } as TestResult;
}

function verdictFor(runs: TestResult[]): StabilityVerdict {
  const passed = runs.filter((r) => r.status === 'passed').length;
  if (passed === runs.length) return 'stable';
  if (passed === 0) return 'failing';
  return 'unstable';
}

function summarize(runs: TestResult[], verdict: StabilityVerdict): string {
  const count = (status: TestResult['status']) => runs.filter((r) => r.status === status).length;
  const parts = [
    `${count('passed')} passed`,
    `${count('failed')} failed`,
    `${count('error')} errored`,
  ];
  return `${verdict} over ${runs.length} run(s): ${parts.join(', ')}`;
}

export async function runStabilityGate(args: GateArgs): Promise<GateReport> {
  const attempts = Math.max(1, args.attempts ?? DEFAULT_ATTEMPTS);
  const runs: TestResult[] = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      runs.push(await args.run(attempt));
    } catch (err) {
      log.warn(`Stability attempt ${attempt + 1} threw`, err);
      runs.push(errorResult(args.testCase, attempt, err));
    }
    if (args.signal?.aborted) {
      log.info(`Stability gate aborted after ${runs.length} run(s)`);
      break;
    }
  }

  const verdict = verdictFor(runs);
  return {
    verdict,
    runs,
    flake: detectFlakes(args.testCase.id, runs),
    quarantine: verdict === 'unstable',
    summary: summarize(runs, verdict),
  };
}
```

> Implementer note: `TestResult` has required fields beyond those in `errorResult` above. Read `src/storage/schemas.ts:632` and populate every required field properly rather than leaning on the `as TestResult` cast — remove the cast once the object is complete.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/core/stability-gate.test.ts test/unit/core/flake-detector.test.ts && npm run typecheck && npm run lint`
Expected: PASS (10 new tests, flake-detector unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/core/executor/stability-gate.ts test/unit/core/stability-gate.test.ts
git commit -m "feat(executor): add a run-N-times stability gate

Distinguishes unstable from failing: a self-disagreeing test is quarantined, a
consistently failing one stays visible."
```

---

### Task 12: Wire the gate into the UI

**Files:**
- Modify: `src/sidepanel/components/tests/TestPanel.tsx` (a "Check stability" action per test)
- Modify: `src/sidepanel/components/tests/TestCaseList.tsx` (quarantine badge + clear)
- Modify: `src/sidepanel/stores/test-store.ts` (`checkStability`, `setQuarantined`)
- Test: `test/unit/core/stability-gate-store.test.ts`

**Interfaces:**
- Consumes: `runStabilityGate` (Task 11).
- Produces: `checkStability(testCaseId: string, attempts?: number): Promise<GateReport | undefined>` and `setQuarantined(testCaseId: string, value: boolean): Promise<void>` on the test store.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/stability-gate-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useTestStore } from '../../../src/sidepanel/stores/test-store';

describe('setQuarantined', () => {
  beforeEach(() => {
    useTestStore.setState({
      testCases: [{
        id: 'tc1', title: 'Login', description: '', type: 'positive',
        source: 'user', status: 'pending', createdAt: '2026-09-10T00:00:00.000Z',
      }],
    } as never);
  });

  it('given_a_test_case_when_quarantined_then_the_flag_persists_in_state', async () => {
    await useTestStore.getState().setQuarantined('tc1', true);
    expect(useTestStore.getState().testCases[0].quarantined).toBe(true);
  });

  it('given_a_quarantined_case_when_cleared_then_the_flag_is_false', async () => {
    await useTestStore.getState().setQuarantined('tc1', true);
    await useTestStore.getState().setQuarantined('tc1', false);
    expect(useTestStore.getState().testCases[0].quarantined).toBe(false);
  });

  it('given_an_unknown_id_then_it_is_a_no_op', async () => {
    await useTestStore.getState().setQuarantined('nope', true);
    expect(useTestStore.getState().testCases[0].quarantined).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/stability-gate-store.test.ts`
Expected: FAIL — `setQuarantined` does not exist.

- [ ] **Step 3: Implement the store actions and UI**

Add both actions to `src/sidepanel/stores/test-store.ts`. `setQuarantined` mirrors the persistence pattern of `attachDataSet` from Task 10. `checkStability` calls `runStabilityGate` with a `run` closure that invokes whatever the store already uses to execute one test, then applies `report.quarantine` via `setQuarantined` and stores `report.summary` for display.

In `TestCaseList.tsx`, when `testCase.quarantined` is true render an amber `Badge` reading `Quarantined` with a click action calling `setQuarantined(id, false)`, and title it with the stored summary so the reason is visible.

In `TestPanel.tsx`, add a per-test "Check stability" button that calls `checkStability(id)` and shows the returned `summary`.

> Implementer note: read how `TestPanel.tsx` currently triggers a single-test run and reuse that exact path inside the `run` closure. Do not open a second execution path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/stability-gate-store.test.ts && npm run typecheck && npm run lint && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add src/sidepanel test/unit/core/stability-gate-store.test.ts
git commit -m "feat(ui): expose the stability gate and quarantine state

Quarantine is reversible from the list and carries its reason in the tooltip."
```

---

# Feature F6 — Resume from last good step

### Task 13: `startFromStep` execution option

**Files:**
- Modify: `src/core/executor/test-executor.ts` (`ExecutionOptions` and the step walk at line ~592 onward)
- Test: `test/unit/core/resume-from-step.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ExecutionOptions.startFromStep?: number`
  - `skippedPrefix(steps: ExecutionStep[], startFromStep: number): StepResult[]` exported from `test-executor.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/resume-from-step.test.ts
import { describe, it, expect } from 'vitest';
import { skippedPrefix } from '../../../src/core/executor/test-executor';
import type { ExecutionStep } from '../../../src/storage/schemas';

const steps: ExecutionStep[] = [
  { order: 0, action: 'navigate', value: 'https://x/', description: 'Open' },
  { order: 1, action: 'type', selector: '#a', value: 'v', description: 'Type' },
  { order: 2, action: 'click', selector: '#b', description: 'Click' },
  { order: 3, action: 'assert', assertType: 'visible', selector: '#c', description: 'Assert' },
];

describe('skippedPrefix', () => {
  // Marked skipped, never passed. A resumed run must not claim it verified
  // steps it did not execute — that would turn a debugging aid into a false
  // green result.
  it('given_start_from_two_then_steps_zero_and_one_are_skipped', () => {
    const prefix = skippedPrefix(steps, 2);
    expect(prefix).toHaveLength(2);
    expect(prefix.every((r) => r.status === 'skipped')).toBe(true);
    expect(prefix.map((r) => r.step.order)).toEqual([0, 1]);
  });

  it('given_skipped_results_then_each_carries_a_reason', () => {
    expect(skippedPrefix(steps, 1)[0].error).toMatch(/resum/i);
  });

  it('given_start_from_zero_then_nothing_is_skipped', () => {
    expect(skippedPrefix(steps, 0)).toEqual([]);
  });

  it('given_start_from_beyond_the_last_step_then_all_are_skipped', () => {
    expect(skippedPrefix(steps, 99)).toHaveLength(4);
  });

  it('given_a_negative_start_then_nothing_is_skipped', () => {
    expect(skippedPrefix(steps, -3)).toEqual([]);
  });

  it('given_unsorted_steps_then_the_prefix_is_chosen_by_order_not_array_position', () => {
    const shuffled = [steps[2], steps[0], steps[3], steps[1]];
    expect(skippedPrefix(shuffled, 2).map((r) => r.step.order)).toEqual([0, 1]);
  });

  it('given_skipped_results_then_duration_is_zero', () => {
    expect(skippedPrefix(steps, 2).every((r) => r.duration === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/resume-from-step.test.ts`
Expected: FAIL — `skippedPrefix` is not exported.

- [ ] **Step 3: Implement the option**

Add to `ExecutionOptions` in `src/core/executor/test-executor.ts`:

```ts
  /**
   * Begin at this step order, recording every earlier step as `skipped`.
   *
   * For debugging a long scenario: replaying 27 steps to reach step 28 is the
   * single slowest part of the authoring loop. Earlier steps are marked skipped
   * rather than passed — a resumed run must never claim it verified something it
   * did not execute.
   *
   * The run still navigates to `startUrl` first, so it begins from a defined
   * state rather than whatever the tab happened to be showing.
   */
  startFromStep?: number;
```

Add the helper:

```ts
export function skippedPrefix(steps: ExecutionStep[], startFromStep: number): StepResult[] {
  if (startFromStep <= 0) return [];
  return [...steps]
    .sort((a, b) => a.order - b.order)
    .filter((step) => step.order < startFromStep)
    .map((step) => ({
      step,
      status: 'skipped' as const,
      duration: 0,
      error: `Skipped — run resumed from step ${startFromStep}`,
    }));
}
```

In the step walk, seed `stepResults` with `skippedPrefix(plan.steps, options.startFromStep ?? 0)` and skip any step whose `order < (options.startFromStep ?? 0)`.

> Implementer note: read the walk from line 592 to 830 first. Three things must be handled: (a) `previousStep` must not be seeded from a skipped step, or the post-step settle delay will be computed from a step that never ran; (b) the `startUrl` navigation that already happens for isolation must still run; (c) captured variables produced by skipped `capture` steps will be absent, so a resumed run that references one fails with a clear message — add that message rather than letting the literal `{{name}}` be typed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/resume-from-step.test.ts test/integration/test-execution.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Add an execution-level test**

```ts
// append to test/integration/test-execution.test.ts
it('given_start_from_step_two_when_executed_then_the_first_dispatch_is_step_two', async () => {
  const dispatched: number[] = [];
  // Record orders the driver actually receives, using this file's fake driver.
  const result = await executeTest(fourStepTestCase, servicesForTest, tabId, { startFromStep: 2 });
  expect(dispatched[0]).toBe(2);
  expect(result.stepResults.slice(0, 2).map((r) => r.status)).toEqual(['skipped', 'skipped']);
});
```

> Implementer note: `fourStepTestCase`, `servicesForTest` and `tabId` stand in for this file's existing fixtures — use the real ones.

Run: `npx vitest run test/integration/test-execution.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/executor/test-executor.ts test/unit/core/resume-from-step.test.ts test/integration/test-execution.test.ts
git commit -m "feat(executor): resume a test run from a given step

Skipped steps are recorded as skipped, never passed, so a resumed run cannot
report a false green."
```

---

### Task 14: "Resume from here" in the results UI

**Files:**
- Modify: `src/sidepanel/components/results/FailureDetail.tsx`
- Modify: `src/sidepanel/components/results/ExecutionTimeline.tsx`
- Modify: `src/sidepanel/components/tests/RetryTestModal.tsx`
- Test: `test/unit/core/resume-target.test.ts`

**Interfaces:**
- Consumes: `TestResult.stepResults`.
- Produces: `firstFailingStepOrder(result: TestResult): number | undefined` in `src/core/report/result-adapter.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/resume-target.test.ts
import { describe, it, expect } from 'vitest';
import { firstFailingStepOrder } from '../../../src/core/report/result-adapter';
import type { TestResult, StepResult } from '../../../src/storage/schemas';

function res(statuses: Array<StepResult['status']>): TestResult {
  return {
    id: 'r1', testCaseId: 'tc1', testCaseTitle: 'T', status: 'failed',
    startedAt: '2026-09-10T00:00:00.000Z', duration: 1,
    stepResults: statuses.map((status, order) => ({
      step: { order, action: 'click', selector: '#x', description: `step ${order}` },
      status,
      duration: 1,
    })),
  } as TestResult;
}

describe('firstFailingStepOrder', () => {
  it('given_a_failure_at_step_two_then_returns_two', () => {
    expect(firstFailingStepOrder(res(['passed', 'passed', 'failed']))).toBe(2);
  });

  it('given_all_passed_then_returns_undefined', () => {
    expect(firstFailingStepOrder(res(['passed', 'passed']))).toBeUndefined();
  });

  it('given_two_failures_then_returns_the_earlier_one', () => {
    expect(firstFailingStepOrder(res(['passed', 'failed', 'failed']))).toBe(1);
  });

  it('given_a_skipped_prefix_then_skipped_steps_are_not_treated_as_failures', () => {
    expect(firstFailingStepOrder(res(['skipped', 'skipped', 'failed']))).toBe(2);
  });

  it('given_no_step_results_then_returns_undefined', () => {
    const empty = { ...res([]), stepResults: [] };
    expect(firstFailingStepOrder(empty)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/resume-target.test.ts`
Expected: FAIL — `firstFailingStepOrder` is not exported.

- [ ] **Step 3: Implement**

Add to `src/core/report/result-adapter.ts`:

```ts
/**
 * Order of the earliest failing step — the resume point for a debugging re-run.
 *
 * `skipped` is deliberately not a failure: a result that was itself produced by
 * a resumed run carries a skipped prefix, and treating those as failures would
 * walk the resume point backwards on every re-run.
 */
export function firstFailingStepOrder(result: TestResult): number | undefined {
  const failing = result.stepResults
    .filter((r) => r.status === 'failed')
    .map((r) => r.step.order)
    .sort((a, b) => a - b);
  return failing[0];
}
```

In `FailureDetail.tsx` and `ExecutionTimeline.tsx`, render a "Resume from here" button on the failing step which re-runs the test with `{ startFromStep: order }`. In `RetryTestModal.tsx`, default the resume point to `firstFailingStepOrder(result)` and let the user change it, since the true last-good state may be earlier than the first failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/resume-target.test.ts test/unit/core/result-adapter.test.ts && npm run typecheck && npm run lint && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add src/core/report/result-adapter.ts src/sidepanel/components test/unit/core/resume-target.test.ts
git commit -m "feat(ui): resume a failed test from its failing step"
```

---

# Feature F4 — TestRail sync

### Task 15: TestRail REST client

**Files:**
- Create: `src/core/integrations/testrail-client.ts`
- Test: `test/unit/core/testrail-client.test.ts`

**Interfaces:**
- Consumes: nothing (uses `fetch`).
- Produces:
  - `interface TestRailConfig { host: string; email: string; apiKey: string }`
  - `interface TestRailTest { id: number; caseId: number; title: string; steps: string[] }`
  - `TESTRAIL_STATUS: Readonly<Record<'passed'|'blocked'|'untested'|'retest'|'failed', number>>`
  - `createTestRailClient(config: TestRailConfig, fetchImpl?: typeof fetch)` returning `{ getTests(runId: number): Promise<TestRailTest[]>; addResultForCase(runId: number, caseId: number, body: ResultBody): Promise<{ id: number }>; addAttachmentToResult(resultId: number, png: Blob, filename: string): Promise<{ id: number }> }`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/testrail-client.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  createTestRailClient,
  TESTRAIL_STATUS,
} from '../../../src/core/integrations/testrail-client';

const config = { host: 'https://acme.testrail.io', email: 'qa@acme.com', apiKey: 'KEY' };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('TESTRAIL_STATUS', () => {
  it('given_the_map_then_it_matches_testrail_defaults', () => {
    expect(TESTRAIL_STATUS).toEqual({ passed: 1, blocked: 2, untested: 3, retest: 4, failed: 5 });
  });
});

describe('getTests', () => {
  it('given_a_run_id_then_it_calls_get_tests_with_basic_auth', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tests: [] }));
    await createTestRailClient(config, fetchImpl).getTests(42);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/get_tests/42');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa('qa@acme.com:KEY')}`);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('given_a_paginated_v2_response_then_tests_are_read_from_the_tests_key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      tests: [{ id: 7, case_id: 900, title: 'Sign in', custom_steps_separated: [
        { content: 'Open the login page', expected: 'Login form shows' },
        { content: 'Enter credentials', expected: 'Home page shows' },
      ] }],
    }));
    const tests = await createTestRailClient(config, fetchImpl).getTests(42);
    expect(tests).toEqual([{
      id: 7, caseId: 900, title: 'Sign in',
      steps: ['Open the login page', 'Enter credentials'],
    }]);
  });

  // Older TestRail returns a bare array. Both shapes must work or import
  // silently yields nothing on one of them.
  it('given_a_legacy_array_response_then_it_is_still_parsed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([
      { id: 8, case_id: 901, title: 'Sign out', custom_steps: 'Click sign out\nConfirm' },
    ]));
    const tests = await createTestRailClient(config, fetchImpl).getTests(42);
    expect(tests).toEqual([{ id: 8, caseId: 901, title: 'Sign out', steps: ['Click sign out', 'Confirm'] }]);
  });

  it('given_a_test_with_no_steps_then_steps_is_empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tests: [{ id: 9, case_id: 902, title: 'Bare' }] }));
    const tests = await createTestRailClient(config, fetchImpl).getTests(42);
    expect(tests[0].steps).toEqual([]);
  });

  it('given_a_401_then_it_throws_a_message_naming_the_credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Authentication failed' }, 401));
    await expect(createTestRailClient(config, fetchImpl).getTests(42))
      .rejects.toThrow(/TestRail email or API key/i);
  });

  it('given_a_404_then_it_throws_a_message_naming_the_run_id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));
    await expect(createTestRailClient(config, fetchImpl).getTests(42))
      .rejects.toThrow(/run 42/i);
  });

  it('given_a_trailing_slash_on_the_host_then_the_url_has_no_double_slash', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ tests: [] }));
    await createTestRailClient({ ...config, host: 'https://acme.testrail.io/' }, fetchImpl).getTests(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://acme.testrail.io/index.php?/api/v2/get_tests/1');
  });
});

describe('addResultForCase', () => {
  it('given_a_result_then_it_posts_to_add_result_for_case', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 555 }));
    const out = await createTestRailClient(config, fetchImpl)
      .addResultForCase(42, 900, { status_id: TESTRAIL_STATUS.failed, comment: 'boom', elapsed: '3s' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/add_result_for_case/42/900');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      status_id: 5, comment: 'boom', elapsed: '3s',
    });
    expect(out).toEqual({ id: 555 });
  });
});

describe('addAttachmentToResult', () => {
  it('given_a_png_then_it_posts_multipart_without_a_json_content_type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 12 }));
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    await createTestRailClient(config, fetchImpl).addAttachmentToResult(555, blob, 'fail.png');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://acme.testrail.io/index.php?/api/v2/add_attachment_to_result/555');
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
    // The browser must set the multipart boundary itself.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers.Authorization).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/testrail-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/integrations/testrail-client.ts
/**
 * TestRail REST transport.
 *
 * Called directly from the extension with the user's own email and API key —
 * ADR-002 unchanged, no proxy. `fetch` is injected so the whole client is
 * testable without a network or a TestRail instance.
 *
 * Two response shapes are handled on purpose: TestRail 6.7+ wraps collections
 * (`{ tests: [...] }`) while older instances return a bare array. Supporting one
 * shape would make import silently return nothing on the other, which reads as
 * "the feature is broken" rather than "your instance is older".
 */
export interface TestRailConfig {
  /** e.g. https://acme.testrail.io — with or without a trailing slash. */
  host: string;
  email: string;
  apiKey: string;
}

export interface TestRailTest {
  /** Test instance id within the run — what an attachment attaches against. */
  id: number;
  /** Case id — what a result is filed against. */
  caseId: number;
  title: string;
  steps: string[];
}

export interface ResultBody {
  status_id: number;
  comment?: string;
  /** TestRail duration format, e.g. '30s', '2m 15s'. Never '0s' — it is rejected. */
  elapsed?: string;
}

/** TestRail's default status ids. Custom statuses start at 6. */
export const TESTRAIL_STATUS = {
  passed: 1,
  blocked: 2,
  untested: 3,
  retest: 4,
  failed: 5,
} as const;

interface RawTest {
  id?: number;
  case_id?: number;
  title?: string;
  custom_steps?: string;
  custom_steps_separated?: Array<{ content?: string; expected?: string }>;
}

function endpoint(host: string, method: string): string {
  return `${host.replace(/\/+$/, '')}/index.php?/api/v2/${method}`;
}

function authHeader(config: TestRailConfig): string {
  return `Basic ${btoa(`${config.email}:${config.apiKey}`)}`;
}

/** Turn a transport failure into a message that says what to fix. */
async function failure(response: Response, context: string): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    return new Error(`TestRail rejected the credentials — check the TestRail email or API key (${response.status}).`);
  }
  if (response.status === 404) {
    return new Error(`TestRail could not find ${context} (404). Check the id and that the account can see it.`);
  }
  const body = await response.text().catch(() => '');
  return new Error(`TestRail request failed for ${context}: ${response.status} ${body.slice(0, 200)}`);
}

function stepsOf(raw: RawTest): string[] {
  if (Array.isArray(raw.custom_steps_separated)) {
    return raw.custom_steps_separated
      .map((s) => (s.content ?? '').trim())
      .filter((s) => s.length > 0);
  }
  if (typeof raw.custom_steps === 'string') {
    return raw.custom_steps.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function unwrapTests(payload: unknown): RawTest[] {
  if (Array.isArray(payload)) return payload as RawTest[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as { tests?: unknown }).tests)) {
    return (payload as { tests: RawTest[] }).tests;
  }
  return [];
}

export function createTestRailClient(config: TestRailConfig, fetchImpl: typeof fetch = fetch) {
  const jsonHeaders = { Authorization: authHeader(config), 'Content-Type': 'application/json' };

  return {
    async getTests(runId: number): Promise<TestRailTest[]> {
      const response = await fetchImpl(endpoint(config.host, `get_tests/${runId}`), {
        method: 'GET',
        headers: jsonHeaders,
      });
      if (!response.ok) throw await failure(response, `run ${runId}`);
      return unwrapTests(await response.json()).map((raw) => ({
        id: raw.id ?? 0,
        caseId: raw.case_id ?? 0,
        title: raw.title ?? '(untitled)',
        steps: stepsOf(raw),
      }));
    },

    async addResultForCase(runId: number, caseId: number, body: ResultBody): Promise<{ id: number }> {
      const response = await fetchImpl(endpoint(config.host, `add_result_for_case/${runId}/${caseId}`), {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw await failure(response, `case ${caseId} in run ${runId}`);
      const parsed = (await response.json()) as { id?: number };
      return { id: parsed.id ?? 0 };
    },

    async addAttachmentToResult(resultId: number, png: Blob, filename: string): Promise<{ id: number }> {
      const form = new FormData();
      form.append('attachment', png, filename);
      const response = await fetchImpl(endpoint(config.host, `add_attachment_to_result/${resultId}`), {
        method: 'POST',
        // No Content-Type: the browser must set the multipart boundary itself.
        headers: { Authorization: authHeader(config) },
        body: form,
      });
      if (!response.ok) throw await failure(response, `result ${resultId}`);
      const parsed = (await response.json()) as { id?: number };
      return { id: parsed.id ?? 0 };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/core/testrail-client.test.ts && npm run typecheck && npm run lint`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/integrations/testrail-client.ts test/unit/core/testrail-client.test.ts
git commit -m "feat(integrations): add a TestRail REST client

fetch is injected so the client is fully testable offline. Handles both the
wrapped and legacy collection response shapes."
```

---

### Task 16: TestRail ⇄ Pathfinder mapping

**Files:**
- Create: `src/core/integrations/testrail-sync.ts`
- Test: `test/unit/core/testrail-sync.test.ts`

**Interfaces:**
- Consumes: `createTestRailClient`, `TestRailTest`, `TESTRAIL_STATUS` (Task 15); `TestCase`, `TestResult` from schemas.
- Produces:
  - `importRunAsTestCases(tests: TestRailTest[], runId: number): TestCase[]`
  - `interface PushSummary { pushed: number; attached: number; failures: Array<{ caseId: number; error: string }> }`
  - `pushResultsToTestRail(args: PushArgs): Promise<PushSummary>` where `PushArgs = { runId: number; results: TestResult[]; client: TestRailClient; caseIdFor: (result: TestResult) => number | undefined }`
  - `formatElapsed(ms: number): string | undefined`
  - `statusIdFor(status: TestResult['status']): number`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/testrail-sync.test.ts
import { describe, it, expect, vi } from 'vitest';
import {
  importRunAsTestCases,
  pushResultsToTestRail,
  formatElapsed,
  statusIdFor,
} from '../../../src/core/integrations/testrail-sync';
import type { TestResult } from '../../../src/storage/schemas';

function result(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'r1', testCaseId: 'tc1', testCaseTitle: 'Sign in', status: 'passed',
    startedAt: '2026-09-10T00:00:00.000Z', duration: 3200, stepResults: [],
    ...overrides,
  } as TestResult;
}

describe('statusIdFor', () => {
  it.each([
    ['passed', 1],
    ['failed', 5],
    ['error', 5],
    ['running', 4],
  ] as const)('given_%s_then_status_id_is_%i', (status, id) => {
    expect(statusIdFor(status as TestResult['status'])).toBe(id);
  });
});

describe('formatElapsed', () => {
  it('given_3200ms_then_3s', () => expect(formatElapsed(3200)).toBe('3s'));
  it('given_135000ms_then_2m_15s', () => expect(formatElapsed(135000)).toBe('2m 15s'));
  it('given_120000ms_then_2m', () => expect(formatElapsed(120000)).toBe('2m'));
  // TestRail rejects '0s', so a sub-second run must send nothing at all.
  it('given_400ms_then_undefined', () => expect(formatElapsed(400)).toBeUndefined());
  it('given_zero_then_undefined', () => expect(formatElapsed(0)).toBeUndefined());
});

describe('importRunAsTestCases', () => {
  it('given_testrail_tests_then_maps_them_to_test_cases_with_steps', () => {
    const cases = importRunAsTestCases(
      [{ id: 7, caseId: 900, title: 'Sign in', steps: ['Open login', 'Enter credentials'] }],
      42
    );
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('Sign in');
    expect(cases[0].steps).toEqual(['Open login', 'Enter credentials']);
    expect(cases[0].source).toBe('user');
    expect(cases[0].status).toBe('pending');
  });

  it('given_a_test_then_the_id_encodes_the_run_and_case_so_re_import_is_idempotent', () => {
    const first = importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42);
    const second = importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42);
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toContain('900');
    expect(first[0].id).toContain('42');
  });

  it('given_a_test_with_no_steps_then_steps_is_undefined_not_an_empty_array', () => {
    // An empty array would read as "a test with zero steps"; absent means
    // "needs expansion", which is what the one-line runner acts on.
    expect(importRunAsTestCases([{ id: 7, caseId: 900, title: 'A', steps: [] }], 42)[0].steps)
      .toBeUndefined();
  });
});

describe('pushResultsToTestRail', () => {
  function clientStub() {
    return {
      getTests: vi.fn(),
      addResultForCase: vi.fn(async () => ({ id: 555 })),
      addAttachmentToResult: vi.fn(async () => ({ id: 12 })),
    };
  }

  it('given_two_results_then_one_result_is_posted_per_case', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result(), result({ id: 'r2', testCaseId: 'tc2' })],
      client: client as never,
      caseIdFor: (r) => (r.testCaseId === 'tc1' ? 900 : 901),
    });
    expect(client.addResultForCase).toHaveBeenCalledTimes(2);
    expect(summary.pushed).toBe(2);
    expect(summary.failures).toEqual([]);
  });

  it('given_a_failure_with_a_screenshot_then_the_png_is_attached_to_the_result', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'failed', errorMessage: 'not found', screenshot: 'AAAA' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addAttachmentToResult).toHaveBeenCalledTimes(1);
    expect(client.addAttachmentToResult.mock.calls[0][0]).toBe(555);
    expect(summary.attached).toBe(1);
  });

  it('given_a_pass_with_a_screenshot_then_nothing_is_attached', async () => {
    const client = clientStub();
    await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'passed', screenshot: 'AAAA' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addAttachmentToResult).not.toHaveBeenCalled();
  });

  it('given_a_result_with_no_mapped_case_id_then_it_is_skipped_and_reported', async () => {
    const client = clientStub();
    const summary = await pushResultsToTestRail({
      runId: 42, results: [result()], client: client as never, caseIdFor: () => undefined,
    });
    expect(client.addResultForCase).not.toHaveBeenCalled();
    expect(summary.pushed).toBe(0);
    expect(summary.failures[0].error).toMatch(/no TestRail case/i);
  });

  it('given_the_error_message_then_it_is_included_in_the_comment', async () => {
    const client = clientStub();
    await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'failed', errorMessage: 'element #save not found' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(client.addResultForCase.mock.calls[0][2].comment).toContain('element #save not found');
  });

  // One bad case must not abandon the rest of the run's results.
  it('given_one_post_throws_then_the_others_still_push_and_the_failure_is_reported', async () => {
    const client = clientStub();
    client.addResultForCase.mockImplementationOnce(async () => { throw new Error('500'); });
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result(), result({ id: 'r2', testCaseId: 'tc2' })],
      client: client as never,
      caseIdFor: (r) => (r.testCaseId === 'tc1' ? 900 : 901),
    });
    expect(summary.pushed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].caseId).toBe(900);
  });

  it('given_an_attachment_that_fails_then_the_result_still_counts_as_pushed', async () => {
    const client = clientStub();
    client.addAttachmentToResult.mockImplementationOnce(async () => { throw new Error('413'); });
    const summary = await pushResultsToTestRail({
      runId: 42,
      results: [result({ status: 'failed', screenshot: 'AAAA' })],
      client: client as never,
      caseIdFor: () => 900,
    });
    expect(summary.pushed).toBe(1);
    expect(summary.attached).toBe(0);
    expect(summary.failures).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/testrail-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/core/integrations/testrail-sync.ts
/**
 * TestRail ⇄ Pathfinder mapping.
 *
 * Closing the loop is what makes this adoptable by a QA organisation that lives
 * in TestRail rather than in the side panel: pull a run's cases in, execute
 * them, push status, timing, the failure message and the failure screenshot
 * back.
 *
 * Transport failures are collected, never thrown: one unmappable case must not
 * abandon the other forty-nine results of a run.
 */
import type { TestCase, TestResult } from '../../storage/schemas';
import { TESTRAIL_STATUS, type TestRailTest, type createTestRailClient } from './testrail-client';
import { createLogger } from '../../utils/logger';

const log = createLogger('testrail-sync');

export type TestRailClient = ReturnType<typeof createTestRailClient>;

export interface PushSummary {
  pushed: number;
  attached: number;
  failures: Array<{ caseId: number; error: string }>;
}

export interface PushArgs {
  runId: number;
  results: TestResult[];
  client: TestRailClient;
  /** Maps a Pathfinder result back to its TestRail case. Undefined = unmapped. */
  caseIdFor: (result: TestResult) => number | undefined;
}

/**
 * Pathfinder status → TestRail status id.
 *
 * `error` maps to `failed`: from TestRail's point of view a test that could not
 * run is not a pass, and inventing a custom status would break instances that
 * have not defined one. `running` maps to `retest` — the honest description of
 * a result captured mid-flight.
 */
export function statusIdFor(status: TestResult['status']): number {
  switch (status) {
    case 'passed': return TESTRAIL_STATUS.passed;
    case 'failed': return TESTRAIL_STATUS.failed;
    case 'error':  return TESTRAIL_STATUS.failed;
    default:       return TESTRAIL_STATUS.retest;
  }
}

/** TestRail's duration format. Returns undefined below 1s — it rejects '0s'. */
export function formatElapsed(ms: number): string | undefined {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 1) return undefined;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

/** Stable id so re-importing the same run updates rather than duplicates. */
function importedId(runId: number, caseId: number): string {
  return `testrail-${runId}-${caseId}`;
}

export function importRunAsTestCases(tests: TestRailTest[], runId: number): TestCase[] {
  return tests.map((test) => ({
    id: importedId(runId, test.caseId),
    title: test.title,
    description: `Imported from TestRail run ${runId} (case C${test.caseId})`,
    type: 'positive' as const,
    source: 'user' as const,
    // Absent rather than empty: absent means "needs expansion", which is what
    // the one-line runner acts on. An empty array reads as "zero steps".
    steps: test.steps.length > 0 ? test.steps : undefined,
    status: 'pending' as const,
    createdAt: new Date().toISOString(),
  }));
}

function commentFor(result: TestResult): string {
  const lines = [`Pathfinder: ${result.status}`];
  if (result.errorMessage) lines.push('', result.errorMessage);
  const healed = result.stepResults.filter((s) => s.healingAttempt?.success).length;
  if (healed > 0) lines.push('', `${healed} selector(s) self-healed during this run.`);
  return lines.join('\n');
}

/** Base64 PNG → Blob for multipart upload. */
function pngBlob(base64: string): Blob {
  const raw = base64.replace(/^data:image\/[a-z+]+;base64,/i, '');
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

/** The screenshot to attach, if any — only failures carry one worth sending. */
function failureScreenshot(result: TestResult): string | undefined {
  if (result.status === 'passed') return undefined;
  if (result.screenshot) return result.screenshot;
  return result.stepResults.find((s) => s.status === 'failed' && s.screenshot)?.screenshot;
}

export async function pushResultsToTestRail(args: PushArgs): Promise<PushSummary> {
  const summary: PushSummary = { pushed: 0, attached: 0, failures: [] };

  for (const result of args.results) {
    const caseId = args.caseIdFor(result);
    if (caseId === undefined) {
      summary.failures.push({
        caseId: 0,
        error: `"${result.testCaseTitle}" has no TestRail case mapping — import it from a run first.`,
      });
      continue;
    }

    let resultId: number;
    try {
      const posted = await args.client.addResultForCase(args.runId, caseId, {
        status_id: statusIdFor(result.status),
        comment: commentFor(result),
        elapsed: formatElapsed(result.duration),
      });
      resultId = posted.id;
      summary.pushed++;
    } catch (err) {
      summary.failures.push({ caseId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const screenshot = failureScreenshot(result);
    if (!screenshot || resultId === 0) continue;
    try {
      await args.client.addAttachmentToResult(resultId, pngBlob(screenshot), `failure-C${caseId}.png`);
      summary.attached++;
    } catch (err) {
      // The result landed; only the evidence did not. Report, do not retract.
      log.warn(`Attachment failed for case ${caseId}`, err);
      summary.failures.push({
        caseId,
        error: `Result posted but the screenshot did not attach: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/core/testrail-sync.test.ts && npm run typecheck && npm run lint`
Expected: PASS (17 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/integrations/testrail-sync.ts test/unit/core/testrail-sync.test.ts
git commit -m "feat(integrations): map TestRail runs to test cases and results back

Failures are collected rather than thrown so one unmappable case cannot abandon
the rest of a run's results."
```

---

### Task 17: TestRail settings and UI actions

**Files:**
- Modify: `src/storage/schemas.ts` (`Settings.testrail`)
- Modify: `src/sidepanel/components/settings/SettingsPanel.tsx`
- Modify: `src/sidepanel/components/tests/TestImportPanel.tsx` (import from a run id)
- Modify: `src/sidepanel/components/results/ResultsPanel.tsx` (push results)
- Modify: `manifest.json` (`optional_host_permissions`)
- Test: `test/unit/core/testrail-settings.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 15 and 16.
- Produces: `Settings.testrail?: { host: string; email: string; apiKey: string; lastRunId?: number }`; `testRailConfigFrom(settings: Settings): TestRailConfig | undefined`, `caseIdFromTestCaseId(id: string): number | undefined` in `src/core/integrations/testrail-sync.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/core/testrail-settings.test.ts
import { describe, it, expect } from 'vitest';
import { testRailConfigFrom, caseIdFromTestCaseId } from '../../../src/core/integrations/testrail-sync';
import type { Settings } from '../../../src/storage/schemas';

const base = {} as Settings;

describe('testRailConfigFrom', () => {
  it('given_all_three_fields_then_returns_a_config', () => {
    const settings = { ...base, testrail: { host: 'https://acme.testrail.io', email: 'a@b.com', apiKey: 'K' } };
    expect(testRailConfigFrom(settings)).toEqual({
      host: 'https://acme.testrail.io', email: 'a@b.com', apiKey: 'K',
    });
  });

  it('given_no_testrail_settings_then_undefined', () => {
    expect(testRailConfigFrom(base)).toBeUndefined();
  });

  it.each(['host', 'email', 'apiKey'])('given_a_missing_%s_then_undefined', (field) => {
    const testrail = { host: 'h', email: 'e', apiKey: 'k', [field]: '' };
    expect(testRailConfigFrom({ ...base, testrail } as Settings)).toBeUndefined();
  });
});

describe('caseIdFromTestCaseId', () => {
  it('given_an_imported_id_then_extracts_the_case_id', () => {
    expect(caseIdFromTestCaseId('testrail-42-900')).toBe(900);
  });

  it('given_a_non_testrail_id_then_undefined', () => {
    expect(caseIdFromTestCaseId('abc123')).toBeUndefined();
  });

  it('given_a_malformed_testrail_id_then_undefined', () => {
    expect(caseIdFromTestCaseId('testrail-42-')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/core/testrail-settings.test.ts`
Expected: FAIL — neither function exists.

- [ ] **Step 3: Implement**

Append to `src/core/integrations/testrail-sync.ts`:

```ts
import type { Settings } from '../../storage/schemas';
import type { TestRailConfig } from './testrail-client';

/** A config only when all three fields are present — a partial one fails at 401. */
export function testRailConfigFrom(settings: Settings): TestRailConfig | undefined {
  const tr = settings.testrail;
  if (!tr?.host || !tr.email || !tr.apiKey) return undefined;
  return { host: tr.host, email: tr.email, apiKey: tr.apiKey };
}

/** Recover the TestRail case id from an imported test case id. */
export function caseIdFromTestCaseId(id: string): number | undefined {
  const match = /^testrail-\d+-(\d+)$/.exec(id);
  if (!match) return undefined;
  return Number(match[1]);
}
```

Add to `Settings` in `src/storage/schemas.ts`:

```ts
  /**
   * TestRail credentials. Stored in chrome.storage.local like the AI key —
   * ADR-002: they go only to the user's own TestRail host.
   */
  testrail?: {
    host: string;
    email: string;
    apiKey: string;
    /** Remembered so pushing results does not re-ask for the run. */
    lastRunId?: number;
  };
```

In `manifest.json`, add an optional host permission so the user grants their own instance at connect time rather than the extension asking for broad access up front:

```json
  "optional_host_permissions": ["https://*/*"]
```

> Implementer note: read the existing `host_permissions` / `optional_host_permissions` in `manifest.json` first. If a suitable optional pattern already exists, do not add a second. Request the grant with `chrome.permissions.request({ origins: [<the user's host>] })` when they save TestRail settings, and surface a clear message if they decline.

In `SettingsPanel.tsx`, add a TestRail section (host, email, API key) following the `ApiKeyConfig.tsx` pattern for masked credential entry, plus a "Test connection" button calling `getTests` against `lastRunId` or `1` and reporting the error message verbatim.

In `TestImportPanel.tsx`, add "Import from TestRail run" taking a run id, calling `getTests` then `importRunAsTestCases`, and saving the cases through the existing import path so expansion and dedup behave identically to a JSON import.

In `ResultsPanel.tsx`, add a "Push to TestRail" button beside the export buttons, calling `pushResultsToTestRail` with `caseIdFor: (r) => caseIdFromTestCaseId(r.testCaseId)` and rendering the `PushSummary` — including every entry in `failures`, since a silent partial push is the worst outcome here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/core/testrail-settings.test.ts && npm run typecheck && npm run lint && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Full suite and manual verification**

```bash
npm run test:run && npm run lint && npm run build:chrome
```
Reload the extension. In Settings, enter a real TestRail host, email and API key, grant the host permission, and click **Test connection**. Import a run, execute a test, then click **Push to TestRail** and confirm in TestRail that the result and (for a failure) the screenshot attachment landed.

- [ ] **Step 6: Commit**

```bash
git add src/storage/schemas.ts src/core/integrations manifest.json src/sidepanel test/unit/core/testrail-settings.test.ts
git commit -m "feat(integrations): TestRail settings, run import and result push

Host permission is requested for the user's own instance at connect time rather
than claimed broadly up front. Partial pushes are reported in full."
```

---

## Self-Review

**Spec coverage**

| Spec section | Tasks |
|---|---|
| F1 Playwright export | 3, 4, 5 |
| F2 Vision healing | 6, 7 |
| F3 Data-driven execution | 8, 9, 10 |
| F4 TestRail sync | 15, 16, 17 |
| F5 Stability gate | 11, 12 |
| F6 Resume from step | 13, 14 |
| F7 Hashed class guard | 1, 2 |
| Global: no silent TODOs in artifacts | Task 4 (`dropped`), Task 5 (notice), Task 10 (parse errors), Task 16 (`failures`) |
| Global: ADR-002 | Tasks 15 and 17 use the user's own credentials against their own host |

**Type consistency**

- `EmitResult { source, dropped }` is produced in Task 4 and consumed unchanged in Task 5.
- `HealContext` is defined in Task 6 (`execution-ports.ts`) and imported in Task 7.
- `DataSet` is defined in Task 8 and consumed in Tasks 9 and 10.
- `TestCase.quarantined` is added in Task 8 and consumed in Tasks 9, 11 and 12.
- `TestRailClient` is a `ReturnType<typeof createTestRailClient>` alias, so Task 16 cannot drift from Task 15's shape.
- `TESTRAIL_STATUS` is defined once in Task 15 and consumed in Task 16.

**Known verify-before-writing points** — each is called out inline as an implementer note, because the plan is written from reading the code rather than from running it:

1. Task 2 — the real body of `isTestabilityGap` (`src/core/locator.ts:172`) must be read before editing; the sketch there is illustrative.
2. Task 5 — `testCaseToIR`'s real parameter list and `ConversionResult` shape (`src/core/ir/ir-bridge.ts:83`, `:274`).
3. Task 7 — the real text content-part shape in `src/core/ai/ai-client.ts:14`, and exporting `getDOMContext` from `selector-generator.ts:35`.
4. Task 8 — whether `.eslintrc.cjs` forbids `schemas.ts` importing from `core/`, which decides where `DataSet` lives.
5. Task 9 — `executeAllTests`' existing concurrency, `testCaseIds` and `rerunAll` handling before slotting in the expansion.
6. Task 10 / 12 — the store's actual IndexedDB persistence call.
7. Task 11 — every required field of `TestResult` (`schemas.ts:632`), so the `as TestResult` cast can be removed.
8. Task 13 — `previousStep` seeding, `startUrl` navigation, and missing captures in the resumed walk.
9. Task 17 — the existing `manifest.json` permission patterns.
