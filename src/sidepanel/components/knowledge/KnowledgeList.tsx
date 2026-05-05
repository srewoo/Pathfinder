import React from 'react';
import { FileText, ExternalLink } from 'lucide-react';
import type { CrawledDocument } from '../../../storage/schemas';

interface KnowledgeListProps {
  documents: CrawledDocument[];
}

export function KnowledgeList({ documents }: KnowledgeListProps) {
  if (documents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <FileText size={28} className="text-text-muted mb-2" />
        <p className="text-xs text-text-secondary font-medium">No documents indexed</p>
        <p className="text-2xs text-text-muted mt-1">Enter a help site URL and click Crawl</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {documents.map((doc) => (
        <div
          key={doc.id}
          className="flex items-start gap-2 p-2 rounded-lg bg-surface-2 border border-border hover:border-border-light transition-colors group"
        >
          <FileText size={12} className="text-info flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-text-primary truncate leading-tight">
              {doc.title || 'Untitled'}
            </p>
            <p className="text-2xs text-text-muted truncate mt-0.5 font-mono">{doc.url}</p>
            <p className="text-2xs text-text-muted mt-0.5">{doc.chunkCount} chunks</p>
          </div>
          <a
            href={doc.url}
            target="_blank"
            rel="noreferrer"
            className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-secondary"
          >
            <ExternalLink size={10} />
          </a>
        </div>
      ))}
    </div>
  );
}
