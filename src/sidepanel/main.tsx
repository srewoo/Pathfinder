import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// ── Per-tab panel lifecycle ───────────────────────────────────────────────────
// Establish a long-lived port to the background service worker.
// When the user closes this side panel, the port disconnects — the background
// uses that signal to disable the panel for this specific tab so it doesn't
// reappear on other tabs in the same window.
const port = chrome.runtime.connect({ name: 'sidepanel' });

// Tell the background which window this panel is attached to so it can map
// windowId → tabId correctly. chrome.tabs.query with currentWindow:true works
// from extension pages without requiring the "windows" permission.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (tab?.windowId) {
    port.postMessage({ windowId: tab.windowId });
  }
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
