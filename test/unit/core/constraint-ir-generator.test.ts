import { describe, it, expect } from 'vitest';
import {
  findPatternCounterexample,
  generateConstraintTests,
  negativeCasesFor,
  validValueFor,
} from '../../../src/core/ir/constraint-ir-generator';
import { serializeIR } from '../../../src/core/ir/test-ir';
import { fromTestId } from '../../../src/core/locator';
import type { FormField } from '../../../src/storage/schemas';

function field(overrides: Partial<FormField> = {}): FormField {
  return {
    selector: '#email',
    label: 'Email',
    type: 'email',
    name: 'email',
    required: true,
    ...overrides,
  };
}

const input = (fields: FormField[]) => ({
  url: 'https://app.test/signup',
  formName: 'Signup',
  fields,
  submitLocator: fromTestId('submit'),
  now: 1000,
});

describe('negativeCasesFor', () => {
  it('given_a_maxLength_then_a_one_over_boundary_case_is_produced', () => {
    const cases = negativeCasesFor(field({ type: 'text', maxLength: 10 }));
    const c = cases.find((x) => x.violates === 'maxlength');
    expect(c?.value).toHaveLength(11);
  });

  it('given_a_minLength_then_a_one_under_boundary_case_is_produced', () => {
    const cases = negativeCasesFor(field({ type: 'text', minLength: 8 }));
    const c = cases.find((x) => x.violates === 'minlength');
    expect(c?.value).toHaveLength(7);
  });

  it('given_a_minLength_of_one_then_no_underflow_case_is_produced', () => {
    // minLength 1 underflows to the empty string, which is the `required` case —
    // emitting it here would duplicate that test.
    const cases = negativeCasesFor(field({ type: 'text', minLength: 1 }));
    expect(cases.some((c) => c.violates === 'minlength')).toBe(false);
  });

  it('given_an_email_type_then_a_malformed_email_case_is_produced', () => {
    expect(negativeCasesFor(field({ type: 'email' })).some((c) => c.violates === 'type-email')).toBe(
      true
    );
  });

  it('given_a_number_type_then_a_non_numeric_case_is_produced', () => {
    expect(
      negativeCasesFor(field({ type: 'number' })).some((c) => c.violates === 'type-number')
    ).toBe(true);
  });

  it('given_a_plain_text_field_with_no_constraints_then_no_cases_are_invented', () => {
    // Inventing a constraint the app never declared produces a test asserting
    // behaviour it never promised — a false positive.
    expect(negativeCasesFor(field({ type: 'text', required: false }))).toEqual([]);
  });

  it('given_a_pattern_then_a_counterexample_case_is_produced', () => {
    const cases = negativeCasesFor(field({ type: 'text', pattern: '[0-9]{5}' }));
    expect(cases.some((c) => c.violates === 'pattern')).toBe(true);
  });

  it('given_an_all_accepting_pattern_then_no_pattern_case_is_produced', () => {
    // No counterexample is derivable, so claiming one would be a guess.
    expect(negativeCasesFor(field({ type: 'text', pattern: '.*' })).some((c) => c.violates === 'pattern')).toBe(false);
  });
});

describe('findPatternCounterexample', () => {
  it('given_a_digit_pattern_then_a_non_digit_probe_is_returned', () => {
    const c = findPatternCounterexample('[0-9]+');
    expect(c).not.toBeNull();
    expect(new RegExp('^(?:[0-9]+)$').test(c!)).toBe(false);
  });

  it('given_an_invalid_regex_then_null_is_returned_rather_than_throwing', () => {
    expect(findPatternCounterexample('([unclosed')).toBeNull();
  });

  it('given_a_pattern_matching_everything_then_null_is_returned', () => {
    expect(findPatternCounterexample('[\\s\\S]*')).toBeNull();
  });
});

describe('validValueFor', () => {
  it('given_an_email_field_then_a_valid_email_is_produced', () => {
    expect(validValueFor(field({ type: 'email' }))).toContain('@');
  });

  it('given_a_minLength_then_the_valid_value_is_padded_to_satisfy_it', () => {
    const v = validValueFor(field({ type: 'text', minLength: 20 }));
    expect(v.length).toBeGreaterThanOrEqual(20);
  });

  it('given_a_maxLength_then_the_valid_value_respects_it', () => {
    const v = validValueFor(field({ type: 'text', maxLength: 4 }));
    expect(v.length).toBeLessThanOrEqual(4);
  });

  it('given_a_select_with_options_then_the_first_option_is_used', () => {
    expect(validValueFor(field({ type: 'select', options: ['UK', 'US'] }))).toBe('UK');
  });
});

