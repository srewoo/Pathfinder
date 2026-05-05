import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PageSnapshot } from '../../../src/storage/schemas';

vi.mock('../../../src/core/explorer/page-scanner', () => ({
  getPageSnapshot: vi.fn(),
}));
vi.mock('../../../src/messaging/messenger', () => ({
  sendToContentScript: vi.fn(),
}));
vi.mock('../../../src/utils/dom-compress', () => ({
  serializeCompressedDOM: vi.fn(() => 'compressed-dom'),
}));

const { interactivePlan } = await import('../../../src/core/planner/interactive-planner');
const { getPageSnapshot } = await import('../../../src/core/explorer/page-scanner');
const { sendToContentScript } = await import('../../../src/messaging/messenger');

const aiClient = { chat: vi.fn(), embed: vi.fn() };

const snap: PageSnapshot = {
  url: 'https://x.com/',
  title: 't',
  elements: [],
  domCompressed: '',
  capturedAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPageSnapshot).mockResolvedValue(snap);
  vi.mocked(sendToContentScript).mockResolvedValue(undefined as never);
});

describe('interactivePlan', () => {
  it('given AI returns isDone immediately when planning then goalAchieved=true and zero steps', async () => {
    aiClient.chat.mockResolvedValueOnce(JSON.stringify({ action: 'click', isDone: true }));
    const result = await interactivePlan(1, 'goal', aiClient as never, 5);
    expect(result.goalAchieved).toBe(true);
    expect(result.stepsExecuted).toBe(0);
  });

  it('given isDone=true with assert step when planning then includes assert as final step', async () => {
    aiClient.chat.mockResolvedValueOnce(JSON.stringify({
      action: 'assert', selector: '.success', assertType: 'visible', isDone: true,
    }));
    const result = await interactivePlan(1, 'goal', aiClient as never, 5);
    expect(result.goalAchieved).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].action).toBe('assert');
  });

  it('given AI returns invalid JSON when planning then breaks with parse failure reason', async () => {
    aiClient.chat.mockResolvedValueOnce('not json at all');
    const result = await interactivePlan(1, 'goal', aiClient as never, 5);
    expect(result.goalAchieved).toBe(false);
    expect(result.failureReason).toBe('AI returned unparseable JSON');
  });

  it('given AI throws when planning then captures failure reason', async () => {
    aiClient.chat.mockRejectedValueOnce(new Error('rate limit'));
    const result = await interactivePlan(1, 'goal', aiClient as never, 5);
    expect(result.failureReason).toContain('rate limit');
  });

  it('given action alias "fill" when planning then normalizes to type', async () => {
    aiClient.chat
      .mockResolvedValueOnce(JSON.stringify({ action: 'fill', selector: '#x', value: 'v', description: 'fill x' }))
      .mockResolvedValue(JSON.stringify({ action: 'click', isDone: true }));
    const result = await interactivePlan(1, 'goal', aiClient as never, 3);
    expect(result.steps[0].action).toBe('type');
  });

  it('given unknown action when planning then defaults to click', async () => {
    aiClient.chat
      .mockResolvedValueOnce(JSON.stringify({ action: 'frobnicate', selector: '#x', description: 'd' }))
      .mockResolvedValue(JSON.stringify({ action: 'click', isDone: true }));
    const result = await interactivePlan(1, 'goal', aiClient as never, 3);
    expect(result.steps[0].action).toBe('click');
  });

  it('given same action repeats more than threshold when planning then breaks with loop reason', async () => {
    aiClient.chat.mockResolvedValue(
      JSON.stringify({ action: 'click', selector: '#a', description: 'click a' })
    );
    const result = await interactivePlan(1, 'goal', aiClient as never, 10);
    expect(result.failureReason).toMatch(/Loop detected/);
  });

  it('given executeStep fails and retry succeeds when planning then completes step', async () => {
    aiClient.chat
      .mockResolvedValueOnce(JSON.stringify({ action: 'click', selector: '#bad', description: 'd' }))
      .mockResolvedValueOnce(JSON.stringify({ action: 'click', selector: '#good', description: 'd' }))
      .mockResolvedValue(JSON.stringify({ action: 'click', isDone: true }));
    vi.mocked(sendToContentScript)
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue(undefined as never);
    const result = await interactivePlan(1, 'goal', aiClient as never, 3);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].selector).toBe('#good');
  });

  it('given executeStep fails and retry also fails when planning then breaks with stuck reason', async () => {
    aiClient.chat
      .mockResolvedValueOnce(JSON.stringify({ action: 'click', selector: '#bad', description: 'd' }))
      .mockResolvedValueOnce(JSON.stringify({ action: 'click', selector: '#worse', description: 'd' }));
    vi.mocked(sendToContentScript).mockRejectedValue(new Error('fail'));
    const result = await interactivePlan(1, 'goal', aiClient as never, 3);
    expect(result.failureReason).toMatch(/Stuck at step/);
  });

  it('given snapshot fetch fails when planning then continues with fallback context', async () => {
    vi.mocked(getPageSnapshot).mockRejectedValue(new Error('no snapshot'));
    aiClient.chat.mockResolvedValueOnce(JSON.stringify({ action: 'click', isDone: true }));
    const result = await interactivePlan(1, 'goal', aiClient as never, 3);
    expect(result.goalAchieved).toBe(true);
  });
});
