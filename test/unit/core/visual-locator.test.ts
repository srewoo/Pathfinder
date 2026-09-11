import { describe, it, expect, vi } from 'vitest';
import { proposeSelectorFromScreenshot } from '../../../src/core/healing/visual-locator';
import type { AIClientInterface, Message, TextContent, ImageContent } from '../../../src/core/ai/ai-client';

function client(reply: string): AIClientInterface {
  return {
    chat: vi.fn(async () => reply),
    embed: vi.fn(async () => [[0]]),
  };
}

const args = {
  description: 'Click the share icon',
  failedSelector: '.icon.share-icon',
  error: 'element not found',
  screenshot: 'BASE64PNG',
  domContext: "<button aria-label='Share'><span class='beZfZu'></span></button>",
};

/** Content parts of the last user message the client received. */
function sentParts(ai: AIClientInterface): Array<TextContent | ImageContent> {
  const messages = (ai.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as Message[];
  const last = messages[messages.length - 1];
  if (typeof last.content === 'string') throw new Error('expected structured content');
  return last.content;
}

describe('proposeSelectorFromScreenshot', () => {
  it('given_a_json_array_reply_then_returns_the_candidates_in_order', async () => {
    const ai = client(JSON.stringify(["[aria-label='Share']", 'button.share']));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([
      "[aria-label='Share']",
      'button.share',
    ]);
  });

  it('given_a_fenced_json_reply_then_still_parses', async () => {
    const ai = client("```json\n[\"[aria-label='Share']\"]\n```");
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([
      "[aria-label='Share']",
    ]);
  });

  it('given_an_object_wrapped_reply_then_still_parses', async () => {
    const ai = client(JSON.stringify({ selectors: ['#share'] }));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([
      '#share',
    ]);
  });

  it('given_hash_only_candidates_then_they_are_filtered_out', async () => {
    const ai = client(JSON.stringify(['.beZfZu', "[aria-label='Share']"]));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([
      "[aria-label='Share']",
    ]);
  });

  it('given_the_screenshot_then_it_is_sent_as_an_image_content_part', async () => {
    const ai = client(JSON.stringify(['#x']));
    await proposeSelectorFromScreenshot({ ...args, aiClient: ai });
    expect(sentParts(ai)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: 'BASE64PNG', mimeType: 'image/png' }),
      ])
    );
  });

  it('given_the_step_intent_then_it_is_sent_as_a_text_content_part', async () => {
    const ai = client(JSON.stringify(['#x']));
    await proposeSelectorFromScreenshot({ ...args, aiClient: ai });
    const text = sentParts(ai).find((p): p is TextContent => p.type === 'text');
    expect(text?.text).toContain('Click the share icon');
    expect(text?.text).toContain('.icon.share-icon');
  });

  it('given_no_screenshot_then_no_ai_call_is_made', async () => {
    const ai = client(JSON.stringify(['#x']));
    await expect(
      proposeSelectorFromScreenshot({ ...args, screenshot: undefined, aiClient: ai })
    ).resolves.toEqual([]);
    expect(ai.chat).not.toHaveBeenCalled();
  });

  it('given_a_data_uri_screenshot_then_the_prefix_is_stripped', async () => {
    const ai = client(JSON.stringify(['#x']));
    await proposeSelectorFromScreenshot({
      ...args,
      screenshot: 'data:image/png;base64,ABC',
      aiClient: ai,
    });
    expect(sentParts(ai)).toEqual(
      expect.arrayContaining([expect.objectContaining({ data: 'ABC' })])
    );
  });

  it('given_an_unparseable_reply_then_returns_empty_rather_than_throwing', async () => {
    const ai = client('I could not identify the element.');
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([]);
  });

  it('given_the_ai_call_throws_then_returns_empty', async () => {
    const ai: AIClientInterface = {
      chat: vi.fn(async () => {
        throw new Error('429');
      }),
      embed: vi.fn(async () => [[0]]),
    };
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([]);
  });

  it('given_more_than_three_candidates_then_caps_at_three', async () => {
    const ai = client(JSON.stringify(['#a', '#b', '#c', '#d', '#e']));
    await expect(proposeSelectorFromScreenshot({ ...args, aiClient: ai })).resolves.toEqual([
      '#a',
      '#b',
      '#c',
    ]);
  });
});
