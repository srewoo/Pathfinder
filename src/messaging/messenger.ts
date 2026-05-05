import type { BackgroundMessage, ContentScriptMessage, SidebarMessage } from './messages';

const CONTENT_SCRIPT_TIMEOUT_MS = 12000;

export async function sendToBackground<T = unknown>(message: BackgroundMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Send a message to the content script with a timeout guard.
 * If the content script is not injected (e.g. during navigation, on chrome://
 * pages, or restricted domains) the promise rejects with a clear error instead
 * of hanging indefinitely.
 */
export async function sendToContentScript<T = unknown>(
  tabId: number,
  message: ContentScriptMessage,
  timeoutMs = CONTENT_SCRIPT_TIMEOUT_MS
): Promise<T> {
  const messagePromise = new Promise<T>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: T) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Content script did not respond within ${timeoutMs}ms`)),
      timeoutMs
    )
  );

  return Promise.race([messagePromise, timeoutPromise]);
}

/**
 * Ping the content script to verify it is alive and ready to receive messages.
 * Returns true if the content script responded, false otherwise.
 */
export async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = await sendToContentScript<{ type: string }>(tabId, { type: 'PING' }, 3000);
    return response?.type === 'PONG';
  } catch {
    return false;
  }
}

export async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

export function broadcastToSidebar(message: SidebarMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Sidebar may not be open; ignore
  });
}

export function onBackgroundMessage(
  handler: (
    message: BackgroundMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | void
): void {
  chrome.runtime.onMessage.addListener(handler);
}

export function onSidebarMessage(
  handler: (
    message: SidebarMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => boolean | void
): void {
  chrome.runtime.onMessage.addListener(handler as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
}
