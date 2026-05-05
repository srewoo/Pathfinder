/**
 * Lightweight runtime validators for LLM JSON output.
 *
 * Replaces ad-hoc `JSON.parse` + `as Record<string, unknown>` patterns with
 * structured validation. Keep dependency-free (no zod) — extension already
 * avoids it to keep the bundle small.
 *
 * Usage:
 *   const result = parseJSON(raw, isAlternativesShape);
 *   if (!result.ok) handleError(result.error);
 *   else use(result.value.alternatives);
 */

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; raw: string };

export type Guard<T> = (value: unknown) => value is T;

export function parseJSON<T>(raw: string, guard: Guard<T>): ValidationResult<T> {
  const cleaned = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw,
    };
  }
  if (!guard(parsed)) {
    return { ok: false, error: 'Response did not match expected schema', raw };
  }
  return { ok: true, value: parsed };
}

export function stripFences(raw: string): string {
  return raw.replace(/```(?:json|JSON)?\s*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
}

// ─── Common guards ──────────────────────────────────────────────────────────

export interface AlternativesShape {
  alternatives: string[];
}

export const isAlternativesShape: Guard<AlternativesShape> = (v): v is AlternativesShape => {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.alternatives)) return false;
  return v.alternatives.every((a) => typeof a === 'string');
};

export interface NextActionShape {
  action: string;
  selector?: string;
  value?: string;
  description?: string;
  assertType?: string;
  assertExpected?: string;
  key?: string;
  isDone?: boolean;
}

export const isNextActionShape: Guard<NextActionShape> = (v): v is NextActionShape => {
  if (!isObject(v)) return false;
  if (typeof v.action !== 'string') return false;
  for (const k of ['selector', 'value', 'description', 'assertType', 'assertExpected', 'key']) {
    if (v[k] != null && typeof v[k] !== 'string') return false;
  }
  if (v.isDone != null && typeof v.isDone !== 'boolean') return false;
  return true;
};

export interface PlanShape {
  steps: Array<Record<string, unknown>>;
}

export const isPlanShape: Guard<PlanShape> = (v): v is PlanShape => {
  if (!isObject(v)) return false;
  if (!Array.isArray(v.steps)) return false;
  return v.steps.every((s) => isObject(s));
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
