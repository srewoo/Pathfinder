/**
 * Data-driven test input.
 *
 * One authored scenario times N rows of data is the cheapest coverage there is:
 * the AI cost is paid once at planning time and every extra row is free.
 *
 * The substitution mechanism already exists — `resolveStepVariables` in
 * `core/executor/step-extensions.ts` resolves `{{name}}` from a map — so a data
 * row is just that map, seeded before the step walk instead of accumulated
 * during it. No second interpolation path.
 *
 * Validation is strict and up front. A column name that is not a valid
 * placeholder identifier would fail silently at run time by typing the literal
 * text `{{user email}}` into a field, and a test that types garbage still
 * passes if its assertions are weak. Better to refuse the sheet and say why.
 */

export interface DataSet {
  columns: string[];
  rows: string[][];
}


export interface ParseResult {
  dataSet?: DataSet;
  /** Every problem found, not just the first — the user fixes one sheet, once. */
  errors: string[];
}

/** Set by `executeLoopStep`; a data column of the same name would be clobbered. */
const RESERVED = new Set(['loop_index', 'loop_iteration']);

/** Must match the `{{name}}` grammar in `PLACEHOLDER_RE` (core/ir/test-ir.ts). */
const VALID_COLUMN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Split one CSV line, honouring double-quoted fields and `""` escapes. */
function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      out.push(field.trim());
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field.trim());
  return out;
}

function validateColumns(columns: string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const col of columns) {
    if (!VALID_COLUMN.test(col)) {
      errors.push(
        `Column "${col}" is not a valid placeholder name. Use letters, digits and ` +
          `underscores, starting with a letter or underscore.`
      );
    }
    if (RESERVED.has(col)) {
      errors.push(`Column "${col}" is reserved — it is set by loop steps during execution.`);
    }
    if (seen.has(col)) {
      errors.push(`Duplicate column name "${col}".`);
    }
    seen.add(col);
  }
  return errors;
}

export function parseDataSet(csv: string): ParseResult {
  const lines = csv
    .split(/\r?\n/)
    .map((text, i) => ({ text, lineNo: i + 1 }))
    .filter((l) => l.text.trim().length > 0);

  if (lines.length === 0) {
    return { errors: ['No data — paste a CSV with a header row and at least one data row.'] };
  }

  const columns = splitLine(lines[0].text);
  const errors = validateColumns(columns);

  const rows: string[][] = [];
  for (const { text, lineNo } of lines.slice(1)) {
    const cells = splitLine(text);
    if (cells.length !== columns.length) {
      errors.push(`line ${lineNo}: expected ${columns.length} value(s) but found ${cells.length}.`);
      continue;
    }
    rows.push(cells);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push('The CSV has a header but no data rows.');
  }
  if (errors.length > 0) return { errors };
  return { dataSet: { columns, rows }, errors: [] };
}

/** Column name → value for one row, ready to seed the captured-variable map. */
export function rowVariables(dataSet: DataSet, rowIndex: number): Map<string, string> {
  const row = dataSet.rows[rowIndex];
  if (!row) return new Map();
  return new Map(dataSet.columns.map((col, i) => [col, row[i] ?? '']));
}

/** Short human label so a fanned-out result is identifiable in the results list. */
export function dataRowLabel(dataSet: DataSet, rowIndex: number): string {
  const first = dataSet.rows[rowIndex]?.[0] ?? '';
  const trimmed = first.length > 28 ? `${first.slice(0, 27)}…` : first;
  return `row ${rowIndex + 1}${trimmed ? `: ${trimmed}` : ''}`;
}
