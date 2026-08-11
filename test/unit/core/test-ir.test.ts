import { describe, it, expect } from 'vitest';
import {
  IRValidationError,
  IR_VERSION,
  interpolate,
  parseTestIR,
  parseTestIRBatch,
  placeholdersIn,
  safeParseTestIR,
  serializeIR,
} from '../../../src/core/ir/test-ir';
import { fromTestId } from '../../../src/core/locator';

function validIR(overrides: Record<string, unknown> = {}) {
  return {
    irVersion: IR_VERSION,
    id: 't1',
    name: 'User can sign in',
    startUrl: 'https://app.test/login',
    provenance: { source: 'exploration', generatedAt: 1000 },
    steps: [
      { order: 0, action: 'navigate', value: 'https://app.test/login', description: 'Open login' },
      {
        order: 1,
        action: 'type',
        locator: fromTestId('email'),
        value: 'a@b.co',
        description: 'Enter email',
      },
      { order: 2, action: 'click', locator: fromTestId('submit'), description: 'Submit' },
    ],
    assertions: [
      { order: 0, kind: 'url', expected: '/dashboard', description: 'Lands on dashboard' },
    ],
    ...overrides,
  };
}

describe('parseTestIR — the determinism gate', () => {
  it('given_a_valid_ir_then_it_parses_and_defaults_are_applied', () => {
    const ir = parseTestIR(validIR());
    expect(ir.name).toBe('User can sign in');
    expect(ir.tags).toEqual([]);
    expect(ir.provenance.promptVersion).toBe('n/a');
    expect(ir.provenance.deterministic).toBe(false);
    expect(ir.assertions[0].confidence).toBe('inferred');
  });

  it('given_a_wrong_ir_version_then_it_is_rejected', () => {
    // Versioned on purpose: a future shape change must be a migration, not a
    // silent misparse.
    expect(() => parseTestIR(validIR({ irVersion: '2' }))).toThrow(IRValidationError);
  });

  it('given_a_test_with_no_assertions_then_it_is_rejected', () => {
    // A test that asserts nothing always passes — worse than no test at all.
    expect(() => parseTestIR(validIR({ assertions: [] }))).toThrow(/no assertions/);
  });

  it('given_a_click_step_without_a_locator_then_it_is_rejected', () => {
    expect(() =>
      parseTestIR(
        validIR({
          steps: [{ order: 0, action: 'click', description: 'Click something' }],
        })
      )
    ).toThrow(/requires a locator/);
  });

  it('given_a_type_step_without_a_value_then_it_is_rejected', () => {
    expect(() =>
      parseTestIR(
        validIR({
          steps: [
            { order: 0, action: 'type', locator: fromTestId('x'), description: 'Type nothing' },
          ],
        })
      )
    ).toThrow(/requires a value/);
  });

  it('given_a_drag_drop_without_a_target_then_it_is_rejected', () => {
    expect(() =>
      parseTestIR(
        validIR({
          steps: [
            { order: 0, action: 'drag_drop', locator: fromTestId('a'), description: 'Drag' },
          ],
        })
      )
    ).toThrow(/requires a targetLocator/);
  });

  it('given_a_capture_without_a_name_then_it_is_rejected', () => {
    expect(() =>
      parseTestIR(
        validIR({
          steps: [
            { order: 0, action: 'capture', locator: fromTestId('a'), description: 'Capture' },
          ],
        })
      )
    ).toThrow(/requires captureAs/);
  });

  it('given_a_step_with_an_empty_description_then_it_is_rejected', () => {
    // An unexplained step is unreviewable, which defeats the point of the IR.
    expect(() =>
      parseTestIR(
        validIR({
          steps: [{ order: 0, action: 'navigate', value: 'https://a/', description: '' }],
        })
      )
    ).toThrow();
  });

  it('given_a_wait_action_then_it_is_rejected_because_waiting_belongs_to_the_driver', () => {
    // §8 moved waiting into actionability preconditions. Keeping `wait` in the
    // vocabulary would let generators paper over real flake with sleeps.
    expect(() =>
      parseTestIR(
        validIR({
          steps: [{ order: 0, action: 'wait', value: '3000', description: 'Wait 3s' }],
        })
      )
    ).toThrow();
  });
});

