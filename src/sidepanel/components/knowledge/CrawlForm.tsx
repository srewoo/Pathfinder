import React, { useState } from 'react';
import { Globe, Play, Loader2 } from 'lucide-react';
import { Button } from '../shared/Button';
import { ProgressBar } from '../shared/ProgressBar';
import { useKnowledgeStore } from '../../stores/knowledge-store';

export function CrawlForm() {
  const store = useKnowledgeStore();
  const [localUrl, setLocalUrl] = useState(store.crawlUrl);

  const handleStart = async () => {
    if (!localUrl.trim()) return;
    store.setCrawlUrl(localUrl.trim());
    await store.startCrawl();
  };

  const { progress } = store;

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5">
          Help Documentation URL
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="url"
              value={localUrl}
              onChange={(e) => setLocalUrl(e.target.value)}
              placeholder="https://docs.yourproduct.com"
              disabled={store.isCrawling}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
              className={[
                'w-full h-8 bg-surface-3 border border-border rounded-lg pl-7 pr-3 text-xs',
                'text-text-primary placeholder-text-muted outline-none',
                'focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors',
                'disabled:opacity-60 disabled:cursor-not-allowed',
              ].join(' ')}
            />
          </div>
          {store.isCrawling ? (
            <Button
              variant="secondary"
              icon={<Loader2 size={11} className="animate-spin" />}
              disabled
            >
              Crawling…
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Play size={11} />}
              onClick={handleStart}
              disabled={!localUrl.trim()}
              loading={store.isCrawling}
            >
              Crawl
            </Button>
          )}
        </div>
      </div>

      {store.isCrawling && progress && (
        <div className="p-3 bg-surface-2 rounded-lg border border-border space-y-2">
          <ProgressBar
            value={progress.embedded}
            max={Math.max(progress.crawled, 1)}
            label={progress.status === 'crawling' ? 'Crawling pages...' : 'Embedding chunks...'}
            sublabel={
              progress.skipped > 0
                ? `${progress.crawled} crawled · ${progress.skipped} unchanged (skipped)`
                : `${progress.crawled} pages`
            }
            animated
          />
          {progress.currentUrl && (
            <p className="text-2xs text-text-muted font-mono truncate">
              {progress.currentUrl}
            </p>
          )}
        </div>
      )}

      {store.error && (
        <div className="p-2.5 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-xs text-error">{store.error}</p>
        </div>
      )}
    </div>
  );
}
