import { describe, it, expect } from 'vitest';
import {
  parseJSON, stripFences, isAlternativesShape, isNextActionShape, isPlanShape,
} from '../../../src/core/ai/validators';

describe('stripFences', () => {
  it('given json fences when stripping then removes', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('given no fences when stripping then unchanged', () => {
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe('parseJSON', () => {
  it('given valid alternatives JSON when parsing then ok', () => {
    const r = parseJSON('{"alternatives":["a","b"]}', isAlternativesShape);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.alternatives).toEqual(['a', 'b']);
  });

  it('given invalid JSON when parsing then error with raw', () => {
    const r = parseJSON('not json', isAlternativesShape);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe('not json');
  });

  it('given JSON failing schema when parsing then error', () => {
    const r = parseJSON('{"alternatives":[1,2]}', isAlternativesShape);
    expect(r.ok).toBe(false);
  });

  it('given fenced JSON when parsing then strips and accepts', () => {
    const r = parseJSON('```json\n{"alternatives":["x"]}\n```', isAlternativesShape);
    expect(r.ok).toBe(true);
  });
});

describe('isNextActionShape', () => {
  it('given valid action when checking then true', () => {
    expect(isNextActionShape({ action: 'click', selector: '#a' })).toBe(true);
  });
  it('given missing action when checking then false', () => {
    expect(isNextActionShape({ selector: '#a' })).toBe(false);
  });
  it('given non-string field type when checking then false', () => {
    expect(isNextActionShape({ action: 'click', selector: 5 })).toBe(false);
  });
  it('given non-boolean isDone when checking then false', () => {
    expect(isNextActionShape({ action: 'click', isDone: 'yes' })).toBe(false);
  });
});

describe('isPlanShape', () => {
  it('given steps array when checking then true', () => {
    expect(isPlanShape({ steps: [{ action: 'click' }] })).toBe(true);
  });
  it('given non-array steps when checking then false', () => {
    expect(isPlanShape({ steps: 'oops' })).toBe(false);
  });
  it('given non-object step when checking then false', () => {
    expect(isPlanShape({ steps: ['click'] })).toBe(false);
  });
});
