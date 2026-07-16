import { describe, it, expect } from 'vitest';
import { deriveConstraintTests } from '../../../src/core/test-gen/constraint-test-generator';
import type { FormField } from '../../../src/storage/schemas';

const field = (partial: Partial<FormField>): FormField =>
  ({ selector: '#f', type: 'text', label: 'Field', name: 'field', required: false, ...partial } as FormField);

describe('deriveConstraintTests — scope + oracle correctness', () => {
  it('does NOT generate character-length boundary tests for a number field', () => {
    // A number input uses min/max VALUE, not minLength/maxLength character count.
    // Building a length-N digit string is meaningless and can blow past `max`.
    const specs = deriveConstraintTests(
      [field({ type: 'number', label: 'Age', maxLength: 5, minLength: 2, min: '0', max: '120' })],
      'Signup',
    );
    expect(specs.some((s) => /length/i.test(s.title))).toBe(false);
    // It should still produce numeric min/max VALUE boundary tests.
    expect(specs.some((s) => /max|min/i.test(s.title))).toBe(true);
  });

  it('generates character-length boundary tests for a text field', () => {
    const specs = deriveConstraintTests(
      [field({ type: 'text', label: 'Bio', maxLength: 10 })],
      'Profile',
    );
    const maxLenTests = specs.filter((s) => /length/i.test(s.title));
    expect(maxLenTests.length).toBeGreaterThan(0);
    // The "at max length" value must be exactly maxLength chars.
    const atMax = specs.find((s) => s.title.includes('at max length'));
    expect(atMax?.testValue.length).toBe(10);
  });

  it('keeps an email length-boundary value syntactically valid (length is the variable under test, not format)', () => {
    const specs = deriveConstraintTests(
      [field({ type: 'email', label: 'Email', maxLength: 20 })],
      'Signup',
    );
    const atMax = specs.find((s) => s.title.includes('at max length'));
    expect(atMax).toBeDefined();
    expect(atMax!.testValue.length).toBe(20);
    expect(atMax!.testValue).toContain('@');
  });

  it('gives the XSS/special-char test a real security oracle, not just "did not crash"', () => {
    const specs = deriveConstraintTests(
      [field({ type: 'text', label: 'Comment' })],
      'Feedback',
    );
    const xss = specs.find((s) => s.testValue.includes('<script>'));
    expect(xss).toBeDefined();
    expect(xss!.customVerify).toBeTruthy();
    // Oracle must check for reflection/execution, not merely absence of a crash.
    expect(xss!.customVerify!.toLowerCase()).toMatch(/escap|inert|not.*execut|not.*render/);
  });
});
