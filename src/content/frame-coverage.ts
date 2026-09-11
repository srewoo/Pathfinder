/**
 * What the page scan could not see, because a frame belongs to another origin.
 *
 * `walkDOM` already descends into same-origin `<iframe>`/`<frame>` content
 * documents, so the elements, forms and links inside those are scanned as if
 * they were part of the top document. A **cross-origin** frame is different in
 * kind: the browser refuses `contentDocument` outright, and no amount of
 * walking gets past it.
 *
 * Reaching inside one would mean injecting into every frame (`all_frames`) and
 * routing every scan and action by `frameId` through the whole messaging
 * layer — and even then a third-party sign-in widget served from another origin
 * stays out of reach, because the extension has no host permission for it in
 * the general case.
 *
 * So this module does not try. It records the gap, with enough identity to act
 * on — origin, size, and whatever label the embedder gave it — so a coverage
 * report can say *"this page has a payment iframe that was not scanned"* rather
 * than reporting the page as fully covered and quietly leaving a hole. A known
 * blind spot that is named is a caveat; an unnamed one is a wrong number.
 */
import type { UnscannedFrame } from '../storage/schemas';

/** Bounded: a page that embeds dozens of trackers should not fill the graph. */
export const MAX_UNSCANNED_FRAMES_REPORTED = 20;

/** Frames smaller than this in both dimensions are trackers/pixels, not content. */
const MIN_CONTENT_FRAME_PX = 32;

function frameOrigin(frame: HTMLIFrameElement | HTMLFrameElement): string | undefined {
  // `src` is the embedder's own attribute and is readable cross-origin;
  // `contentWindow.location` is not.
  const src = frame.getAttribute('src');
  if (!src) return undefined;
  try {
    return new URL(src, document.baseURI).origin;
  } catch {
    return undefined;
  }
}

function isAccessible(frame: HTMLIFrameElement | HTMLFrameElement): boolean {
  try {
    // Touching `.body` matters: a cross-origin frame can hand back a non-null
    // `contentDocument` for the transient `about:blank` it starts on, and only
    // throws once the real document has loaded.
    return !!frame.contentDocument?.body;
  } catch {
    return false;
  }
}

function labelFor(frame: HTMLIFrameElement | HTMLFrameElement): string | undefined {
  const label =
    frame.getAttribute('title') ??
    frame.getAttribute('aria-label') ??
    frame.getAttribute('name') ??
    frame.getAttribute('id');
  return label?.trim() || undefined;
}

/**
 * Frames on this page whose contents the scan could not reach.
 *
 * Runs in the top frame. Same-origin frames are omitted — they were scanned —
 * so an empty result means the page really was covered end to end.
 */
export function detectUnscannedFrames(
  max = MAX_UNSCANNED_FRAMES_REPORTED
): { frames: UnscannedFrame[]; omitted: number } {
  const frames: UnscannedFrame[] = [];
  let omitted = 0;

  const all = Array.from(document.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>(
    'iframe, frame'
  ));

  for (const frame of all) {
    if (isAccessible(frame)) continue;

    const rect = frame.getBoundingClientRect?.();
    const width = Math.round(rect?.width ?? 0);
    const height = Math.round(rect?.height ?? 0);

    // A 1×1 analytics pixel is not missing coverage, and listing it as such
    // would bury the payment iframe that is.
    if (width < MIN_CONTENT_FRAME_PX && height < MIN_CONTENT_FRAME_PX) continue;

    if (frames.length >= max) {
      omitted += 1;
      continue;
    }

    frames.push({
      origin: frameOrigin(frame),
      label: labelFor(frame),
      width,
      height,
      reason: 'cross-origin',
    });
  }

  return { frames, omitted };
}
