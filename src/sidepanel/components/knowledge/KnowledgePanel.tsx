import React, { useEffect } from 'react';
import { Database, Layers } from 'lucide-react';
import { CrawlForm } from './CrawlForm';
import { KnowledgeList } from './KnowledgeList';
import { KnowledgeExportImport } from './KnowledgeExportImport';
import { useKnowledgeStore } from '../../stores/knowledge-store';

export function KnowledgePanel() {
  const store = useKnowledgeStore();

  useEffect(() => {
    store.loadDocuments();
  }, []);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xs font-semibold text-text-primary">Knowledge Base</h2>
          <p className="text-2xs text-text-muted mt-0.5">Crawl help docs to build AI context</p>
        </div>
        {store.documents.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1 text-2xs text-text-muted">
              <Database size={10} />
              <span>{store.documents.length} docs</span>
            </div>
            <div className="flex items-center gap-1 text-2xs text-text-muted">
              <Layers size={10} />
              <span>{store.vectorCount} vectors</span>
            </div>
          </div>
        )}
      </div>

      <CrawlForm />

      <div className="border-t border-border pt-3">
        <KnowledgeExportImport />
      </div>

      {store.documents.length > 0 && (
        <div>
          <h3 className="text-2xs font-medium text-text-muted uppercase tracking-wide mb-2">
            Indexed Documents
          </h3>
          <KnowledgeList documents={store.documents} />
        </div>
      )}
    </div>
  );
}
