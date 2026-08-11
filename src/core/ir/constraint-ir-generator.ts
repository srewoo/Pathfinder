/**
 * Deterministic negative-test generation (fix.md §9).
 *
 * Every HTML constraint mechanically implies boundary and invalid-input cases:
 * `required` implies "submit empty", `maxLength` implies "one character over",
 * `type=email` implies "malformed address". None of that needs a language model,
 * and paying tokens for it buys nothing but non-determinism.
 *
 * Zero tokens. Same input, byte-identical IR — which also makes it the only test
 * generator that can be regression-tested exactly.
 */
import type { FormField } from '../../storage/schemas';
import type { Assertion, Step, TestIR } from './test-ir';
import { IR_VERSION, parseTestIR } from './test-ir';
import { fromCss, type Locator } from '../locator';

export interface ConstraintGenInput {
  /** Page the form lives on. */
  url: string;
  formName?: string;
  fields: readonly FormField[];
  /** Locator for the submit control. */
  submitLocator?: Locator;
  /** Injected so output is deterministic and testable. */
  now?: number;
  idPrefix?: string;
}

/** An invalid value plus why it violates the constraint it targets. */
interface NegativeCase {
  value: string;
  violates: string;
  label: string;
}

export function generateConstraintTests(input: ConstraintGenInput): TestIR[] {
  const now = input.now ?? 0;
  const prefix = input.idPrefix ?? 'constraint';
  const tests: TestIR[] = [];

  const fillable = input.fields.filter((f) => isFillable(f));

  // ── Required-field omission ───────────────────────────────────────────────
  const required = fillable.filter((f) => f.required);
  for (const field of required) {
    const others = fillable.filter((f) => f !== field && f.required);
    const steps: Step[] = [{ order: 0, action: 'navigate', value: input.url, description: `Open ${input.url}` }];

    let order = 1;
    for (const other of others) {
      steps.push({
        order: order++,
        action: 'type',
        locator: locatorFor(other),
        value: validValueFor(other),
        description: `Fill "${labelOf(other)}" with a valid value`,
      });
    }

    if (input.submitLocator) {
      steps.push({
        order: order++,
        action: 'click',
        locator: input.submitLocator,
        description: 'Submit the form',
      });
    }

    tests.push(
      build({
        id: `${prefix}-required-${slug(labelOf(field))}`,
        name: `${formLabel(input)} rejects submission with "${labelOf(field)}" empty`,
        url: input.url,
        now,
        steps,
        assertions: [
          {
            order: 0,
            kind: 'not_visible',
            locator: successLocator(),
            description: 'No success confirmation appears',
            // Grounded: derived from a real `required` attribute, not guessed.
            confidence: 'grounded',
          },
        ],
        tags: ['negative', 'required', 'deterministic'],
      })
    );
  }

  // ── Per-field constraint violations ───────────────────────────────────────
  for (const field of fillable) {
    for (const negative of negativeCasesFor(field)) {
      const steps: Step[] = [
        { order: 0, action: 'navigate', value: input.url, description: `Open ${input.url}` },
      ];
      let order = 1;

      // Fill the other required fields so the failure is unambiguously about
      // THIS constraint rather than a missing sibling.
      for (const other of fillable) {
        if (other === field) continue;
        if (!other.required) continue;
        steps.push({
          order: order++,
          action: 'type',
          locator: locatorFor(other),
          value: validValueFor(other),
          description: `Fill "${labelOf(other)}" with a valid value`,
        });
      }

      steps.push({
        order: order++,
        action: 'type',
        locator: locatorFor(field),
        value: negative.value,
        description: `Enter ${negative.label} into "${labelOf(field)}"`,
      });

      if (input.submitLocator) {
        steps.push({
          order: order++,
          action: 'click',
          locator: input.submitLocator,
          description: 'Submit the form',
        });
      }

      tests.push(
        build({
          id: `${prefix}-${negative.violates}-${slug(labelOf(field))}`,
          name: `${formLabel(input)} rejects ${negative.label} in "${labelOf(field)}"`,
          url: input.url,
          now,
          steps,
          assertions: [
            {
              order: 0,
              kind: 'not_visible',
              locator: successLocator(),
              description: `No success confirmation appears for ${negative.violates} violation`,
              confidence: 'grounded',
            },
          ],
          tags: ['negative', negative.violates, 'deterministic'],
        })
      );
    }
  }

  return tests;
}

// ── Case derivation ─────────────────────────────────────────────────────────

/**
 * Boundary and invalid cases implied by a field's constraints.
 *
 * Only emits a case when the constraint actually exists — inventing a maxLength
 * that the field never declared would produce a test asserting behaviour the app
 * never promised, which is a false positive.
 */
