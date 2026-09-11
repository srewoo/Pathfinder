/**
 * Where the side panel lives, and for which tab.
 *
 * The panel is deliberately NOT enabled globally: enabling it once turns it on
 * for every tab in the window, so switching tabs makes it reappear where nobody
 * asked for it. Instead it is enabled per tab when the user clicks the action,
 * and disabled again when they close it — which means keeping a small amount of
 * window→tab state and listening for three separate ways it can end.
 *
 * Split out of `service-worker.ts` unchanged. It is browser-window lifecycle,
 * entirely unrelated to the message handling that file otherwise does, and it
 * registers its listeners at import time exactly as before.
 */
import { createLogger } from '../utils/logger';

const log = createLogger('sw-panel');

/**
 * Install the panel lifecycle listeners.
 *
 * Called at module scope from the worker's entry point, because MV3 listener
 * registrations do not survive eviction and must be re-established on every
 * worker start — before any event can arrive.
 */
// Maps windowId → tabId for every tab that has the side panel enabled. This is
// what lets the panel be disabled for the exact tab when the user closes it,
// rather than for every tab in the window.
const panelTabByWindow = new Map<number, number>();

/**
 * Record that the panel is now enabled for this tab.
 *
 * Needed because the panel can also be enabled from a message handler
 * (`OPEN_SIDE_PANEL`), and a tab enabled that way must still be cleaned up by
 * the disconnect and close listeners below.
 */
export function trackPanelTab(windowId: number, tabId: number): void {
  panelTabByWindow.set(windowId, tabId);
}

export function installPanelLifecycle(): void {

  chrome.runtime.onInstalled.addListener(() => {
    log.info('pathfinder installed');
    // Disable the panel globally by default — it will only be enabled for the
    // specific tab the user clicks the extension icon on.
    // This prevents the panel from appearing on every tab in the same window.
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  });

  // Open / re-open the panel for the tab the user clicked the extension icon on.
  // IMPORTANT: sidePanel.open() must be called synchronously within the user-gesture
  // handler — any `await` before it breaks the gesture chain and Chrome rejects the call.
  // We fire both setOptions and open without awaiting; the browser IPC queue ensures
  // setOptions is applied before open is processed.
  chrome.action.onClicked.addListener((tab) => {
    if (!tab.id || !tab.windowId) return;
    const { id: tabId, windowId } = tab;

    chrome.sidePanel
      .setOptions({ tabId, enabled: true, path: 'src/sidepanel/index.html' })
      .catch((err) => log.warn('setOptions failed', err));

    chrome.sidePanel
      .open({ tabId })
      .then(() => {
        panelTabByWindow.set(windowId, tabId);
        log.info(`Opened panel for tab ${tabId} (window ${windowId})`);
      })
      .catch((err) => log.warn('Failed to open side panel', err));
  });

  // When the side panel loads it connects with name "sidepanel" and reports its
  // windowId. We use the disconnect event to detect when the user closes the panel,
  // then disable it for that tab so it doesn't reappear on the next tab switch.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sidepanel') return;

    let assignedTabId: number | undefined;

    port.onMessage.addListener((msg: unknown) => {
      if (typeof msg === 'object' && msg !== null && 'windowId' in msg) {
        const windowId = (msg as { windowId: number }).windowId;
        assignedTabId = panelTabByWindow.get(windowId);
      }
    });

    port.onDisconnect.addListener(() => {
      if (assignedTabId !== undefined) {
        chrome.sidePanel.setOptions({ tabId: assignedTabId, enabled: false }).catch(() => {});
        // Clean up the map entry
        for (const [wid, tid] of panelTabByWindow.entries()) {
          if (tid === assignedTabId) { panelTabByWindow.delete(wid); break; }
        }
        log.info(`Panel closed — disabled for tab ${assignedTabId}`);
      }
    });
  });

  // Remove tab from tracking when the tab itself is closed.
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [windowId, tid] of panelTabByWindow.entries()) {
      if (tid === tabId) { panelTabByWindow.delete(windowId); break; }
    }
  });
}
