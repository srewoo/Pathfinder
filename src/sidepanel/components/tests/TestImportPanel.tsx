import React, { useState, useRef } from 'react';
import { Upload, FileText, X, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '../shared/Button';
import { useTestStore } from '../../stores/test-store';
import { validateImportFile } from '../../../core/test-gen/test-importer';

const SAMPLE_JSON = `{
  "version": "1",
  "tests": [
    {
      "title": "User can log in with valid credentials",
      "type": "positive",
      "startUrl": "https://yourapp.com/login",
      "context": "Tests the standard login flow for regular users",
      "steps": [
        "Enter valid email address",
        "Enter correct password",
        "Click the Login button",
        "Verify the dashboard is visible"
      ]
    },
    {
      "title": "Login fails with incorrect password",
      "type": "negative",
      "startUrl": "https://yourapp.com/login",
      "steps": [
        "Enter valid email address",
        "Enter wrong password",
        "Click the Login button",
        "Verify error message is shown"
      ]
    },
    {
      "title": "User can create a new project",
      "type": "positive",
      "executionPresetId": "preset-admin-authenticated",
      "context": "User must be logged in. Tests the project creation flow."
    }
  ]
}`;

export function TestImportPanel() {
  const [expanded, setExpanded] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { importTests, isImporting, importProgress } = useTestStore();

  const reset = () => {
    setJsonText('');
    setValidationError(null);
    setShowSample(false);
    setExpanded(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setJsonText(text);
      setValidationError(null);
    };
    reader.readAsText(file);
    // reset input so same file can be re-selected
    e.target.value = '';
  };

  const handleImport = async () => {
    setValidationError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      setValidationError('Invalid JSON — check your syntax and try again.');
      return;
    }

    const result = validateImportFile(parsed);
    if (!result.valid) {
      setValidationError(result.error);
      return;
    }

    await importTests(result.file.tests);
    reset();
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-2 p-2.5 bg-surface-2 border border-dashed border-border hover:border-primary/50 rounded-lg text-xs text-text-muted hover:text-text-secondary transition-colors"
      >
        <Upload size={12} />
        Import tests from JSON...
      </button>
    );
  }

  // Show progress overlay when importing
  if (isImporting && importProgress) {
    return (
      <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-primary">Importing tests…</span>
          <span className="text-2xs text-text-muted">{importProgress.current}/{importProgress.total}</span>
        </div>
        <div className="w-full bg-surface-3 rounded-full h-1.5">
          <div
            className="bg-primary h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
          />
        </div>
        <p className="text-2xs text-text-muted truncate">
          {importProgress.phase === 'expanding' ? 'Expanding' : 'Saving'}: {importProgress.title}
        </p>
      </div>
    );
  }

  return (
    <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-primary">Import Tests from JSON</span>
        <button onClick={reset} className="text-text-muted hover:text-text-secondary transition-colors">
          <X size={12} />
        </button>
      </div>

      {/* File upload */}
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          className="hidden"
        />
        <Button
          variant="ghost"
          size="xs"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={10} className="mr-1" />
          Upload .json file
        </Button>
      </div>

      {/* Paste area */}
      <div className="space-y-1">
        <label className="block text-2xs font-medium text-text-secondary">Or paste JSON</label>
        <textarea
          value={jsonText}
          onChange={(e) => { setJsonText(e.target.value); setValidationError(null); }}
          placeholder='{ "version": "1", "tests": [...] }'
          rows={5}
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none font-mono leading-relaxed"
        />
      </div>

      {/* Validation error */}
      {validationError && (
        <div className="flex items-start gap-1.5 p-2 bg-error/10 border border-error/20 rounded-lg">
          <AlertCircle size={12} className="text-error mt-0.5 shrink-0" />
          <p className="text-2xs text-error">{validationError}</p>
        </div>
      )}

      {/* Format sample toggle */}
      <button
        onClick={() => setShowSample((v) => !v)}
        className="flex items-center gap-1 text-2xs text-text-muted hover:text-text-secondary transition-colors"
      >
        <FileText size={10} />
        {showSample ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        View format sample
      </button>

      {showSample && (
        <pre className="text-2xs text-text-muted bg-surface-3 border border-border rounded-lg p-2 overflow-x-auto leading-relaxed whitespace-pre-wrap">
          {SAMPLE_JSON}
        </pre>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="xs"
          onClick={handleImport}
          disabled={!jsonText.trim() || isImporting}
        >
          Import & Expand
        </Button>
        <Button variant="ghost" size="xs" onClick={reset}>
          Cancel
        </Button>
        <span className="text-2xs text-text-muted ml-auto">AI will enrich each test</span>
      </div>
    </div>
  );
}
