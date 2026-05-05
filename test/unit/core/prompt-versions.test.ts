import { describe, it, expect } from 'vitest';
import { PROMPT_VERSIONS, getPromptVersion, tagPromptVersion } from '../../../src/core/ai/prompt-versions';

const SEMVER = /^\d+\.\d+\.\d+$/;

describe('prompt versions', () => {
  it('given known prompt name when reading then returns semver', () => {
    expect(getPromptVersion('selectorHealing')).toMatch(SEMVER);
  });

  it('given unknown prompt when reading then returns 0.0.0 sentinel', () => {
    expect(getPromptVersion('does-not-exist')).toBe('0.0.0');
  });

  it('given core prompts when iterating then all have valid semver', () => {
    for (const [name, ver] of Object.entries(PROMPT_VERSIONS)) {
      expect(ver, name).toMatch(SEMVER);
    }
  });

  it('given prompt name when tagging then prepends HTML comment', () => {
    const out = tagPromptVersion('selectorHealing', 'system text');
    expect(out).toMatch(/<!-- pathfinder-prompt: selectorHealing@\d+\.\d+\.\d+ -->/);
    expect(out).toContain('system text');
  });
});
