import { describe, it, expect } from 'vitest';
import { sha256, simpleHash, generateId, generateRunId } from '../../../src/utils/hash';

describe('sha256', () => {
  it('given same input when hashed twice then returns same hash', async () => {
    const h1 = await sha256('hello world');
    const h2 = await sha256('hello world');
    expect(h1).toBe(h2);
  });

  it('given different inputs when hashed then returns different hashes', async () => {
    const h1 = await sha256('hello');
    const h2 = await sha256('world');
    expect(h1).not.toBe(h2);
  });

  it('given input when hashed then returns 64 hex characters', async () => {
    const hash = await sha256('test input');
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('given empty string when hashed then returns valid hash', async () => {
    const hash = await sha256('');
    expect(hash).toHaveLength(64);
  });
});

describe('simpleHash', () => {
  it('given same input when hashed then returns same value', () => {
    expect(simpleHash('test')).toBe(simpleHash('test'));
  });

  it('given different inputs when hashed then returns different values', () => {
    expect(simpleHash('foo')).not.toBe(simpleHash('bar'));
  });

  it('given any input when hashed then returns non-negative result', () => {
    const hash = simpleHash('some text');
    expect(parseInt(hash, 36)).toBeGreaterThanOrEqual(0);
  });

  it('given empty string when hashed then returns zero-based value', () => {
    const hash = simpleHash('');
    expect(hash).toBe('0');
  });
});

describe('generateId', () => {
  it('given multiple calls then each id is unique', () => {
    const ids = new Set(Array.from({ length: 100 }, generateId));
    expect(ids.size).toBe(100);
  });

  it('given generated id then it is a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('generateRunId', () => {
  it('given run id then it starts with run_ prefix', () => {
    const id = generateRunId();
    expect(id.startsWith('run_')).toBe(true);
  });

  it('given multiple calls then each run id is unique', () => {
    const ids = new Set(Array.from({ length: 50 }, generateRunId));
    expect(ids.size).toBe(50);
  });
});
