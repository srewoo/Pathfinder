import { describe, it, expect } from 'vitest';
import {
  PatternTracker,
  normalizeUrlPattern,
  generateTestValue,
  findSubmitButton,
  computeStructureFingerprint,
  classifyUrlChange,
} from '../../../src/core/explorer/explorer-agent';
import type { InteractiveElement, FormField } from '../../../src/storage/schemas';

const el = (partial: Partial<InteractiveElement>): InteractiveElement =>
  ({ selector: 'x', tag: 'button', visible: true, ...partial } as unknown as InteractiveElement);

const field = (partial: Partial<FormField>): FormField =>
  ({ selector: '#f', type: 'text', required: false, ...partial } as FormField);

describe('normalizeUrlPattern', () => {
  it('given a numeric id segment when normalized then replaces with :param', () => {
    expect(normalizeUrlPattern('https://app/asset/608205721074453683')).toBe('https://app/asset/:param');
  });

  it('given a UUID segment when normalized then replaces with :param', () => {
    expect(normalizeUrlPattern('https://app/u/550e8400-e29b-41d4-a716-446655440000/edit'))
      .toBe('https://app/u/:param/edit');
  });

  it('given a static path when normalized then leaves it unchanged', () => {
    expect(normalizeUrlPattern('https://app/settings/profile')).toBe('https://app/settings/profile');
  });
});

describe('PatternTracker.reserve (over-queue fix)', () => {
  it('given a parameterized pattern when reserving then caps at 2 instances', () => {
    const t = new PatternTracker();
    expect(t.reserve('https://app/asset/1')).toBe(true);
    expect(t.reserve('https://app/asset/2')).toBe(true);
    // Third distinct instance of the same /asset/:param pattern is refused.
    expect(t.reserve('https://app/asset/3')).toBe(false);
  });

  it('given a static (non-parameterized) URL when reserving then never caps', () => {
    const t = new PatternTracker();
    expect(t.reserve('https://app/about')).toBe(true);
    expect(t.reserve('https://app/about')).toBe(true);
    expect(t.reserve('https://app/about')).toBe(true);
  });

  it('given pre-seeded records when reserving then counts them toward the cap', () => {
    const t = new PatternTracker();
    t.record(normalizeUrlPattern('https://app/asset/10'));
    t.record(normalizeUrlPattern('https://app/asset/11'));
    expect(t.reserve('https://app/asset/12')).toBe(false);
  });
});

describe('generateTestValue', () => {
  it('given an email field then returns a valid test email', () => {
    expect(generateTestValue(field({ type: 'email' }))).toBe('test@example.com');
  });

  it('given a number field with a min then returns the min', () => {
    expect(generateTestValue(field({ type: 'number', min: '5' }))).toBe('5');
  });

  it('given a select field with options then returns the first option', () => {
    expect(generateTestValue(field({ type: 'select', options: ['Alpha', 'Beta'] }))).toBe('Alpha');
  });

  it('given a text field named "email" context then uses name heuristics', () => {
    expect(generateTestValue(field({ type: 'text', name: 'fullName' }))).toBe('Test User');
  });
});

describe('classifyUrlChange', () => {
  const base = 'https://app/new/ui/callai/recording/599';
  it('given the same URL then none', () => {
    expect(classifyUrlChange(base, base)).toBe('none');
  });
  it('given only a query-param change then in-page (feature tab)', () => {
    expect(classifyUrlChange(base, `${base}?aiFeatureTab=overview`)).toBe('in-page');
    expect(classifyUrlChange(`${base}?aiFeatureTab=overview`, `${base}?aiFeatureTab=transcript`)).toBe('in-page');
  });
  it('given only a hash change then in-page', () => {
    expect(classifyUrlChange(base, `${base}#section`)).toBe('in-page');
  });
  it('given a pathname change then navigation', () => {
    expect(classifyUrlChange(base, 'https://app/new/ui/callai/recordings')).toBe('navigation');
  });
  it('given a different origin then navigation', () => {
    expect(classifyUrlChange(base, 'https://other/new/ui/callai/recording/599')).toBe('navigation');
  });
});

describe('computeStructureFingerprint', () => {
  const els = [el({ selector: '#a', tag: 'button' }), el({ selector: '#b', tag: 'a' })];
  const forms = [field({ selector: '#email', type: 'email', required: true })];

  it('given the same structure then produces a stable hash regardless of element order', () => {
    const h1 = computeStructureFingerprint(els, forms);
    const h2 = computeStructureFingerprint([...els].reverse(), forms);
    expect(h1).toBe(h2);
  });

  it('given a changed structure (new element) then the hash changes', () => {
    const before = computeStructureFingerprint(els, forms);
    const after = computeStructureFingerprint([...els, el({ selector: '#c', tag: 'button' })], forms);
    expect(after).not.toBe(before);
  });

  it('given a changed form field then the hash changes', () => {
    const before = computeStructureFingerprint(els, forms);
    const after = computeStructureFingerprint(els, [field({ selector: '#email', type: 'email', required: false })]);
    expect(after).not.toBe(before);
  });
});

describe('findSubmitButton', () => {
  it('given an explicit submit input when searching then returns it', () => {
    const elements = [el({ selector: '#a', tag: 'div' }), el({ selector: '#s', tag: 'button', type: 'submit' })];
    expect(findSubmitButton(elements)?.selector).toBe('#s');
  });

  it('given no submit type but submit-like text when searching then matches by text', () => {
    const elements = [el({ selector: '#x', tag: 'button', text: 'Cancel' }), el({ selector: '#y', tag: 'button', text: 'Create Project' })];
    expect(findSubmitButton(elements)?.selector).toBe('#y');
  });

  it('given no submit-like elements when searching then returns undefined', () => {
    expect(findSubmitButton([el({ selector: '#z', tag: 'button', text: 'Close' })])).toBeUndefined();
  });
});
