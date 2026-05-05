/**
 * Constraint-Based Test Generator
 *
 * Generates explicit boundary-value and negative test cases directly from
 * FormField constraint metadata (minLength, maxLength, min, max, pattern,
 * required, type, options). These tests are deterministic — no AI call needed.
 */

import type { FormField, FormSubmissionOutcome, TestCase } from '../../storage/schemas';
import { generateId } from '../../utils/hash';
import { testCaseDB } from '../../storage/indexed-db';

export interface ConstraintTestSpec {
  title: string;
  description: string;
  type: TestCase['type'];
  fieldSelector: string;
  fieldLabel: string;
  testValue: string;
  expectError: boolean;
  errorHint: string;
  /** Observed error selector from exploration — grounds the assertion to a real DOM element */
  observedErrorSelector?: string;
  /** Observed error message text from exploration */
  observedErrorMessage?: string;
  /** Observed success message selector from exploration */
  observedSuccessSelector?: string;
  /** Observed success message text from exploration */
  observedSuccessMessage?: string;
  /** Submit button selector from exploration */
  submitSelector?: string;
}

/**
 * Derive boundary-value and negative constraint tests from FormField metadata.
 * Returns test specs — call saveConstraintTests() to persist them.
 */
export function deriveConstraintTests(
  fields: FormField[],
  flowName: string,
  formOutcomes?: FormSubmissionOutcome[]
): ConstraintTestSpec[] {
  const specs: ConstraintTestSpec[] = [];

  // Extract observed error/success selectors from form outcomes to ground assertions
  const emptyOutcome = formOutcomes?.find((o) => o.filledFields.length === 0);
  const filledOutcome = formOutcomes?.find((o) => o.filledFields.length > 0);
  const observedErrorSelector = emptyOutcome?.errorSelectors?.[0];
  const observedSuccessMessage = filledOutcome?.result === 'success' ? filledOutcome.resultMessage : undefined;
  const submitSelector = emptyOutcome?.submitSelector ?? filledOutcome?.submitSelector;

  // Build field→error mapping from observed field errors
  const fieldErrorMap = new Map<string, { selector: string; message: string }>();
  for (const outcome of formOutcomes ?? []) {
    for (const fe of outcome.fieldErrors ?? []) {
      fieldErrorMap.set(fe.fieldSelector, { selector: fe.errorSelector, message: fe.errorMessage });
    }
  }

  for (const field of fields) {
    const label = field.label || field.name || field.type;

    // 1. Required field — empty submission
    if (field.required) {
      specs.push({
        title: `${flowName} — "${label}" required field left empty`,
        description: `Submit the form with the "${label}" field empty. Expects a required-field validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: '',
        expectError: true,
        errorHint: `Required field "${label}" must show an error when empty`,
      });

      // Whitespace-only is also effectively empty for text fields
      if (['text', 'textarea', 'search'].includes(field.type)) {
        specs.push({
          title: `${flowName} — "${label}" whitespace-only input`,
          description: `Enter only spaces in required "${label}". Expects a validation error.`,
          type: 'edge',
          fieldSelector: field.selector,
          fieldLabel: label,
          testValue: '   ',
          expectError: true,
          errorHint: `"${label}" should treat whitespace-only as empty`,
        });
      }
    }

    // 2. maxLength boundary
    if (field.maxLength !== undefined && field.maxLength > 0) {
      specs.push({
        title: `${flowName} — "${label}" at max length (${field.maxLength} chars)`,
        description: `Enter exactly ${field.maxLength} characters. Should be accepted.`,
        type: 'edge',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: buildString(field.maxLength, field.type),
        expectError: false,
        errorHint: '',
      });
      specs.push({
        title: `${flowName} — "${label}" exceeds max length (${field.maxLength + 1} chars)`,
        description: `Enter ${field.maxLength + 1} characters. Expects a max-length validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: buildString(field.maxLength + 1, field.type),
        expectError: true,
        errorHint: `"${label}" should reject input longer than ${field.maxLength} characters`,
      });
    }

    // 3. minLength boundary
    if (field.minLength !== undefined && field.minLength > 1) {
      specs.push({
        title: `${flowName} — "${label}" below min length (${field.minLength - 1} chars)`,
        description: `Enter ${field.minLength - 1} characters. Expects a min-length validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: buildString(Math.max(1, field.minLength - 1), field.type),
        expectError: true,
        errorHint: `"${label}" should reject input shorter than ${field.minLength} characters`,
      });
    }

    // 4. Number min / max
    if (field.type === 'number') {
      if (field.min !== undefined) {
        const minVal = Number(field.min);
        if (!isNaN(minVal)) {
          specs.push({
            title: `${flowName} — "${label}" below minimum (${minVal - 1})`,
            description: `Enter ${minVal - 1} in "${label}". Expects a range validation error.`,
            type: 'negative',
            fieldSelector: field.selector,
            fieldLabel: label,
            testValue: String(minVal - 1),
            expectError: true,
            errorHint: `"${label}" should reject values below ${minVal}`,
          });
          specs.push({
            title: `${flowName} — "${label}" at minimum boundary (${minVal})`,
            description: `Enter exactly ${minVal} in "${label}". Should be accepted.`,
            type: 'edge',
            fieldSelector: field.selector,
            fieldLabel: label,
            testValue: String(minVal),
            expectError: false,
            errorHint: '',
          });
        }
      }
      if (field.max !== undefined) {
        const maxVal = Number(field.max);
        if (!isNaN(maxVal)) {
          specs.push({
            title: `${flowName} — "${label}" above maximum (${maxVal + 1})`,
            description: `Enter ${maxVal + 1} in "${label}". Expects a range validation error.`,
            type: 'negative',
            fieldSelector: field.selector,
            fieldLabel: label,
            testValue: String(maxVal + 1),
            expectError: true,
            errorHint: `"${label}" should reject values above ${maxVal}`,
          });
          specs.push({
            title: `${flowName} — "${label}" at maximum boundary (${maxVal})`,
            description: `Enter exactly ${maxVal} in "${label}". Should be accepted.`,
            type: 'edge',
            fieldSelector: field.selector,
            fieldLabel: label,
            testValue: String(maxVal),
            expectError: false,
            errorHint: '',
          });
        }
      }
    }

    // 5. Format validation
    if (field.type === 'email') {
      specs.push({
        title: `${flowName} — "${label}" invalid email format`,
        description: `Enter "not-an-email" in "${label}". Expects format validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: 'not-an-email',
        expectError: true,
        errorHint: `"${label}" should reject invalid email formats`,
      });
      specs.push({
        title: `${flowName} — "${label}" valid email accepted`,
        description: `Enter "test@example.com" in "${label}". Should be accepted.`,
        type: 'positive',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: 'test@example.com',
        expectError: false,
        errorHint: '',
      });
    }
    if (field.type === 'url') {
      specs.push({
        title: `${flowName} — "${label}" invalid URL`,
        description: `Enter "not a url" in "${label}". Expects format validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: 'not a url',
        expectError: true,
        errorHint: `"${label}" should reject invalid URLs`,
      });
    }
    if (field.type === 'tel') {
      specs.push({
        title: `${flowName} — "${label}" non-numeric phone`,
        description: `Enter "abc-xyz" in phone "${label}". Expects format validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: 'abc-xyz',
        expectError: true,
        errorHint: `"${label}" should reject non-numeric phone input`,
      });
    }

    // 6. Pattern validation
    if (field.pattern) {
      specs.push({
        title: `${flowName} — "${label}" violates pattern (${field.pattern})`,
        description: `Enter "!@#$%" in "${label}" which violates the pattern constraint. Expects validation error.`,
        type: 'negative',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: '!@#$%',
        expectError: true,
        errorHint: `"${label}" should reject values not matching the pattern`,
      });
    }

    // 7. Select options — test first valid option and invalid input
    if (field.type === 'select' && field.options && field.options.length > 0) {
      specs.push({
        title: `${flowName} — "${label}" select first valid option`,
        description: `Select "${field.options[0]}" from "${label}" dropdown. Should succeed.`,
        type: 'positive',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: field.options[0],
        expectError: false,
        errorHint: '',
      });
      if (field.options.length > 1) {
        specs.push({
          title: `${flowName} — "${label}" select last option`,
          description: `Select "${field.options[field.options.length - 1]}" from "${label}". Should succeed.`,
          type: 'edge',
          fieldSelector: field.selector,
          fieldLabel: label,
          testValue: field.options[field.options.length - 1],
          expectError: false,
          errorHint: '',
        });
      }
    }

    // 8. Special characters in text fields
    if (['text', 'textarea'].includes(field.type) && !field.pattern) {
      specs.push({
        title: `${flowName} — "${label}" special characters input`,
        description: `Enter special characters "<script>alert(1)</script>" in "${label}". Should be handled safely.`,
        type: 'edge',
        fieldSelector: field.selector,
        fieldLabel: label,
        testValue: '<script>alert(1)</script>',
        expectError: false, // most apps accept and sanitize, not error
        errorHint: `"${label}" should handle special characters without crashing`,
      });
    }
  }

  // ── Conditional field visibility tests ────────────────────────────────
  // Generate tests for fields that have visibleWhen rules:
  // 1. When trigger has the required value → field should be visible
  // 2. When trigger has a different value → field should be hidden
  for (const field of fields) {
    if (!field.visibleWhen) continue;
    const label = field.label || field.name || field.type;
    const { fieldSelector: triggerSel, fieldValue: triggerVal } = field.visibleWhen;

    specs.push({
      title: `${flowName} — "${label}" visible when trigger = "${triggerVal}"`,
      description: `Select "${triggerVal}" in the trigger field (${triggerSel}), then verify "${label}" becomes visible.`,
      type: 'positive',
      fieldSelector: field.selector,
      fieldLabel: label,
      testValue: triggerVal,
      expectError: false,
      errorHint: '',
    });

    specs.push({
      title: `${flowName} — "${label}" hidden when trigger has other value`,
      description: `Set the trigger field (${triggerSel}) to a value other than "${triggerVal}", then verify "${label}" is NOT visible.`,
      type: 'edge',
      fieldSelector: field.selector,
      fieldLabel: label,
      testValue: '',
      expectError: false,
      errorHint: '',
    });
  }

  // Enrich all specs with observed assertion data from exploration
  for (const spec of specs) {
    spec.submitSelector = submitSelector;
    if (spec.expectError) {
      // Try field-specific error first, fall back to generic observed error
      const fieldErr = fieldErrorMap.get(spec.fieldSelector);
      if (fieldErr) {
        spec.observedErrorSelector = fieldErr.selector;
        spec.observedErrorMessage = fieldErr.message;
      } else if (observedErrorSelector) {
        spec.observedErrorSelector = observedErrorSelector;
      }
    } else {
      spec.observedSuccessMessage = observedSuccessMessage;
    }
  }

  // Deduplicate by title
  const seen = new Set<string>();
  return specs.filter((s) => {
    if (seen.has(s.title)) return false;
    seen.add(s.title);
    return true;
  });
}