describe('capture placeholder ordering', () => {
  it('given_a_capture_used_by_a_later_step_then_it_is_valid', () => {
    const ir = parseTestIR(
      validIR({
        steps: [
          {
            order: 0,
            action: 'capture',
            locator: fromTestId('order-id'),
            captureAs: 'orderId',
            captureFrom: 'text',
            description: 'Capture order id',
          },
          {
            order: 1,
            action: 'type',
            locator: fromTestId('search'),
            value: '{{orderId}}',
            description: 'Search for it',
          },
        ],
      })
    );
    expect(ir.steps).toHaveLength(2);
  });

  it('given_a_forward_reference_to_a_capture_then_it_is_rejected', () => {
    // Otherwise the literal "{{orderId}}" is typed into the field and the test
    // fails for a reason that looks nothing like the cause.
    expect(() =>
      parseTestIR(
        validIR({
          steps: [
            {
              order: 0,
              action: 'type',
              locator: fromTestId('search'),
              value: '{{orderId}}',
              description: 'Search too early',
            },
            {
              order: 1,
              action: 'capture',
              locator: fromTestId('order-id'),
              captureAs: 'orderId',
              description: 'Capture later',
            },
          ],
        })
      )
    ).toThrow(/nothing captured it yet/);
  });

  it('given_an_unknown_placeholder_then_it_is_rejected', () => {
    expect(() =>
      parseTestIR(
        validIR({
          steps: [
            {
              order: 0,
              action: 'type',
              locator: fromTestId('x'),
              value: '{{nope}}',
              description: 'Use undefined var',
            },
          ],
        })
      )
    ).toThrow(/\{\{nope\}\}/);
  });
});

describe('placeholdersIn / interpolate', () => {
  it('given_a_value_with_placeholders_then_all_names_are_found', () => {
    expect(placeholdersIn('{{a}} and {{ b }}')).toEqual(['a', 'b']);
  });

  it('given_known_vars_then_they_are_substituted', () => {
    expect(interpolate('id={{orderId}}', { orderId: '42' })).toBe('id=42');
  });

  it('given_an_unknown_var_then_the_placeholder_is_left_intact', () => {
    // Surfaces as "typed {{token}}" rather than an empty field, which is far
    // easier to diagnose.
    expect(interpolate('id={{missing}}', {})).toBe('id={{missing}}');
  });
});

describe('safeParseTestIR / batch', () => {
  it('given_an_invalid_ir_then_issues_are_returned_rather_than_thrown', () => {
    const r = safeParseTestIR(validIR({ assertions: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/no assertions/);
  });

  it('given_a_mixed_batch_then_valid_and_rejected_are_separated_and_nothing_is_dropped', () => {
    const { valid, rejected } = parseTestIRBatch([
      validIR({ id: 'good' }),
      validIR({ id: 'bad', assertions: [] }),
      validIR({ id: 'good2' }),
    ]);
    expect(valid.map((v) => v.id)).toEqual(['good', 'good2']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].index).toBe(1);
  });
});

describe('serializeIR — reviewable diffs', () => {
  it('given_the_same_ir_twice_then_serialization_is_byte_identical', () => {
    expect(serializeIR(parseTestIR(validIR()))).toBe(serializeIR(parseTestIR(validIR())));
  });

  it('given_steps_in_scrambled_order_then_output_is_canonically_sorted', () => {
    // Without canonical ordering every regeneration looks like a change in
    // review, and the IR stops being reviewable — the point of having it.
    const scrambled = validIR();
    const reversed = { ...scrambled, steps: [...(scrambled.steps as unknown[])].reverse() };
    expect(serializeIR(parseTestIR(reversed))).toBe(serializeIR(parseTestIR(scrambled)));
  });

  it('given_tags_in_any_order_then_they_serialize_sorted', () => {
    const a = serializeIR(parseTestIR(validIR({ tags: ['b', 'a'] })));
    const b = serializeIR(parseTestIR(validIR({ tags: ['a', 'b'] })));
    expect(a).toBe(b);
  });

  it('given_serialized_ir_then_it_round_trips_through_the_parser', () => {
    const ir = parseTestIR(validIR());
    expect(parseTestIR(JSON.parse(serializeIR(ir)))).toEqual(ir);
  });
});

describe('IRValidationError', () => {
  it('given_multiple_issues_then_all_are_listed_with_paths', () => {
    try {
      parseTestIR({ irVersion: IR_VERSION, id: '', name: '', provenance: {}, steps: [], assertions: [] });
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as IRValidationError;
      expect(e.issues.length).toBeGreaterThan(1);
      expect(e.isOperational).toBe(true);
    }
  });
});
