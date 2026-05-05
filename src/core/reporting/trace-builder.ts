/**
 * Build a unified trace timeline for a single test result.
 *
 * Merges per-step timing with network HAR entries, console output, healing
 * attempts, and screenshots into a single ordered list a viewer can render.
 * Designed to be JSON-serializable for the side panel UI and the CLI's
 * generated HTML report.
 */

import type {
  TestResult, StepResult, HealingAttempt,
} from '../../storage/schemas';

export type TraceEventKind = 'step' | 'network' | 'console' | 'healing' | 'screenshot';

export interface TraceEvent {
  /** Wallclock ms since the test started. */
  offsetMs: number;
  kind: TraceEventKind;
  /** Step order or other context for grouping in the viewer. */
  stepOrder?: number;
  /** Short summary line. */
  summary: string;
  /** Optional structured detail (network req/res, error, etc). */
  detail?: Record<string, unknown>;
}

export interface Trace {
  testResultId: string;
  testCaseTitle: string;
  startedAt: string;
  durationMs: number;
  events: TraceEvent[];
  /** Headline metrics for the trace header. */
  metrics: {
    stepCount: number;
    networkCount: number;
    healingCount: number;
    failedSteps: number;
  };
}

export interface BuildTraceOptions {
  /** Console events to weave in, if captured separately. */
  consoleEvents?: Array<{ timestamp: string; level: string; message: string }>;
}

export function buildTrace(result: TestResult, opts: BuildTraceOptions = {}): Trace {
  const startMs = result.startedAt ? new Date(result.startedAt).getTime() : 0;
  const events: TraceEvent[] = [];

  // Steps + their healing attempts
  let cumulativeMs = 0;
  for (const step of result.steps) {
    events.push(buildStepEvent(step, cumulativeMs));
    if (step.healingAttempt) {
      events.push(buildHealingEvent(step.healingAttempt, step, cumulativeMs));
    }
    cumulativeMs += step.duration;
  }

  // Healing attempts not bound to specific steps
  for (const ha of result.healingAttempts ?? []) {
    if (!result.steps.some((s) => s.healingAttempt === ha)) {
      events.push(buildHealingEvent(ha, undefined, cumulativeMs));
    }
  }

  // Network — entries don't carry timestamps in the current schema, so we
  // distribute them evenly through the run for the timeline view.
  const harEntries = result.harEntries ?? [];
  if (harEntries.length > 0) {
    const span = result.duration ?? cumulativeMs;
    const slot = harEntries.length > 1 ? span / harEntries.length : 0;
    harEntries.forEach((entry, i) => {
      events.push({
        offsetMs: Math.round(slot * i),
        kind: 'network',
        summary: `${entry.method} ${entry.url} → ${entry.status ?? '—'}`,
        detail: { method: entry.method, url: entry.url, status: entry.status, mimeType: entry.mimeType, duration: entry.duration },
      });
    });
  }

  // Console
  for (const c of opts.consoleEvents ?? []) {
    const t = c.timestamp ? new Date(c.timestamp).getTime() : startMs;
    events.push({
      offsetMs: Math.max(0, t - startMs),
      kind: 'console',
      summary: `[${c.level}] ${c.message.slice(0, 200)}`,
      detail: { level: c.level },
    });
  }

  // Screenshots
  if (result.screenshot) {
    events.push({
      offsetMs: cumulativeMs,
      kind: 'screenshot',
      summary: 'Final screenshot',
    });
  }

  events.sort((a, b) => a.offsetMs - b.offsetMs);

  return {
    testResultId: result.id,
    testCaseTitle: result.testCaseTitle,
    startedAt: result.startedAt,
    durationMs: result.duration ?? cumulativeMs,
    events,
    metrics: {
      stepCount: result.steps.length,
      networkCount: result.harEntries?.length ?? 0,
      healingCount: result.healingAttempts?.length ?? 0,
      failedSteps: result.steps.filter((s) => s.status === 'failed').length,
    },
  };
}

function buildStepEvent(step: StepResult, offsetMs: number): TraceEvent {
  const status = step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '•';
  return {
    offsetMs,
    kind: 'step',
    stepOrder: step.step.order,
    summary: `${status} [${step.step.order}] ${step.step.action} ${step.step.description}`,
    detail: {
      duration: step.duration,
      error: step.error,
      selector: step.step.selector,
    },
  };
}

function buildHealingEvent(ha: HealingAttempt, step: StepResult | undefined, offsetMs: number): TraceEvent {
  return {
    offsetMs,
    kind: 'healing',
    stepOrder: step?.step.order ?? ha.stepOrder,
    summary: ha.success
      ? `↻ Healed (${ha.method}): ${ha.originalSelector} → ${ha.healedSelector}`
      : `↻ Heal failed (${ha.method}): ${ha.originalSelector}`,
    detail: { method: ha.method, success: ha.success, error: ha.error },
  };
}