/**
 * Persist constraint test specs as TestCase records.
 * Returns the saved TestCases.
 */
export async function saveConstraintTests(
  specs: ConstraintTestSpec[],
  sourceFlowId: string,
  startUrl?: string
): Promise<TestCase[]> {
  const saved: TestCase[] = [];
  for (const spec of specs) {
    const testCase: TestCase = {
      id: generateId(),
      title: spec.title,
      description: spec.description,
      type: spec.type,
      sourceFlowId,
      source: 'generated',
      steps: buildStepsFromSpec(spec),
      startUrl,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await testCaseDB.put(testCase);
    saved.push(testCase);
  }
  return saved;
}

function buildStepsFromSpec(spec: ConstraintTestSpec): string[] {
  const steps: string[] = [];
  if (spec.testValue === '') {
    steps.push(`Leave the "${spec.fieldLabel}" field empty`);
  } else {
    steps.push(`Enter "${spec.testValue}" in the "${spec.fieldLabel}" field (${spec.fieldSelector})`);
  }

  // Use observed submit selector when available for grounded submit action
  const submitAction = spec.submitSelector
    ? `Click the submit button (${spec.submitSelector})`
    : 'Submit the form';
  steps.push(submitAction);

  if (spec.expectError) {
    // Use observed error selector + message for grounded assertions
    if (spec.observedErrorSelector && spec.observedErrorMessage) {
      steps.push(`Verify error message "${spec.observedErrorMessage}" is visible at ${spec.observedErrorSelector}`);
    } else if (spec.observedErrorSelector) {
      steps.push(`Verify that an error element is visible at ${spec.observedErrorSelector}`);
    } else {
      steps.push(`Verify that a validation error is shown: ${spec.errorHint}`);
    }
  } else {
    // Use observed success selector + message for grounded assertions
    if (spec.observedSuccessSelector && spec.observedSuccessMessage) {
      steps.push(`Verify success message "${spec.observedSuccessMessage}" is visible at ${spec.observedSuccessSelector}`);
    } else if (spec.observedSuccessMessage) {
      steps.push(`Verify success message "${spec.observedSuccessMessage}" is shown`);
    } else {
      steps.push(`Verify the form is accepted without errors`);
    }
  }
  return steps;
}

/**
 * Serialize form fields for the AI prompt with full constraint details.
 * Much more informative than plain extractAllFormFields text.
 */
export function serializeFieldConstraints(fields: FormField[]): string {
  if (fields.length === 0) return 'No form fields discovered.';
  return fields.map((f) => {
    const parts = [
      `Field: ${f.label || f.name || f.type}`,
      `  selector: ${f.selector}`,
      `  type: ${f.type}`,
      `  required: ${f.required}`,
    ];
    if (f.minLength !== undefined) parts.push(`  minLength: ${f.minLength}`);
    if (f.maxLength !== undefined) parts.push(`  maxLength: ${f.maxLength}`);
    if (f.min !== undefined) parts.push(`  min: ${f.min}`);
    if (f.max !== undefined) parts.push(`  max: ${f.max}`);
    if (f.pattern) parts.push(`  pattern: ${f.pattern}`);
    if (f.placeholder) parts.push(`  placeholder: "${f.placeholder}"`);
    if (f.options?.length) parts.push(`  options: [${f.options.slice(0, 10).join(', ')}]`);
    return parts.join('\n');
  }).join('\n\n');
}

function buildString(length: number, fieldType: string): string {
  if (fieldType === 'email') return `${'a'.repeat(Math.max(1, length - 10))}@test.com`.slice(0, length);
  if (fieldType === 'number') return '1'.repeat(length);
  return 'a'.repeat(length);
}
