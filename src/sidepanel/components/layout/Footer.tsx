import React from 'react';
import { HelpCircle, Shield } from 'lucide-react';

function openExtensionPage(filename: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL(filename) });
}

export function Footer() {
  return (
    <footer className="flex items-center justify-center gap-4 px-3 py-1.5 border-t border-border bg-surface-2 shrink-0">
      <button
        onClick={() => openExtensionPage('help.html')}
        className="flex items-center gap-1 text-2xs text-text-muted hover:text-primary transition-colors"
      >
        <HelpCircle size={10} />
        Help
      </button>
      <span className="text-border select-none">·</span>
      <button
        onClick={() => openExtensionPage('privacypolicy.html')}
        className="flex items-center gap-1 text-2xs text-text-muted hover:text-primary transition-colors"
      >
        <Shield size={10} />
        Privacy Policy
      </button>
    </footer>
  );
}
