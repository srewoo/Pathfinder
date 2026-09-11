/**
 * `TestIR` → runnable `@playwright/test` source.
 *
 * This is the artifact boundary. Pathfinder executes tests in-browser via CDP,
 * which is excellent for authoring and useless for CI, code review, or keeping a
 * test after the extension is uninstalled. The IR already holds everything a
 * spec file needs, so the transpiler is deterministic — no model, no
 * non-reproducibility, and a diff a reviewer can read.
 *
 * Anything not expressible in a plain spec file is returned in `dropped` rather
 * than emitted as a comment. A test that looks complete but silently asserts
 * less than the original manufactures false confidence, which is the failure
 * mode the whole IR boundary exists to prevent.
 */
import type { Assertion, Step, TestIR } from '../ir/test-ir';
import { PLACEHOLDER_RE } from '../ir/test-ir';
import { emitLocator, quote } from './playwright-locator';
import { emitAssertion } from './playwright-assertions';

export interface EmitResult {
  source: string;
  /** Human-readable reasons, one per step or assertion that could not be emitted. */
  dropped: string[];
}

const HEADER = "import { test, expect } from '@playwright/test';";
const DRAG_TYPE_IMPORT = "import type { Locator, Page } from '@playwright/test';";

/**
 * Playwright's own `dragTo` is unreliable against drag libraries that require
 * intermediate pointer movement (react-dnd, SortableJS) — see
 * microsoft/playwright#20254. Stepped mouse movement is the workaround, and it
 * is emitted only when a test actually drags.
 */
const DRAG_HELPER = `
/**
 * Drag with intermediate pointer movement. Libraries that listen for dragover
 * ignore a single-jump dragTo.
 */
async function smoothDragTo(page: Page, source: Locator, target: Locator): Promise<void> {
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

/**
 * Emit a value as a quoted string, or a template literal when it interpolates.
 *
 * The IR guarantees every `{{name}}` was captured by an earlier step, so the
 * referenced `const` is always already in scope at this point in the emitted
 * body — which is what makes a bare template literal safe here.
 */
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

type StepEmit = { lines: string[] } | { dropped: string };

/** One IR step → one or more lines of source, or a drop reason. */
function emitStep(step: Step): StepEmit {
  let target = '';
  if (step.locator) {
    const emitted = emitLocator(step.locator);
    if ('unsupported' in emitted) {
      return {
        dropped: `step ${step.order} (${step.action}) "${step.description}": ${emitted.unsupported}`,
      };
    }
    target = emitted.expr;
  }

  switch (step.action) {
    case 'navigate':
      return {
        lines: [
          `await page.goto(${emitValue(step.value ?? '')});`,
          `await page.waitForLoadState('load');`,
        ],
      };
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
        return {
          dropped: `step ${step.order} (drag_drop) "${step.description}": no target locator`,
        };
      }
      const dropTarget = emitLocator(step.targetLocator);
      if ('unsupported' in dropTarget) {
        return {
          dropped: `step ${step.order} (drag_drop) "${step.description}": target ${dropTarget.unsupported}`,
        };
      }
      return { lines: [`await smoothDragTo(page, ${target}, ${dropTarget.expr});`] };
    }
    case 'capture': {
      const reader =
        step.captureFrom === 'attribute'
          ? `getAttribute(${quote(step.attribute ?? '')})`
          : CAPTURE_READERS[step.captureFrom ?? 'text'];
      return { lines: [`const ${step.captureAs} = await ${target}.${reader};`] };
    }
    default:
      return { dropped: `step ${step.order}: unsupported action "${String(step.action)}"` };
  }
}

/** Bucket assertions by the step they must run after; the rest run at the end. */
function partitionAssertions(assertions: readonly Assertion[]): {
  byStep: Map<number, Assertion[]>;
  deferred: Assertion[];
} {
  const byStep = new Map<number, Assertion[]>();
  const deferred: Assertion[] = [];
  for (const a of [...assertions].sort((x, y) => x.order - y.order)) {
    if (a.afterStep === undefined) {
      deferred.push(a);
      continue;
    }
    const bucket = byStep.get(a.afterStep) ?? [];
    bucket.push(a);
    byStep.set(a.afterStep, bucket);
  }
  return { byStep, deferred };
}

/** The body of one `test()` block, unindented. */
function emitBody(ir: TestIR, dropped: string[]): string[] {
  const lines: string[] = [];
  if (ir.startUrl) {
    lines.push(
      `await page.goto(${quote(ir.startUrl)});`,
      `await page.waitForLoadState('load');`,
      ''
    );
  }

  const { byStep, deferred } = partitionAssertions(ir.assertions);
  const pushAssertions = (list: Assertion[]) => {
    for (const a of list) {
      const out = emitAssertion(a);
      if ('dropped' in out) dropped.push(out.dropped);
      else lines.push(out.line);
    }
  };

  for (const step of [...ir.steps].sort((a, b) => a.order - b.order)) {
    const out = emitStep(step);
    if ('dropped' in out) {
      dropped.push(out.dropped);
      continue;
    }
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
  const tagOpt =
    ir.tags.length > 0 ? `, { tag: [${ir.tags.map((t) => quote(`@${t}`)).join(', ')}] }` : '';
  const body = emitBody(ir, dropped)
    .map((l) => (l === '' ? '' : `  ${l}`))
    .join('\n');
  return `test(${quote(ir.name)}${tagOpt}, async ({ page }) => {\n${body}\n});`;
}

function needsDragHelper(irs: readonly TestIR[]): boolean {
  return irs.some((ir) => ir.steps.some((s) => s.action === 'drag_drop'));
}

function assemble(irs: readonly TestIR[], blocks: string[], dropped: string[]): EmitResult {
  const parts = [HEADER];
  if (needsDragHelper(irs)) parts.push(DRAG_TYPE_IMPORT, '', DRAG_HELPER);
  parts.push('', blocks.join('\n\n'), '');
  return { source: parts.join('\n'), dropped };
}

export function emitPlaywrightTest(ir: TestIR): EmitResult {
  const dropped: string[] = [];
  return assemble([ir], [emitTestBlock(ir, dropped)], dropped);
}

export function emitPlaywrightSuite(irs: readonly TestIR[]): EmitResult {
  const dropped: string[] = [];
  const blocks = irs.map((ir) => emitTestBlock(ir, dropped));
  return assemble(irs, blocks, dropped);
}
