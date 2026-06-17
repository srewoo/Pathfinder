import { describe, it, expect, vi } from 'vitest';
import { buildFlowQuery, groundFlows } from '../../../src/core/flow/flow-grounding';
import type { FlowDraft } from '../../../src/core/flow/skeleton-enumerator';
import type { SearchResult, VectorRecord } from '../../../src/core/knowledge/vector-search';

const draft = (partial: Partial<FlowDraft>): FlowDraft => ({
  name: 'Flow',
  description: '',
  source: 'exploration',
  steps: [],
  ...partial,
});

const hit = (url: string, section: string, content: string, score: number): SearchResult => ({
  record: { url, content, metadata: { section } } as unknown as VectorRecord,
  score,
});

describe('buildFlowQuery', () => {
  it('drops verb scaffolding and keeps feature terms + url path terms', () => {
    const q = buildFlowQuery(
      draft({
        name: 'Open Transcript (Recording)',
        steps: [
          { order: 1, action: 'navigate', value: 'https://app/new/ui/callai/recording/123?tab=transcript', description: '' },
          { order: 2, action: 'verify', target: 'Transcript', description: '' },
        ],
      })
    );
    expect(q.toLowerCase()).toContain('transcript');
    expect(q.toLowerCase()).toContain('recording');
    expect(q.toLowerCase()).toContain('callai');
    // Scaffolding verbs are stripped.
    expect(q.toLowerCase()).not.toMatch(/\bopen\b/);
    expect(q.toLowerCase()).not.toMatch(/\bverify\b/);
  });

  it('caps query length', () => {
    const longName = 'feature '.repeat(200);
    expect(buildFlowQuery(draft({ name: longName }), 100).length).toBeLessThanOrEqual(100);
  });
});

describe('groundFlows', () => {
  it('attaches knowledgeRefs and promotes exploration flows to hybrid when docs match', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]));
    const searchFn = vi.fn(async () => [hit('https://help/transcript', 'Transcript', 'How to read the transcript view.', 0.8)]);

    const [out] = await groundFlows([draft({ name: 'Open Transcript', source: 'exploration' })], embed, { searchFn });

    expect(embed).toHaveBeenCalledTimes(1); // single batched embed
    expect(out.source).toBe('hybrid');
    expect(out.knowledgeRefs).toHaveLength(1);
    expect(out.knowledgeRefs![0]).toMatchObject({ url: 'https://help/transcript', section: 'Transcript' });
  });

  it('leaves a flow untouched when no doc clears the score threshold', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.1]));
    const searchFn = vi.fn(async () => [hit('https://help/x', 'X', 'irrelevant', 0.1)]);

    const [out] = await groundFlows([draft({ name: 'Submit form: Login', source: 'exploration' })], embed, { searchFn, minScore: 0.3 });

    expect(out.source).toBe('exploration');
    expect(out.knowledgeRefs).toBeUndefined();
  });

  it('returns flows unchanged when embedding fails (never blocks learning)', async () => {
    const embed = vi.fn(async () => { throw new Error('embed down'); });
    const flows = [draft({ name: 'A' }), draft({ name: 'B' })];
    const out = await groundFlows(flows, embed, { searchFn: vi.fn() });
    expect(out).toEqual(flows);
  });

  it('embeds ALL flow queries in one call regardless of flow count', async () => {
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [0.5]));
    const searchFn = vi.fn(async () => []);
    await groundFlows([draft({ name: 'A' }), draft({ name: 'B' }), draft({ name: 'C' })], embed, { searchFn });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0][0]).toHaveLength(3);
  });
});
