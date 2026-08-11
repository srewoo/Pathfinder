/**
 * IR executor (fix.md §6, §8, §5).
 *
 * Consumes validated `TestIR` and nothing else. Contains ZERO LLM calls —
 * enforced by the ESLint rule banning `core/ai/**` imports in this directory, so
 * the boundary is checked rather than merely intended.
 *
 * Waiting is absent by design: every action asserts its own actionability
 * preconditions inside the driver (§8), so there is nothing here that sleeps,
 * polls, or retries-on-a-hunch. A step that needs a wait is a driver bug.
 *
 * Healing is never silent (§5): each heal is recorded, and a test that leaned on
 * two or more healed locators returns NEEDS_REVIEW instead of PASS.
 */
import type { Driver } from '../driver';
import type { Assertion, Step, TestIR } from '../ir/test-ir';
import { interpolate } from '../ir/test-ir';
import type { Locator, LocatorTier } from '../locator';
import { describeLocator } from '../locator';
import type { HealLedger, TestVerdict } from '../report/heal-ledger';
import { verdictFor } from '../report/heal-ledger';
import type { LocatorUsage } from '../report/heal-ledger';
import { createLogger } from '../../utils/logger';

const log = createLogger('ir-executor');

export interface IRStepResult {
  order: number;
  description: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  error?: string;
  healed?: { from: string; to: string };
}

export interface IRTestResult {
  testId: string;
  name: string;
  verdict: TestVerdict;
  durationMs: number;
  steps: IRStepResult[];
  assertions: IRStepResult[];
  errorMessage?: string;
  healedLocatorCount: number;
  /** Every locator the run touched — feeds the testability report. */
  locatorUsages: LocatorUsage[];
  /** Variables captured during the run. */
  captured: Record<string, string>;
}

export interface ExecuteOptions {
  healLedger?: HealLedger;
  now?: () => number;
  /** Abort cooperatively between steps. */
  signal?: { aborted: boolean };
}

/**
 * Run one test.
 *
 * Steps run in order and stop at the first failure — continuing past a failed
 * step tests a state the test never described, which produces cascading
 * false failures that bury the real one.
 *
 * Assertions all run even after one fails, because each is an independent
 * question about the same final state and knowing all the answers is more useful
 * than knowing the first.
 */
