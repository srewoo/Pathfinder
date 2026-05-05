/**
 * Constraint-Based Test Generator
 *
 * Derives deterministic boundary-value test cases from FormField metadata
 * (minLength, maxLength, min, max, pattern, required, type, options).
 * No AI call — purely structural. Complements AI-generated tests.
 */

import type { FormField, TestCase } from '../../storage/schemas.js';
import { testCaseRepo } from '../../storage/repositories/test-case-repo.js';
import { generateId } from '../../utils/hash.js';

export interface ConstraintTestSpec {
  title: string;
  description: string;
  type: TestCase['type'];
  steps: string[];
}

/**
 * Derive constraint-based boundary-value test specs from form field metadata.
 */
export function deriveConstraintTests(fields: FormField[], flowName: string): ConstraintTestSpec[] {
  const specs: ConstraintTestSpec[] = [];

  for (const field of fields) {
    const label = field.label || field.name || field.type;

    // Required field — empty submission
    if (field.required) {
      specs.push({
        title: `${flowName}: Leave required field "${label}" empty`,
        description: `Submit the form with "${label}" left blank. Expect a required field validation error.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Leave the "${label}" field empty`,
          `Submit the form`,
          `Verify a validation error is shown for "${label}"`,
        ],
      });

      // Whitespace-only (looks filled but is not)
      specs.push({
        title: `${flowName}: Submit "${label}" with whitespace only`,
        description: `Enter only spaces in the required "${label}" field. Expect a validation error.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter only spaces in the "${label}" field`,
          `Submit the form`,
          `Verify a validation error is shown for "${label}"`,
        ],
      });
    }

    // maxLength boundary
    if (field.maxLength !== undefined) {
      // Over limit
      const overValue = 'a'.repeat(field.maxLength + 1);
      specs.push({
        title: `${flowName}: Enter ${field.maxLength + 1} chars in "${label}" (over maxLength)`,
        description: `Enter a value ${field.maxLength + 1} characters long in "${label}" which has a maxLength of ${field.maxLength}. Expect rejection or truncation.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter "${overValue.slice(0, 30)}..." (${field.maxLength + 1} chars) into "${label}"`,
          `Submit the form`,
          `Verify the input is rejected or truncated to ${field.maxLength} characters`,
        ],
      });

      // At limit (valid boundary)
      const atValue = 'a'.repeat(field.maxLength);
      specs.push({
        title: `${flowName}: Enter exactly ${field.maxLength} chars in "${label}" (at maxLength)`,
        description: `Enter exactly ${field.maxLength} characters in "${label}". Expect acceptance.`,
        type: 'edge',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter a string of exactly ${field.maxLength} characters into "${label}"`,
          `Submit the form`,
          `Verify the form is accepted`,
        ],
      });
      void atValue; // suppress unused warning
    }

    // minLength boundary
    if (field.minLength !== undefined && field.minLength > 0) {
      const belowValue = 'a'.repeat(Math.max(0, field.minLength - 1));
      specs.push({
        title: `${flowName}: Enter ${field.minLength - 1} chars in "${label}" (below minLength)`,
        description: `Enter ${field.minLength - 1} characters in "${label}" which requires at least ${field.minLength}. Expect rejection.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter "${belowValue || '(empty)'}" into "${label}"`,
          `Submit the form`,
          `Verify a minimum length validation error is shown for "${label}"`,
        ],
      });
    }

    // Numeric min/max boundaries
    if (field.type === 'number' || field.type === 'range') {
      if (field.min !== undefined) {
        const belowMin = (parseFloat(field.min) - 1).toString();
        specs.push({
          title: `${flowName}: Enter ${belowMin} in "${label}" (below min)`,
          description: `Enter a value below the minimum (${field.min}) for "${label}". Expect rejection.`,
          type: 'negative',
          steps: [
            `Navigate to the ${flowName} page`,
            `Enter ${belowMin} into "${label}"`,
            `Submit the form`,
            `Verify a minimum value error is shown for "${label}"`,
          ],
        });
      }

      if (field.max !== undefined) {
        const aboveMax = (parseFloat(field.max) + 1).toString();
        specs.push({
          title: `${flowName}: Enter ${aboveMax} in "${label}" (above max)`,
          description: `Enter a value above the maximum (${field.max}) for "${label}". Expect rejection.`,
          type: 'negative',
          steps: [
            `Navigate to the ${flowName} page`,
            `Enter ${aboveMax} into "${label}"`,
            `Submit the form`,
            `Verify a maximum value error is shown for "${label}"`,
          ],
        });
      }

      if (field.min !== undefined && field.max !== undefined) {
        const mid = ((parseFloat(field.min) + parseFloat(field.max)) / 2).toString();
        specs.push({
          title: `${flowName}: Enter boundary value ${mid} in "${label}"`,
          description: `Enter the midpoint value ${mid} (between min ${field.min} and max ${field.max}) for "${label}". Expect acceptance.`,
          type: 'edge',
          steps: [
            `Navigate to the ${flowName} page`,
            `Enter ${mid} into "${label}"`,
            `Submit the form`,
            `Verify the form is accepted`,
          ],
        });
      }
    }

    // Email/URL/tel format tests
    if (field.type === 'email') {
      specs.push({
        title: `${flowName}: Enter invalid email in "${label}"`,
        description: `Enter "not-an-email" in the email field "${label}". Expect format validation error.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter "not-an-email" into "${label}"`,
          `Submit the form`,
          `Verify an email format validation error is shown`,
        ],
      });
    }

    if (field.type === 'url') {
      specs.push({
        title: `${flowName}: Enter invalid URL in "${label}"`,
        description: `Enter "not a url" in the URL field "${label}". Expect format validation error.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter "not a url" into "${label}"`,
          `Submit the form`,
          `Verify a URL format validation error is shown`,
        ],
      });
    }

    // Pattern validation
    if (field.pattern) {
      specs.push({
        title: `${flowName}: Enter pattern-violating value in "${label}"`,
        description: `Enter a value that does not match the pattern /${field.pattern}/ for "${label}". Expect a validation error.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter "INVALID_PATTERN_VALUE_!!!@@@" into "${label}"`,
          `Submit the form`,
          `Verify a format validation error is shown for "${label}"`,
        ],
      });
    }

    // Select options — valid boundary
    if (field.type === 'select' && field.options && field.options.length > 0) {
      const lastOption = field.options[field.options.length - 1];
      specs.push({
        title: `${flowName}: Select last option "${lastOption}" for "${label}"`,
        description: `Select the last dropdown option to verify all options are functional.`,
        type: 'edge',
        steps: [
          `Navigate to the ${flowName} page`,
          `Select "${lastOption}" from "${label}"`,
          `Submit the form`,
          `Verify the form is accepted`,
        ],
      });
    }

    // Special characters
    if (field.type === 'text' || field.type === 'textarea' || !field.type) {
      specs.push({
        title: `${flowName}: Enter special characters in "${label}"`,
        description: `Enter special characters (<script>alert(1)</script>) in "${label}" to test input sanitization.`,
        type: 'negative',
        steps: [
          `Navigate to the ${flowName} page`,
          `Enter "<script>alert(1)</script>" into "${label}"`,
          `Submit the form`,
          `Verify the input is sanitized and no script is executed`,
        ],
      });
    }
  }

  return specs;
}

/**
 * Save constraint test specs to the database. Returns the saved TestCase records.
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
      steps: spec.steps,
      startUrl,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await testCaseRepo.put(testCase);
    saved.push(testCase);
  }
  return saved;
}

/**
 * Serialize form field constraints as structured text for AI prompt context.
 * More structured than plain `extractAllFormFields` text output.
 */
export function serializeFieldConstraints(fields: FormField[]): string {
  if (fields.length === 0) return 'No form fields captured.';

  return fields
    .map((f) => {
      const label = f.label || f.name || f.type;
      const constraints: string[] = [];
      if (f.required) constraints.push('required');
      if (f.minLength !== undefined) constraints.push(`minLength=${f.minLength}`);
      if (f.maxLength !== undefined) constraints.push(`maxLength=${f.maxLength}`);
      if (f.min !== undefined) constraints.push(`min=${f.min}`);
      if (f.max !== undefined) constraints.push(`max=${f.max}`);
      if (f.pattern) constraints.push(`pattern=${f.pattern}`);
      if (f.options?.length) constraints.push(`options=[${f.options.slice(0, 5).join(', ')}]`);
      const c = constraints.length > 0 ? ` [${constraints.join(', ')}]` : '';
      return `- ${label} (${f.type})${c}`;
    })
    .join('\n');
}
