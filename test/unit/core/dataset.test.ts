import { describe, it, expect } from 'vitest';
import { parseDataSet, rowVariables, dataRowLabel } from '../../../src/core/test-gen/dataset';
import { IR_VERSION, TestIRSchema } from '../../../src/core/ir/test-ir';

describe('parseDataSet', () => {
  it('given_a_header_and_two_rows_then_parses_columns_and_rows', () => {
    const { dataSet, errors } = parseDataSet('email,password\na@b.com,secret\nc@d.com,hunter2');
    expect(errors).toEqual([]);
    expect(dataSet).toEqual({
      columns: ['email', 'password'],
      rows: [
        ['a@b.com', 'secret'],
        ['c@d.com', 'hunter2'],
      ],
    });
  });

  it('given_quoted_fields_with_commas_then_they_are_preserved', () => {
    const { dataSet } = parseDataSet('name,note\n"Smith, John","says ""hi"""');
    expect(dataSet?.rows).toEqual([['Smith, John', 'says "hi"']]);
  });

  it('given_crlf_line_endings_then_they_are_handled', () => {
    const { dataSet } = parseDataSet('a,b\r\n1,2\r\n');
    expect(dataSet?.rows).toEqual([['1', '2']]);
  });

  it('given_blank_lines_then_they_are_skipped', () => {
    const { dataSet } = parseDataSet('a\n1\n\n2\n');
    expect(dataSet?.rows).toEqual([['1'], ['2']]);
  });

  it('given_only_a_header_then_it_is_an_error', () => {
    const { dataSet, errors } = parseDataSet('email,password');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/no data rows/i);
  });

  it('given_empty_input_then_it_is_an_error', () => {
    const { dataSet, errors } = parseDataSet('   ');
    expect(dataSet).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('given_a_row_with_the_wrong_column_count_then_it_is_reported_with_its_line_number', () => {
    const { dataSet, errors } = parseDataSet('a,b\n1,2\n3\n4,5');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/line 3/);
  });

  // Column names become {{placeholders}}, so they must be valid identifiers or
  // the substitution silently never fires and the literal text gets typed.
  it('given_a_column_name_that_is_not_a_valid_placeholder_then_it_is_reported', () => {
    const { dataSet, errors } = parseDataSet('user email,pw\na,b');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/user email/);
  });

  it('given_duplicate_column_names_then_it_is_reported', () => {
    const { dataSet, errors } = parseDataSet('email,email\na,b');
    expect(dataSet).toBeUndefined();
    expect(errors.join(' ')).toMatch(/duplicate/i);
  });

  // These are set by the loop primitive in step-extensions.ts; a data column of
  // the same name would be silently overwritten mid-loop.
  it('given_a_column_named_loop_index_then_it_is_reported_as_reserved', () => {
    const { errors } = parseDataSet('loop_index\n1');
    expect(errors.join(' ')).toMatch(/reserved/i);
  });

  it('given_several_problems_then_all_are_reported_not_just_the_first', () => {
    const { errors } = parseDataSet('user email,user email\na,b');
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe('rowVariables', () => {
  const dataSet = { columns: ['email', 'pw'], rows: [['a@b.com', 's3cret']] };

  it('given_a_row_index_then_maps_column_names_to_values', () => {
    expect([...rowVariables(dataSet, 0)]).toEqual([
      ['email', 'a@b.com'],
      ['pw', 's3cret'],
    ]);
  });

  it('given_an_out_of_range_index_then_returns_an_empty_map', () => {
    expect(rowVariables(dataSet, 9).size).toBe(0);
  });
});

describe('dataRowLabel', () => {
  it('given_a_row_then_labels_it_with_the_first_column_value', () => {
    expect(dataRowLabel({ columns: ['email', 'pw'], rows: [['a@b.com', 'x']] }, 0)).toBe(
      'row 1: a@b.com'
    );
  });

  it('given_a_long_first_value_then_it_is_truncated', () => {
    const long = 'x'.repeat(60);
    expect(dataRowLabel({ columns: ['v'], rows: [[long]] }, 0).length).toBeLessThan(50);
  });

  it('given_an_empty_first_value_then_only_the_row_number_is_used', () => {
    expect(dataRowLabel({ columns: ['v'], rows: [['']] }, 0)).toBe('row 1');
  });
});

describe('TestIRSchema dataKeys', () => {
  const base = {
    irVersion: IR_VERSION,
    id: 'x',
    name: 'Data-driven login',
    provenance: { source: 'user' as const, generatedAt: 0 },
    steps: [
      {
        order: 0,
        action: 'type' as const,
        locator: { preferredTier: 'testid' as const, testid: 'email' },
        value: '{{email}}',
        description: 'Type the email',
      },
    ],
    assertions: [
      {
        order: 0,
        kind: 'visible' as const,
        locator: { preferredTier: 'testid' as const, testid: 'home' },
        description: 'Home',
      },
    ],
  };

  it('given_dataKeys_covering_the_placeholder_then_the_ir_validates', () => {
    expect(TestIRSchema.safeParse({ ...base, dataKeys: ['email'] }).success).toBe(true);
  });

  // Without the data row the placeholder has no source, and the executor would
  // type the literal "{{email}}" into the field.
  it('given_no_dataKeys_and_no_capture_step_then_the_ir_is_rejected', () => {
    expect(TestIRSchema.safeParse(base).success).toBe(false);
  });

  it('given_dataKeys_for_a_different_name_then_the_ir_is_still_rejected', () => {
    expect(TestIRSchema.safeParse({ ...base, dataKeys: ['username'] }).success).toBe(false);
  });
});
