/**
 * Test IR — the determinism boundary (fix.md §6).
 *
 * The ONLY artifact an LLM may produce. Everything downstream consumes validated
 * IR and nothing else, which is what makes runs reproducible, test changes
 * reviewable, and a hallucinated selector a parse error rather than a click.
 *
 * CLAUDE.md §8.0 states the principle — AI is probabilistic, systems must be
 * deterministic. This schema is where that stops being a slogan: the boundary is
 * an artifact with a validator, not a convention.
 *
 * Versioned on purpose. `irVersion` is checked on read, so a future shape change
 * is a migration rather than a silent misparse.
 */
import { z } from 'zod';
import { LocatorSchema } from '../locator';

export const IR_VERSION = '1' as const;

// ── Steps ───────────────────────────────────────────────────────────────────

/**
 * Note what is absent: there is no `wait` step and no `sleep`.
 *
 * §8 moved waiting into the driver's actionability preconditions, so a step that
 * needs a wait is a driver bug, not an authoring concern. Leaving `wait` in the
 * vocabulary would let generators paper over real flake with sleeps — the exact
 * habit the actionability model exists to end.
 */
export const StepActionSchema = z.enum([
  'navigate',
  'click',
  'double_click',
  'type',
  'clear',
  'hover',
  'check',
  'uncheck',
  'select',
  'press_key',
  'drag_drop',
  'upload_file',
  'scroll',
  'capture',
]);
export type StepAction = z.infer<typeof StepActionSchema>;

export const StepSchema = z.object({
  order: z.number().int().nonnegative(),
  action: StepActionSchema,
  /** Target element. Absent for navigate/press_key/scroll. */
  locator: LocatorSchema.optional(),
  /** Secondary target — drag_drop only. */
  targetLocator: LocatorSchema.optional(),
  /** Literal value, or `{{name}}` referencing an earlier capture. */
  value: z.string().optional(),
  key: z.string().optional(),
  /** capture only: variable name to bind. */
  captureAs: z.string().optional(),
  captureFrom: z.enum(['text', 'value', 'attribute']).optional(),
  attribute: z.string().optional(),
  /** Human-readable intent. Required — an unexplained step is unreviewable. */
  description: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
});
export type Step = z.infer<typeof StepSchema>;

// ── Assertions ──────────────────────────────────────────────────────────────

export const AssertKindSchema = z.enum([
  'visible',
  'not_visible',
  'exists',
  'not_exists',
  'text',
  'not_text',
  'value',
  'attribute',
  'enabled',
  'disabled',
  'count',
  'exact_count',
  'url',
  'api_called',
  'api_not_called',
  'api_status',
]);
export type AssertKind = z.infer<typeof AssertKindSchema>;

export const AssertionSchema = z.object({
  order: z.number().int().nonnegative(),
  kind: AssertKindSchema,
  locator: LocatorSchema.optional(),
  expected: z.string().optional(),
  attribute: z.string().optional(),
  description: z.string().min(1),
  /**
   * Where this assertion's expectation came from. `inferred` assertions are the
   * false-positive risk, so they are labelled rather than hidden.
   */
  confidence: z.enum(['grounded', 'doc_asserted', 'inferred']).default('inferred'),
  /**
   * Evaluate immediately AFTER this step order, rather than at the end of the run.
   *
   * Required for faithfulness: a test that clicks Save, asserts a success banner,
   * then navigates away is asserting about INTERMEDIATE state. Deferring that
   * assertion to the end would check a page the test never claimed anything
   * about — passing or failing for the wrong reason. Omitted means "after all
   * steps", which is the common case.
   */
  afterStep: z.number().int().nonnegative().optional(),
});
export type Assertion = z.infer<typeof AssertionSchema>;

// ── Provenance ──────────────────────────────────────────────────────────────