export async function executeIR(
  driver: Driver,
  ir: TestIR,
  opts: ExecuteOptions = {}
): Promise<IRTestResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const stepResults: IRStepResult[] = [];
  const assertionResults: IRStepResult[] = [];
  const locatorUsages: LocatorUsage[] = [];
  const captured: Record<string, string> = {};
  const healedKeys = new Set<string>();

  let failed = false;
  let errorMessage: string | undefined;
  let currentUrl = ir.startUrl ?? '';

  const orderedSteps = [...ir.steps].sort((a, b) => a.order - b.order);

  for (const step of orderedSteps) {
    if (opts.signal?.aborted) {
      stepResults.push({
        order: step.order,
        description: step.description,
        status: 'skipped',
        durationMs: 0,
        error: 'Run aborted',
      });
      failed = true;
      errorMessage ??= 'Run aborted';
      break;
    }

    const stepStart = now();
    try {
      const healed = await runStep(driver, step, {
        captured,
        locatorUsages,
        currentUrl,
      });
      if (healed) {
        healedKeys.add(healed.key);
        opts.healLedger?.record(
          {
            testId: ir.id,
            stepOrder: step.order,
            locatorKey: healed.key,
            target: healed.target,
            from: healed.from,
            to: healed.to,
          },
          now()
        );
      }
      if (step.action === 'navigate' && step.value) currentUrl = step.value;

      stepResults.push({
        order: step.order,
        description: step.description,
        status: 'passed',
        durationMs: now() - stepStart,
        healed: healed ? { from: healed.from, to: healed.to } : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Step ${step.order} failed: ${message}`);
      stepResults.push({
        order: step.order,
        description: step.description,
        status: 'failed',
        durationMs: now() - stepStart,
        error: message,
      });
      failed = true;
      errorMessage = message;
      break;
    }
  }

  // Mark the steps we never reached as skipped rather than omitting them — a
  // result that silently lists fewer steps than the test has is unreadable.
  const ranOrders = new Set(stepResults.map((s) => s.order));
  for (const step of orderedSteps) {
    if (!ranOrders.has(step.order)) {
      stepResults.push({
        order: step.order,
        description: step.description,
        status: 'skipped',
        durationMs: 0,
      });
    }
  }
  stepResults.sort((a, b) => a.order - b.order);

  if (!failed) {
    for (const assertion of [...ir.assertions].sort((a, b) => a.order - b.order)) {
      const aStart = now();
      try {
        await checkAssertion(driver, assertion, { locatorUsages, currentUrl, captured });
        assertionResults.push({
          order: assertion.order,
          description: assertion.description,
          status: 'passed',
          durationMs: now() - aStart,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        assertionResults.push({
          order: assertion.order,
          description: assertion.description,
          status: 'failed',
          durationMs: now() - aStart,
          error: message,
        });
        failed = true;
        errorMessage ??= message;
      }
    }
  } else {
    for (const assertion of ir.assertions) {
      assertionResults.push({
        order: assertion.order,
        description: assertion.description,
        status: 'skipped',
        durationMs: 0,
      });
    }
  }

  return {
    testId: ir.id,
    name: ir.name,
    verdict: verdictFor(!failed, healedKeys.size),
    durationMs: now() - started,
    steps: stepResults,
    assertions: assertionResults,
    errorMessage,
    healedLocatorCount: healedKeys.size,
    locatorUsages,
    captured,
  };
}

// ── Steps ───────────────────────────────────────────────────────────────────

interface StepContext {
  captured: Record<string, string>;
  locatorUsages: LocatorUsage[];
  currentUrl: string;
}

interface HealInfo {
  key: string;
  target: string;
  from: LocatorTier;
  to: LocatorTier;
}

async function runStep(driver: Driver, step: Step, ctx: StepContext): Promise<HealInfo | null> {
  const value = step.value === undefined ? undefined : interpolate(step.value, ctx.captured);
  const timeoutMs = step.timeoutMs;

  const note = (loc: Locator | undefined) => {
    if (loc) ctx.locatorUsages.push({ locator: loc, url: ctx.currentUrl });
  };

  switch (step.action) {
    case 'navigate':
      if (!value) throw new Error('navigate step has no URL');
      await driver.navigate(value);
      return null;

    case 'press_key':
      note(step.locator);
      await driver.pressKey(step.key ?? 'Enter', step.locator, { timeoutMs });
      return null;

    case 'scroll':
      note(step.locator);
      await driver.scroll(
        step.locator
          ? { locator: step.locator }
          : value === 'top' || value === 'bottom'
            ? { to: value }
            : { px: Number(value ?? 0) }
      );
      return null;

    case 'click':
    case 'double_click': {
      const loc = required(step.locator, step);
      note(loc);
      const h = await driver.click(loc, { double: step.action === 'double_click', timeoutMs });
      return healOf(h, loc);
    }

    case 'type': {
      const loc = required(step.locator, step);
      note(loc);
      const h = await driver.type(loc, value ?? '', { timeoutMs });
      return healOf(h, loc);
    }

    case 'clear': {
      const loc = required(step.locator, step);
      note(loc);
      return healOf(await driver.clear(loc, { timeoutMs }), loc);
    }

    case 'hover': {
      const loc = required(step.locator, step);
      note(loc);
      return healOf(await driver.hover(loc, { timeoutMs }), loc);
    }

    case 'check':
    case 'uncheck': {
      const loc = required(step.locator, step);
      note(loc);
      const h = await driver.setChecked(loc, step.action === 'check', { timeoutMs });
      return healOf(h, loc);
    }

    case 'select': {
      const loc = required(step.locator, step);
      note(loc);
      return healOf(await driver.selectOption(loc, value ?? '', { timeoutMs }), loc);
    }

    case 'drag_drop': {
      const from = required(step.locator, step);
      const to = required(step.targetLocator, step);
      note(from);
      note(to);
      await driver.dragDrop(from, to, { timeoutMs });
      return null;
    }

    case 'upload_file': {
      const loc = required(step.locator, step);
      note(loc);
      const files = (value ?? '').split(',').map((f) => f.trim()).filter(Boolean);
      return healOf(await driver.uploadFile(loc, files, { timeoutMs }), loc);
    }

    case 'capture': {
      const loc = required(step.locator, step);
      note(loc);
      const from = step.captureFrom ?? 'text';
      const captured =
        from === 'value'
          ? await driver.readValue(loc, { timeoutMs })
          : from === 'attribute'
            ? ((await driver.readAttribute(loc, step.attribute ?? '', { timeoutMs })) ?? '')
            : await driver.readText(loc, { timeoutMs });
      ctx.captured[step.captureAs!] = captured;
      return null;
    }
  }
}

function required(loc: Locator | undefined, step: Step): Locator {
  // The IR schema already guarantees this, so reaching here means the schema and
  // the executor disagree — worth a loud error rather than a silent skip.
  if (!loc) throw new Error(`Step ${step.order} (${step.action}) is missing its locator`);
  return loc;
}

function healOf(
  handle: { healed: boolean; tier: LocatorTier; locator: Locator },
  loc: Locator
): HealInfo | null {
  if (!handle.healed) return null;
  return {
    key: `${loc.preferredTier}:${describeLocator(loc)}`,
    target: describeLocator(loc),
    from: loc.preferredTier,
    to: handle.tier,
  };
}

// ── Assertions ──────────────────────────────────────────────────────────────

async function checkAssertion(
  driver: Driver,
  assertion: Assertion,
  ctx: StepContext
): Promise<void> {
  const expected =
    assertion.expected === undefined ? undefined : interpolate(assertion.expected, ctx.captured);

  if (assertion.locator) ctx.locatorUsages.push({ locator: assertion.locator, url: ctx.currentUrl });

  switch (assertion.kind) {
    case 'url': {
      const url = await driver.currentUrl();
      if (!expected || !url.includes(expected)) {
        throw new Error(`Expected URL to contain "${expected}", got "${url}"`);
      }
      return;
    }

    case 'visible':
    case 'exists': {
      const handle = await driver.resolve(need(assertion));
      if (!handle) throw new Error(`Expected ${describeLocator(need(assertion))} to exist`);
      if (assertion.kind === 'visible') {
        const s = await driver.sample(handle);
        if (!s.visible) throw new Error(`Expected ${describeLocator(need(assertion))} to be visible`);
      }
      return;
    }

    case 'not_visible':
    case 'not_exists': {
      const handle = await driver.resolve(need(assertion));
      if (!handle) return;
      if (assertion.kind === 'not_exists') {
        throw new Error(`Expected ${describeLocator(need(assertion))} NOT to exist`);
      }
      const s = await driver.sample(handle);
      if (s.visible) {
        throw new Error(`Expected ${describeLocator(need(assertion))} NOT to be visible`);
      }
      return;
    }

    case 'text':
    case 'not_text': {
      const text = await driver.readText(need(assertion));
      const has = expected !== undefined && text.includes(expected);
      if (assertion.kind === 'text' && !has) {
        throw new Error(`Expected text "${expected}", got "${text.slice(0, 120)}"`);
      }
      if (assertion.kind === 'not_text' && has) {
        throw new Error(`Expected text NOT to contain "${expected}"`);
      }
      return;
    }

    case 'value': {
      const v = await driver.readValue(need(assertion));
      if (v !== expected) throw new Error(`Expected value "${expected}", got "${v}"`);
      return;
    }

    case 'attribute': {
      const v = await driver.readAttribute(need(assertion), assertion.attribute ?? '');
      if (v !== expected) {
        throw new Error(`Expected ${assertion.attribute}="${expected}", got "${v ?? '(absent)'}"`);
      }
      return;
    }

    case 'enabled':
    case 'disabled': {
      const handle = await driver.resolve(need(assertion));
      if (!handle) throw new Error(`Element not found: ${describeLocator(need(assertion))}`);
      const s = await driver.sample(handle);
      if (assertion.kind === 'enabled' && !s.enabled) throw new Error('Expected element to be enabled');
      if (assertion.kind === 'disabled' && s.enabled) throw new Error('Expected element to be disabled');
      return;
    }

    case 'count':
    case 'exact_count': {
      const n = await driver.count(need(assertion));
      const want = Number(expected ?? '0');
      if (assertion.kind === 'exact_count' ? n !== want : n < want) {
        throw new Error(
          `Expected ${assertion.kind === 'exact_count' ? '' : 'at least '}${want}, found ${n}`
        );
      }
      return;
    }

    case 'api_called':
    case 'api_not_called':
    case 'api_status': {
      const log_ = driver.networkLog();
      const spec = (expected ?? '').trim();
      const matches = log_.filter((r) => matchesApiSpec(r.method, r.url, spec));
      if (assertion.kind === 'api_called' && matches.length === 0) {
        throw new Error(`Expected an API request matching "${spec}"`);
      }
      if (assertion.kind === 'api_not_called' && matches.length > 0) {
        throw new Error(`Expected NO API request matching "${spec}", found ${matches.length}`);
      }
      if (assertion.kind === 'api_status') {
        const want = expectedStatus(spec);
        if (!matches.some((m) => m.status === want)) {
          throw new Error(
            `Expected "${spec}" — observed statuses: ${matches.map((m) => m.status).join(', ') || 'none'}`
          );
        }
      }
      return;
    }
  }
}

function need(assertion: Assertion): Locator {
  if (!assertion.locator) {
    throw new Error(`Assertion ${assertion.order} (${assertion.kind}) requires a locator`);
  }
  return assertion.locator;
}

/** `"POST /api/login 200"` → method + path match. Status parsed separately. */
export function matchesApiSpec(method: string, url: string, spec: string): boolean {
  const parts = spec.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const wantMethod = /^[A-Z]+$/.test(parts[0]) ? parts[0] : null;
  const wantPath = wantMethod ? parts[1] : parts[0];
  if (wantMethod && method.toUpperCase() !== wantMethod) return false;
  return wantPath ? url.includes(wantPath) : true;
}

export function expectedStatus(spec: string): number {
  const m = /\b(\d{3})\b/.exec(spec);
  return m ? Number(m[1]) : 200;
}
