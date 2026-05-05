import React, { useRef, useState } from 'react';
import { Download, Upload, Trash2, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useExplorerStore } from '../../stores/explorer-store';

export function ExplorerDataControls() {
  const store = useExplorerStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);

  const pageCount = store.graph?.nodes.length ?? 0;
  const edgeCount = store.graph?.edges.length ?? 0;
  const flowCount = store.flows.length;
  const hasData = pageCount > 0 || edgeCount > 0 || flowCount > 0;

  const handleExport = async () => {
    setExportSuccess(false);
    await store.exportExplorationData();
    if (!useExplorerStore.getState().exportImportError) {
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
    e.target.value = '';

    await store.importExplorationData(file);
    if (!useExplorerStore.getState().exportImportError) {
      setImportSuccess(true);
      setTimeout(() => setImportSuccess(false), 4000);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete exploration graph and learned flows? Existing tests and knowledge base will be kept.')) {
      return;
    }
    setImportSuccess(false);
    setExportSuccess(false);
    await store.clearExplorationData();
  };

  return (
    <div className="space-y-2">
      <p className="text-2xs font-medium text-text-muted uppercase tracking-wide">
        Exploration Data
      </p>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-border bg-surface-2 p-2 text-center">
          <div className="text-sm font-semibold text-text-primary">{pageCount}</div>
          <div className="text-2xs text-text-muted">Pages</div>
        </div>
        <div className="rounded-lg border border-border bg-surface-2 p-2 text-center">
          <div className="text-sm font-semibold text-text-primary">{edgeCount}</div>
          <div className="text-2xs text-text-muted">Edges</div>
        </div>
        <div className="rounded-lg border border-border bg-surface-2 p-2 text-center">
          <div className="text-sm font-semibold text-text-primary">{flowCount}</div>
          <div className="text-2xs text-text-muted">Flows</div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleExport}
          disabled={!hasData || store.isExporting || store.isImporting || store.isDeleting || store.isExploring}
          className={[
            'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-medium transition-colors',
            hasData && !store.isExporting && !store.isImporting && !store.isDeleting && !store.isExploring
              ? 'border-border bg-surface-3 text-text-secondary hover:border-primary hover:text-primary'
              : 'border-border bg-surface-2 text-text-muted opacity-50 cursor-not-allowed',
          ].join(' ')}
        >
          {store.isExporting ? (
            <Loader2 size={11} className="animate-spin" />
          ) : exportSuccess ? (
            <CheckCircle size={11} className="text-success" />
          ) : (
            <Download size={11} />
          )}
          {store.isExporting ? 'Exporting…' : exportSuccess ? 'Downloaded!' : 'Export'}
        </button>

        <button
          onClick={handleImportClick}
          disabled={store.isImporting || store.isExporting || store.isDeleting || store.isExploring}
          className={[
            'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-medium transition-colors',
            !store.isImporting && !store.isExporting && !store.isDeleting && !store.isExploring
              ? 'border-border bg-surface-3 text-text-secondary hover:border-info hover:text-info'
              : 'border-border bg-surface-2 text-text-muted opacity-50 cursor-not-allowed',
          ].join(' ')}
        >
          {store.isImporting ? (
            <Loader2 size={11} className="animate-spin" />
          ) : importSuccess ? (
            <CheckCircle size={11} className="text-success" />
          ) : (
            <Upload size={11} />
          )}
          {store.isImporting ? 'Importing…' : importSuccess ? 'Imported!' : 'Import'}
        </button>

        <button
          onClick={handleDelete}
          disabled={!hasData || store.isDeleting || store.isImporting || store.isExporting || store.isExploring}
          className={[
            'flex-1 flex items-center justify-center gap-1.5 h-8 rounded-lg border text-xs font-medium transition-colors',
            hasData && !store.isDeleting && !store.isImporting && !store.isExporting && !store.isExploring
              ? 'border-error/30 bg-error/10 text-error hover:bg-error/20'
              : 'border-border bg-surface-2 text-text-muted opacity-50 cursor-not-allowed',
          ].join(' ')}
        >
          {store.isDeleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
          {store.isDeleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />

      {store.exportImportError && (
        <div className="flex items-start gap-1.5 text-2xs text-error">
          <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
          <span>{store.exportImportError}</span>
        </div>
      )}

      {importSuccess && (
        <div className="flex items-center gap-1.5 text-2xs text-success">
          <CheckCircle size={10} />
          <span>Exploration graph and learned flows restored successfully.</span>
        </div>
      )}

      <p className="text-2xs text-text-muted">
        Export saves the explored page graph and learned flows. Import replaces the current exploration graph and flows.
        Delete removes only exploration data; knowledge base, tests, and results stay untouched.
      </p>
    </div>
  );
}