export const ProvenanceSchema = z.object({
  source: z.enum(['exploration', 'documentation', 'hybrid', 'user', 'constraint']),
  /** Prompt version, so §10's benchmark can attribute a regression to a change. */
  promptVersion: z.string().default('n/a'),
  model: z.string().default('n/a'),
  generatedAt: z.number(),
  /** True when produced with zero LLM involvement (§9). */
  deterministic: z.boolean().default(false),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ── The IR ──────────────────────────────────────────────────────────────────

export const TestIRSchema = z
  .object({
    irVersion: z.literal(IR_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    startUrl: z.string().optional(),
    provenance: ProvenanceSchema,
    steps: z.array(StepSchema),
    assertions: z.array(AssertionSchema),
    tags: z.array(z.string()).default([]),
    /**
     * Names supplied externally per run — data-driven columns.
     *
     * They satisfy a `{{placeholder}}` reference without an earlier capture
     * step, because the value comes from the data row rather than from the page.
     * Optional rather than defaulted: a default makes the field REQUIRED in the
     * inferred output type, which would break every existing construction site
     * of `TestIR` for a field almost none of them care about.
     */
    dataKeys: z.array(z.string()).optional(),
  })
  .superRefine((ir, ctx) => {
    // A test that asserts nothing always passes, which is worse than no test —
    // it manufactures false confidence. Reject at the boundary.
    if (ir.assertions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Test "${ir.name}" has no assertions — a test that asserts nothing always passes`,
        path: ['assertions'],
      });
    }

    for (const step of ir.steps) {
      if (STEPS_REQUIRING_LOCATOR.has(step.action) && !step.locator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${step.order} (${step.action}) requires a locator`,
          path: ['steps', step.order, 'locator'],
        });
      }
      if (step.action === 'drag_drop' && !step.targetLocator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${step.order} (drag_drop) requires a targetLocator`,
          path: ['steps', step.order, 'targetLocator'],
        });
      }
      if (step.action === 'type' && step.value === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${step.order} (type) requires a value`,
          path: ['steps', step.order, 'value'],
        });
      }
      if (step.action === 'capture' && !step.captureAs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Step ${step.order} (capture) requires captureAs`,
          path: ['steps', step.order, 'captureAs'],
        });
      }
    }

    // Every {{placeholder}} must be captured by an EARLIER step. A forward
    // reference silently types the literal "{{token}}" into the field.
    const captured = new Set<string>(ir.dataKeys ?? []);
    for (const step of [...ir.steps].sort((a, b) => a.order - b.order)) {
      for (const ref of placeholdersIn(step.value)) {
        if (!captured.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              `Step ${step.order} references {{${ref}}} but nothing captured it yet. ` +
              `Captures must precede their use.`,
            path: ['steps', step.order, 'value'],
          });
        }
      }
      if (step.action === 'capture' && step.captureAs) captured.add(step.captureAs);
    }
  });

export type TestIR = z.infer<typeof TestIRSchema>;

const STEPS_REQUIRING_LOCATOR: ReadonlySet<StepAction> = new Set([
  'click',
  'double_click',
  'type',
  'clear',
  'hover',
  'check',
  'uncheck',
  'select',
  'drag_drop',
  'upload_file',
  'capture',
]);

export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function placeholdersIn(value: string | undefined): string[] {
  if (!value) return [];
  const found: string[] = [];
  for (const m of value.matchAll(PLACEHOLDER_RE)) found.push(m[1]);
  return found;
}

/** Substitute captured variables. Unknown placeholders are left intact so a
 *  failure surfaces as "typed {{token}}" rather than an empty field. */
export function interpolate(value: string, vars: Readonly<Record<string, string>>): string {
  return value.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole
  );
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export class IRValidationError extends Error {
  readonly isOperational = true;
  constructor(readonly issues: string[], readonly raw: unknown) {
    super(`Test IR failed validation:\n  - ${issues.join('\n  - ')}`);
    this.name = 'IRValidationError';
  }
}

/**
 * The gate. Nothing reaches the executor without passing through here.
 *
 * Throws rather than returning a partial: a test we cannot fully understand must
 * not run, because a half-parsed test that "passes" is indistinguishable from a
 * real pass.
 */
export function parseTestIR(raw: unknown): TestIR {
  const result = TestIRSchema.safeParse(raw);
  if (!result.success) {
    throw new IRValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      raw
    );
  }
  return result.data;
}

export function safeParseTestIR(
  raw: unknown
): { ok: true; ir: TestIR } | { ok: false; issues: string[] } {
  const result = TestIRSchema.safeParse(raw);
  if (result.success) return { ok: true, ir: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

/** Parse a batch, separating the valid from the rejected. Nothing is silently
 *  dropped — the caller must surface `rejected`. */
export function parseTestIRBatch(raws: readonly unknown[]): {
  valid: TestIR[];
  rejected: Array<{ index: number; issues: string[] }>;
} {
  const valid: TestIR[] = [];
  const rejected: Array<{ index: number; issues: string[] }> = [];
  raws.forEach((raw, index) => {
    const r = safeParseTestIR(raw);
    if (r.ok) valid.push(r.ir);
    else rejected.push({ index, issues: r.issues });
  });
  return { valid, rejected };
}

// ── Serialization ───────────────────────────────────────────────────────────

/**
 * Canonical JSON for export and diffing.
 *
 * Keys are emitted in a fixed order and steps sorted by `order`, so
 * regenerating an unchanged test produces a byte-identical file. Without that,
 * every regeneration looks like a change in review and the IR stops being
 * reviewable — which was the point of having it.
 */
export function serializeIR(ir: TestIR): string {
  return JSON.stringify(canonicalize(ir), null, 2);
}

function canonicalize(ir: TestIR): unknown {
  return {
    irVersion: ir.irVersion,
    id: ir.id,
    name: ir.name,
    startUrl: ir.startUrl,
    tags: [...ir.tags].sort(),
    provenance: {
      source: ir.provenance.source,
      deterministic: ir.provenance.deterministic,
      model: ir.provenance.model,
      promptVersion: ir.provenance.promptVersion,
      generatedAt: ir.provenance.generatedAt,
    },
    steps: [...ir.steps]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        order: s.order,
        action: s.action,
        description: s.description,
        locator: s.locator,
        targetLocator: s.targetLocator,
        value: s.value,
        key: s.key,
        captureAs: s.captureAs,
        captureFrom: s.captureFrom,
        attribute: s.attribute,
        timeoutMs: s.timeoutMs,
      })),
    assertions: [...ir.assertions]
      .sort((a, b) => a.order - b.order)
      .map((a) => ({
        order: a.order,
        kind: a.kind,
        description: a.description,
        confidence: a.confidence,
        afterStep: a.afterStep,
        locator: a.locator,
        expected: a.expected,
        attribute: a.attribute,
      })),
  };
}
