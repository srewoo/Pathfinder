/**
 * T08 item 7: name the frames the scan cannot see, instead of reporting a page
 * with a third-party checkout as fully mapped.
 *
 * The decision this pins: same-origin frames are NOT a gap — `walkDOM` already
 * descends into their `contentDocument`, so listing them would manufacture a
 * caveat where there is none. Only the frames the browser actually refuses are
 * reported.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  detectUnscannedFrames,
  MAX_UNSCANNED_FRAMES_REPORTED,
} from '../../../src/content/frame-coverage';

/**
 * jsdom cannot make a genuinely cross-origin frame, and it computes no layout,
 * so both have to be staged: `contentDocument` throwing is exactly what a real
 * cross-origin frame does, and a rect has to be supplied for any frame that is
 * meant to count as content-sized.
 */
function frame(
  doc: Document,
  opts: {
    src?: string;
    accessible: boolean;
    size?: [number, number];
    attrs?: Record<string, string>;
  }
): HTMLIFrameElement {
  const el = doc.createElement('iframe');
  if (opts.src) el.setAttribute('src', opts.src);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) el.setAttribute(k, v);

  const [width, height] = opts.size ?? [400, 300];
  el.getBoundingClientRect = () =>
    ({ width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height }) as DOMRect;

  Object.defineProperty(el, 'contentDocument', {
    get() {
      if (!opts.accessible) throw new DOMException('Blocked a frame from accessing a cross-origin frame.');
      return doc.implementation.createHTMLDocument('inner');
    },
  });

  doc.body.appendChild(el);
  return el;
}

let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<body></body>', { url: 'https://app.test/checkout' });
  globalThis.document = dom.window.document;
  globalThis.DOMException = dom.window.DOMException;
});

describe('only frames the scan genuinely could not reach are reported', () => {
  it('given_a_cross_origin_frame_then_it_is_reported', () => {
    frame(dom.window.document, { src: 'https://pay.example.com/widget', accessible: false });

    const { frames } = detectUnscannedFrames();

    expect(frames).toHaveLength(1);
    expect(frames[0].origin).toBe('https://pay.example.com');
    expect(frames[0].reason).toBe('cross-origin');
  });

  // The whole reason not to add `all_frames`: these are already covered.
  it('given_a_same_origin_frame_then_it_is_not_reported', () => {
    frame(dom.window.document, { src: '/inner.html', accessible: true });

    expect(detectUnscannedFrames().frames).toEqual([]);
  });

  it('given_no_frames_at_all_then_nothing_is_reported', () => {
    expect(detectUnscannedFrames().frames).toEqual([]);
  });
});

describe('the report carries enough identity to act on', () => {
  it('given_a_titled_frame_then_the_title_is_the_label', () => {
    frame(dom.window.document, {
      src: 'https://pay.example.com/w',
      accessible: false,
      attrs: { title: 'Card details' },
    });

    expect(detectUnscannedFrames().frames[0].label).toBe('Card details');
  });

  it('given_no_title_then_a_name_or_id_is_used', () => {
    frame(dom.window.document, {
      src: 'https://pay.example.com/w',
      accessible: false,
      attrs: { id: 'payment-frame' },
    });

    expect(detectUnscannedFrames().frames[0].label).toBe('payment-frame');
  });

  it('given_a_srcless_frame_then_the_origin_is_absent_rather_than_guessed', () => {
    frame(dom.window.document, { accessible: false, attrs: { title: 'Injected' } });

    const reported = detectUnscannedFrames().frames[0];
    expect(reported.origin).toBeUndefined();
    expect(reported.label).toBe('Injected');
  });

  // Size is what lets a reader tell a checkout from a consent strip.
  it('given_a_frame_then_its_rendered_size_is_recorded', () => {
    frame(dom.window.document, {
      src: 'https://pay.example.com/w',
      accessible: false,
      size: [640, 480],
    });

    expect(detectUnscannedFrames().frames[0]).toMatchObject({ width: 640, height: 480 });
  });
});

describe('tracking pixels are not coverage gaps', () => {
  // Listing every 1x1 beacon would bury the one frame that matters.
  it('given_a_tiny_frame_then_it_is_ignored', () => {
    frame(dom.window.document, {
      src: 'https://analytics.example.com/p',
      accessible: false,
      size: [1, 1],
    });

    expect(detectUnscannedFrames().frames).toEqual([]);
  });

  it('given_a_frame_wide_but_not_tall_then_it_is_still_reported', () => {
    frame(dom.window.document, {
      src: 'https://consent.example.com/bar',
      accessible: false,
      size: [1200, 8],
    });

    expect(detectUnscannedFrames().frames).toHaveLength(1);
  });
});

describe('the report is bounded and says when it truncates', () => {
  function manyFrames(count: number) {
    for (let i = 0; i < count; i++) {
      frame(dom.window.document, { src: `https://ads${i}.example.com/f`, accessible: false });
    }
  }

  it('given_more_frames_than_the_cap_then_only_the_cap_is_reported', () => {
    manyFrames(MAX_UNSCANNED_FRAMES_REPORTED + 3);

    expect(detectUnscannedFrames().frames).toHaveLength(MAX_UNSCANNED_FRAMES_REPORTED);
  });

  it('given_the_cap_is_reached_then_the_shortfall_is_reported', () => {
    manyFrames(MAX_UNSCANNED_FRAMES_REPORTED + 3);

    expect(detectUnscannedFrames().omitted).toBe(3);
  });

  it('given_fewer_frames_than_the_cap_then_nothing_is_omitted', () => {
    manyFrames(2);

    expect(detectUnscannedFrames().omitted).toBe(0);
  });

  it('given_an_explicit_cap_then_it_is_respected', () => {
    manyFrames(5);

    expect(detectUnscannedFrames(2)).toMatchObject({ omitted: 3 });
  });
});
