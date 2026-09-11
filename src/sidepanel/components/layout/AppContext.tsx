import { useEffect, useState } from 'react';

/**
 * The context a panel action will actually run against.
 *
 * Everything in this side panel acts on "the current tab" and, until now,
 * nothing said which tab that is. A run started from the wrong tab looks
 * identical to a run started from the right one right up until its results are
 * wrong, and the panel outlives any number of tab switches.
 *
 * Unknown is a real state and is reported as such — an origin invented from the
 * last thing the panel happened to see would be worse than no origin at all.
 */
export function useActiveOrigin(): { origin: string | undefined; known: boolean } {
  const [origin, setOrigin] = useState<string | undefined>(undefined);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function read() {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (cancelled) return;
        if (!tab?.url) {
          setOrigin(undefined);
          setKnown(false);
          return;
        }
        // A chrome:// or extension page is a real answer — it is where the
        // panel is pointed, and it is why an action would do nothing.
        setOrigin(new URL(tab.url).origin);
        setKnown(true);
      } catch {
        if (!cancelled) {
          setOrigin(undefined);
          setKnown(false);
        }
      }
    }

    void read();

    // The panel stays open across tab switches and navigations, so a value read
    // once at mount is stale for most of its life.
    const onActivated = () => void read();
    const onUpdated = () => void read();
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);

    return () => {
      cancelled = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  return { origin, known };
}

/** Shorten an origin for a header that has one line to spend. */
export function shortOrigin(origin: string | undefined): string {
  if (!origin) return 'no page';
  try {
    const { hostname, port, protocol } = new URL(origin);
    if (protocol === 'chrome:' || protocol === 'chrome-extension:') return 'browser page';
    return port ? `${hostname}:${port}` : hostname;
  } catch {
    return origin;
  }
}
