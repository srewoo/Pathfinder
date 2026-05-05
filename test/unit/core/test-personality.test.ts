import { describe, it, expect } from 'vitest';
import {
  getPersonality,
  createCustomPersonality,
  applyPersonalityToPrompt,
  listPersonalities,
  PERSONALITIES,
} from '../../../src/core/test-gen/test-personality';

describe('Test Personality', () => {
  describe('getPersonality', () => {
    it('should return balanced personality by default', () => {
      const p = getPersonality('balanced');
      expect(p.id).toBe('balanced');
      expect(p.temperature).toBe(0.4);
    });

    it('should return aggressive_edge personality with higher temperature', () => {
      const p = getPersonality('aggressive_edge');
      expect(p.id).toBe('aggressive_edge');
      expect(p.temperature).toBe(0.7);
      expect(p.maxTestsPerFlow).toBe(20);
    });

    it('should return security_focused personality', () => {
      const p = getPersonality('security_focused');
      expect(p.systemPromptOverlay).toContain('XSS');
      expect(p.systemPromptOverlay).toContain('injection');
      expect(p.emphasisAreas).toContain('xss');
    });

    it('should return happy_path personality with lower temperature', () => {
      const p = getPersonality('happy_path');
      expect(p.temperature).toBe(0.2);
      expect(p.testTypeWeights.positive).toBe(0.7);
      expect(p.maxTestsPerFlow).toBe(8);
    });

    it('should return balanced for unknown personality IDs', () => {
      const p = getPersonality('custom');
      expect(p.id).toBe('balanced');
    });
  });

  describe('createCustomPersonality', () => {
    it('should create a custom personality from free text', () => {
      const p = createCustomPersonality('Focus on testing with screen readers and keyboard navigation.');
      expect(p.id).toBe('custom');
      expect(p.systemPromptOverlay).toContain('screen readers');
      expect(p.systemPromptOverlay).toContain('PERSONALITY OVERRIDE');
      expect(p.temperature).toBe(0.5);
    });

    it('should truncate long descriptions', () => {
      const longDesc = 'A'.repeat(300);
      const p = createCustomPersonality(longDesc);
      expect(p.description.length).toBeLessThanOrEqual(200);
    });
  });

  describe('applyPersonalityToPrompt', () => {
    it('should not modify prompt for balanced personality (no overlay)', () => {
      const p = getPersonality('balanced');
      const result = applyPersonalityToPrompt('Base prompt here.', p);
      expect(result).toBe('Base prompt here.');
    });

    it('should append overlay for aggressive personality', () => {
      const p = getPersonality('aggressive_edge');
      const result = applyPersonalityToPrompt('Base prompt.', p);
      expect(result).toContain('Base prompt.');
      expect(result).toContain('PERSONALITY OVERRIDE');
      expect(result).toContain('AGGRESSIVE');
    });

    it('should append custom overlay', () => {
      const p = createCustomPersonality('Test mobile responsiveness');
      const result = applyPersonalityToPrompt('Base prompt.', p);
      expect(result).toContain('Test mobile responsiveness');
    });
  });

  describe('listPersonalities', () => {
    it('should list all built-in personalities', () => {
      const list = listPersonalities();
      expect(list.length).toBe(Object.keys(PERSONALITIES).length);
      expect(list.every((p) => p.id && p.name && p.description)).toBe(true);
    });

    it('should include expected personalities', () => {
      const list = listPersonalities();
      const ids = list.map((p) => p.id);
      expect(ids).toContain('balanced');
      expect(ids).toContain('aggressive_edge');
      expect(ids).toContain('security_focused');
      expect(ids).toContain('accessibility_first');
      expect(ids).toContain('performance_minded');
      expect(ids).toContain('happy_path');
    });
  });

  describe('personality test type weights', () => {
    it('should have weights summing to ~1.0 for all personalities', () => {
      for (const [id, p] of Object.entries(PERSONALITIES)) {
        const sum = p.testTypeWeights.positive + p.testTypeWeights.negative + p.testTypeWeights.edge;
        expect(sum).toBeCloseTo(1.0, 1);
      }
    });

    it('happy_path should emphasize positive tests', () => {
      const p = PERSONALITIES.happy_path;
      expect(p.testTypeWeights.positive).toBeGreaterThan(p.testTypeWeights.negative);
      expect(p.testTypeWeights.positive).toBeGreaterThan(p.testTypeWeights.edge);
    });

    it('aggressive_edge should emphasize edge tests', () => {
      const p = PERSONALITIES.aggressive_edge;
      expect(p.testTypeWeights.edge).toBeGreaterThanOrEqual(p.testTypeWeights.positive);
    });

    it('security_focused should emphasize negative tests', () => {
      const p = PERSONALITIES.security_focused;
      expect(p.testTypeWeights.negative).toBeGreaterThan(p.testTypeWeights.positive);
    });
  });
});