export function negativeCasesFor(field: FormField): NegativeCase[] {
  const cases: NegativeCase[] = [];

  if (typeof field.maxLength === 'number' && field.maxLength > 0) {
    cases.push({
      value: 'a'.repeat(field.maxLength + 1),
      violates: 'maxlength',
      label: `a value ${field.maxLength + 1} characters long (max ${field.maxLength})`,
    });
  }

  if (typeof field.minLength === 'number' && field.minLength > 1) {
    cases.push({
      value: 'a'.repeat(field.minLength - 1),
      violates: 'minlength',
      label: `a value ${field.minLength - 1} characters long (min ${field.minLength})`,
    });
  }

  switch (field.type) {
    case 'email':
      cases.push({ value: 'not-an-email', violates: 'type-email', label: 'a malformed email' });
      break;
    case 'number':
      cases.push({ value: 'abc', violates: 'type-number', label: 'non-numeric text' });
      break;
    case 'url':
      cases.push({ value: 'htp:/bad', violates: 'type-url', label: 'a malformed URL' });
      break;
    case 'tel':
      cases.push({ value: 'not a phone', violates: 'type-tel', label: 'a non-numeric phone' });
      break;
    default:
      break;
  }

  // A pattern is only testable if we can produce a string that provably fails
  // it. Generating a counterexample from an arbitrary regex is not decidable in
  // general, so try a small fixed set and emit nothing if all of them match.
  if (field.pattern) {
    const counterexample = findPatternCounterexample(field.pattern);
    if (counterexample !== null) {
      cases.push({
        value: counterexample,
        violates: 'pattern',
        label: `a value violating the required format`,
      });
    }
  }

  return cases;
}

const PATTERN_PROBES = ['!!!invalid!!!', ' ', 'a', '0', '@@@', '-1', 'x'.repeat(80)];

/** First probe the pattern rejects, or null if the pattern accepts them all. */
export function findPatternCounterexample(pattern: string): string | null {
  let re: RegExp;
  try {
    // HTML `pattern` is implicitly anchored.
    re = new RegExp(`^(?:${pattern})$`);
  } catch {
    // An invalid regex in the page is not something to build a test around.
    return null;
  }
  for (const probe of PATTERN_PROBES) {
    if (!re.test(probe)) return probe;
  }
  return null;
}

/** A value that should satisfy the field, for filling siblings. */
export function validValueFor(field: FormField): string {
  const min = typeof field.minLength === 'number' ? field.minLength : 0;
  const pad = (s: string) => (s.length >= min ? s : s + 'a'.repeat(min - s.length));

  switch (field.type) {
    case 'email':
      return pad('test@example.com');
    case 'number':
      return '1';
    case 'url':
      return pad('https://example.com');
    case 'tel':
      return pad('5551234567');
    case 'password':
      return pad('Passw0rd!23');
    case 'date':
      return '2020-01-01';
    default: {
      if (field.options && field.options.length > 0) return field.options[0];
      const base = 'Test Value';
      const capped =
        typeof field.maxLength === 'number' && field.maxLength > 0
          ? base.slice(0, field.maxLength)
          : base;
      return pad(capped);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isFillable(field: FormField): boolean {
  const t = (field.type ?? '').toLowerCase();
  return !['submit', 'button', 'reset', 'hidden', 'image', 'file'].includes(t);
}

/**
 * Locator for a discovered field.
 *
 * Exploration captured a CSS selector, so this starts structural — but the
 * field's label is a real accessible name, so a semantic tier is added when one
 * exists. Resolution then prefers the durable tier and only falls back to CSS,
 * which is §5's ladder rather than a bare selector string.
 */
function locatorFor(field: FormField): Locator {
  const css = field.selector || (field.name ? `[name="${field.name}"]` : '');
  const label = field.label?.trim();

  if (label) {
    return {
      semantic: { role: semanticRoleFor(field), name: label },
      structural: css ? { css } : undefined,
      preferredTier: 'semantic',
      label: labelOf(field),
    };
  }
  return fromCss(css, labelOf(field));
}

function semanticRoleFor(field: FormField): 'textbox' | 'combobox' | 'checkbox' | 'radio' | 'searchbox' | 'spinbutton' {
  switch ((field.type ?? '').toLowerCase()) {
    case 'select':
      return 'combobox';
    case 'checkbox':
      return 'checkbox';
    case 'radio':
      return 'radio';
    case 'search':
      return 'searchbox';
    case 'number':
      return 'spinbutton';
    default:
      return 'textbox';
  }
}

/**
 * Generic success-banner locator.
 *
 * Structural by necessity: we cannot know the app's success markup up front.
 * Being honest about that (rather than dressing it up as semantic) means it
 * surfaces in the testability report as something worth a `data-testid`.
 */
function successLocator(): Locator {
  return fromCss(
    '[role="status"], .success, .alert-success, [data-testid="success"]',
    'success confirmation'
  );
}

function labelOf(field: FormField): string {
  return field.label || field.name || field.selector || 'field';
}

function formLabel(input: ConstraintGenInput): string {
  return input.formName ? `Form "${input.formName}"` : 'Form';
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'field';
}

function build(args: {
  id: string;
  name: string;
  url: string;
  now: number;
  steps: Step[];
  assertions: Assertion[];
  tags: string[];
}): TestIR {
  return parseTestIR({
    irVersion: IR_VERSION,
    id: args.id,
    name: args.name,
    startUrl: args.url,
    provenance: {
      source: 'constraint',
      promptVersion: 'n/a',
      model: 'n/a',
      generatedAt: args.now,
      // The flag §9 cares about: this cost nothing and is reproducible.
      deterministic: true,
    },
    steps: args.steps,
    assertions: args.assertions,
    tags: args.tags,
  });
}
