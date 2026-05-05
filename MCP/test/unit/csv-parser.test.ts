import { describe, it, expect } from 'vitest';

// The parseCsv and parseCsvLine functions are not exported from run-csv.ts,
// so we replicate them here for testing. In a real project, these would be
// extracted to a shared utility module.

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function parseCsv(csvContent: string): Array<{
  title: string;
  type?: string;
  context?: string;
  startUrl?: string;
}> {
  const lines = csvContent.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes('title') || firstLine.includes('test_case') || firstLine.includes('test case');

  if (!hasHeader) {
    return lines.map((line) => ({ title: line }));
  }

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  const titleIdx = header.findIndex((h) => h === 'title' || h === 'test_case' || h === 'test case' || h === 'test');
  if (titleIdx === -1) {
    return lines.slice(1).map((line) => ({ title: line }));
  }

  const typeIdx = header.findIndex((h) => h === 'type');
  const contextIdx = header.findIndex((h) => h === 'context' || h === 'shared_context');
  const urlIdx = header.findIndex((h) => h === 'start_url' || h === 'url' || h === 'target_url');

  return lines.slice(1).filter(Boolean).map((line) => {
    const cols = parseCsvLine(line);
    return {
      title: cols[titleIdx]?.trim() ?? '',
      type: typeIdx >= 0 ? cols[typeIdx]?.trim() : undefined,
      context: contextIdx >= 0 ? cols[contextIdx]?.trim() : undefined,
      startUrl: urlIdx >= 0 ? cols[urlIdx]?.trim() : undefined,
    };
  }).filter((tc) => tc.title.length > 0);
}

describe('parseCsvLine', () => {
  it('given_simple_line_when_parsed_then_splits_by_comma', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('given_quoted_field_when_parsed_then_strips_quotes', () => {
    expect(parseCsvLine('"hello world",b,c')).toEqual(['hello world', 'b', 'c']);
  });

  it('given_escaped_quotes_when_parsed_then_handles_correctly', () => {
    expect(parseCsvLine('"say ""hello""",b')).toEqual(['say "hello"', 'b']);
  });

  it('given_comma_inside_quotes_when_parsed_then_preserves_it', () => {
    expect(parseCsvLine('"a,b",c')).toEqual(['a,b', 'c']);
  });

  it('given_empty_fields_when_parsed_then_returns_empty_strings', () => {
    expect(parseCsvLine('a,,c')).toEqual(['a', '', 'c']);
  });

  it('given_single_field_when_parsed_then_returns_array_of_one', () => {
    expect(parseCsvLine('hello')).toEqual(['hello']);
  });
});

describe('parseCsv', () => {
  it('given_empty_content_when_parsed_then_returns_empty_array', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('given_plain_text_lines_when_parsed_then_treats_each_as_test', () => {
    const csv = 'Login to dashboard\nCreate new user\nDelete user';
    const result = parseCsv(csv);
    expect(result).toEqual([
      { title: 'Login to dashboard' },
      { title: 'Create new user' },
      { title: 'Delete user' },
    ]);
  });

  it('given_csv_with_title_header_when_parsed_then_extracts_titles', () => {
    const csv = 'title,type\nLogin test,smoke\nSignup test,regression';
    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Login test');
    expect(result[0].type).toBe('smoke');
    expect(result[1].title).toBe('Signup test');
  });

  it('given_csv_with_test_case_header_when_parsed_then_extracts_titles', () => {
    const csv = 'test_case\nLogin test\nSignup test';
    const result = parseCsv(csv);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('Login test');
  });

  it('given_csv_with_all_columns_when_parsed_then_extracts_all_fields', () => {
    const csv = 'title,type,context,start_url\n"Login with valid creds",smoke,Admin context,https://app.com/login';
    const result = parseCsv(csv);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      title: 'Login with valid creds',
      type: 'smoke',
      context: 'Admin context',
      startUrl: 'https://app.com/login',
    });
  });

  it('given_csv_with_empty_rows_when_parsed_then_skips_them', () => {
    const csv = 'title\nLogin test\n\nSignup test\n   \nDelete test';
    const result = parseCsv(csv);
    expect(result).toHaveLength(3);
  });

  it('given_csv_with_empty_titles_when_parsed_then_filters_them', () => {
    const csv = 'title,type\nLogin test,smoke\n,regression';
    const result = parseCsv(csv);
    expect(result).toHaveLength(1);
  });
});
