import React, { useRef, useState } from 'react';
import { Download, Upload, CheckCircle, AlertCircle, Loader } from 'lucide-react';
import { useKnowledgeStore } from '../../stores/knowledge-store';
import { estimateExportSize } from '../../../storage/knowledge-export';

export function KnowledgeExportImport() {
  const store = useKnowledgeStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  const hasData = store.documents.length > 0 || store.vectorCount > 0;
  const estimatedSize = estimateExportSize(store.documents.length, store.vectorCount);

  const handleExport = async () => {
    setExportSuccess(false);
    await store.exportKnowledgeBase();
    if (!store.exportImportError) {
      setExportSuccess(true);
      setTimeout(() => setExportSuccess(false), 3000);
    }
  };

  const handleImportClick = () => {
    setImportSuccess(false);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so the same file can be re-selected if needed
    e.target.value = '';

    await store.importKnowledgeBase(file);
    if (!store.exportImportError) {
      setImportSuccess(true);
      setTimeout(() => setImportSuccess(false), 4000);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-2xs font-medium text-text-muted uppercase tracking-wide">
        Export / Import
      </p>

      <div className="flex gap-2">
        {/* ── Export button ── */}
        <button
          onClick={handleExport}
          disabled={!hasData || store.isExporting || store.isCrawling}
          title={
            !hasData
              ? 'No knowledge base to export yet'
              : `Download as JSON (${estimatedSize})`
          }
          className={[
            'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-medium transition-colors',
            hasData && !store.isExporting && !store.isCrawling
              ? 'border-border bg-surface-3 text-text-secondary hover:border-primary hover:text-primary'
              : 'border-border bg-surface-2 text-text-muted opacity-50 cursor-not-allowed',
          ].join(' ')}
        >
          {store.isExporting ? (
            <Loader size={11} className="animate-spin" />
          ) : exportSuccess ? (
            <CheckCircle size={11} className="text-success" />
          ) : (
            <Download size={11} />
          )}
          {store.isExporting ? 'Exporting…' : exportSuccess ? 'Downloaded!' : 'Export'}
          {hasData && !store.isExporting && !exportSuccess && (
            <span className="text-text-muted font-normal">{estimatedSize}</span>
          )}
        </button>

        {/* ── Import button ── */}
        <button
          onClick={handleImportClick}
          disabled={store.isImporting || store.isCrawling}
          title="Import a previously exported knowledge base JSON"
          className={[
            'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-medium transition-colors',
            !store.isImporting && !store.isCrawling
              ? 'border-border bg-surface-3 text-text-secondary hover:border-info hover:text-info'
              : 'border-border bg-surface-2 text-text-muted opacity-50 cursor-not-allowed',
          ].join(' ')}
        >
          {store.isImporting ? (
            <Loader size={11} className="animate-spin" />
          ) : importSuccess ? (
            <CheckCircle size={11} className="text-success" />
          ) : (
            <Upload size={11} />
          )}
          {store.isImporting ? 'Importing…' : importSuccess ? 'Imported!' : 'Import'}
        </button>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {/* ── Status messages ── */}
      {importSuccess && (
        <div className="flex items-center gap-1.5 text-2xs text-success">
          <CheckCircle size={10} />
          <span>
            {store.documents.length} docs and {store.vectorCount} vectors imported successfully.
          </span>
        </div>
      )}

      {store.exportImportError && (
        <div className="flex items-start gap-1.5 text-2xs text-error">
          <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
          <span>{store.exportImportError}</span>
        </div>
      )}

      {store.isImporting && (
        <p className="text-2xs text-text-muted">
          Writing to IndexedDB… large files may take a few seconds.
        </p>
      )}

      <p className="text-2xs text-text-muted">
        Export saves all crawled text and embeddings as a JSON file.
        Import restores from a previous export — existing data is replaced.
      </p>
    </div>
  );
}
