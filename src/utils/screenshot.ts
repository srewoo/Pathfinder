import { createLogger } from './logger';

const log = createLogger('screenshot');

export async function captureActiveTab(): Promise<string | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.windowId) return undefined;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 80,
    });

    return dataUrl;
  } catch (err) {
    log.warn('Screenshot capture failed', err);
    return undefined;
  }
}

export async function captureTab(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.windowId) return undefined;

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'png',
      quality: 80,
    });

    return dataUrl;
  } catch (err) {
    log.warn('Screenshot capture failed for tab', { tabId, err });
    return undefined;
  }
}