describe('generateConstraintTests', () => {
  it('given_a_required_field_then_an_omission_test_is_produced', () => {
    const tests = generateConstraintTests(input([field({ type: 'text', label: 'Name' })]));
    const omission = tests.find((t) => t.tags.includes('required'));
    expect(omission?.name).toContain('empty');
  });

  it('given_every_generated_test_then_it_is_marked_deterministic_and_zero_cost', () => {
    // The §9 claim: this generator costs no tokens and is reproducible.
    const tests = generateConstraintTests(input([field({ type: 'email', maxLength: 50 })]));
    expect(tests.length).toBeGreaterThan(0);
    for (const t of tests) {
      expect(t.provenance.deterministic).toBe(true);
      expect(t.provenance.source).toBe('constraint');
      expect(t.provenance.model).toBe('n/a');
      expect(t.provenance.promptVersion).toBe('n/a');
    }
  });

  it('given_the_same_input_twice_then_the_output_is_byte_identical', () => {
    // Determinism is the property that makes this regression-testable at all.
    const a = generateConstraintTests(input([field({ type: 'email', maxLength: 20 })]));
    const b = generateConstraintTests(input([field({ type: 'email', maxLength: 20 })]));
    expect(a.map(serializeIR)).toEqual(b.map(serializeIR));
  });

  it('given_a_constraint_test_then_sibling_required_fields_are_filled_with_valid_values', () => {
    // Otherwise the rejection could be caused by the sibling, not the constraint
    // under test — an unattributable failure.
    const tests = generateConstraintTests(
      input([
        field({ selector: '#email', label: 'Email', type: 'email', required: true }),
        field({ selector: '#pw', label: 'Password', type: 'password', required: true, minLength: 8 }),
      ])
    );
    const emailCase = tests.find((t) => t.tags.includes('type-email'));
    const pwStep = emailCase?.steps.find((s) => s.description.includes('Password'));
    expect(pwStep?.value?.length).toBeGreaterThanOrEqual(8);
  });

  it('given_a_generated_test_then_it_always_carries_at_least_one_assertion', () => {
    const tests = generateConstraintTests(input([field({ type: 'email' })]));
    for (const t of tests) expect(t.assertions.length).toBeGreaterThan(0);
  });

  it('given_a_field_label_then_the_locator_prefers_the_semantic_tier', () => {
    // §5: a real accessible name is more durable than the captured CSS.
    const tests = generateConstraintTests(input([field({ label: 'Email', type: 'email' })]));
    const typeStep = tests
      .flatMap((t) => t.steps)
      .find((s) => s.action === 'type' && s.locator?.semantic);
    expect(typeStep?.locator?.preferredTier).toBe('semantic');
    expect(typeStep?.locator?.semantic?.name).toBe('Email');
    // The CSS is retained as a fallback tier rather than discarded.
    expect(typeStep?.locator?.structural?.css).toBe('#email');
  });

  it('given_non_fillable_fields_then_they_are_ignored', () => {
    const tests = generateConstraintTests(
      input([
        field({ selector: '#go', type: 'submit', label: 'Go', required: false }),
        field({ selector: '#h', type: 'hidden', label: 'Hidden', required: false }),
      ])
    );
    expect(tests).toEqual([]);
  });

  it('given_no_submit_locator_then_tests_are_still_produced_without_a_submit_step', () => {
    const tests = generateConstraintTests({
      url: 'https://app.test/f',
      fields: [field({ type: 'email' })],
      now: 1,
    });
    expect(tests.length).toBeGreaterThan(0);
    expect(tests.every((t) => t.steps.every((s) => s.description !== 'Submit the form'))).toBe(true);
  });

  it('given_generated_ids_then_they_are_stable_and_slug_safe', () => {
    const tests = generateConstraintTests(
      input([field({ label: 'Email Address / Login!', type: 'email' })])
    );
    for (const t of tests) expect(t.id).toMatch(/^[a-z0-9-]+$/);
  });
});
