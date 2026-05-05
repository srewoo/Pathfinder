import React, { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../shared/Button';

interface RetryTestModalProps {
  testCaseName: string;
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (additionalContext: string) => void;
}

export function RetryTestModal({ testCaseName, isOpen, onClose, onSubmit }: RetryTestModalProps) {
  const [context, setContext] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(context);
    setContext('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md bg-surface-1 border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between p-4 border-b border-border bg-surface-2 text-text-primary">
          <div>
            <h3 className="text-sm font-semibold">Regenerate Test Case</h3>
            <p className="text-xs text-text-muted mt-0.5 truncate max-w-[280px]">
              {testCaseName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          <div>
             <p className="text-xs text-text-secondary mb-2 leading-relaxed">
              If the AI got the steps wrong, provide specific feedback to fix them. What edge case was missing? Which button should it have clicked instead?
            </p>
            <label htmlFor="additional-context" className="block text-xs font-medium text-text-primary mb-1">
              Additional Context
            </label>
            <textarea
              id="additional-context"
              autoFocus
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="e.g., 'Make sure to select the advanced options tab first before clicking submit...'"
              className="w-full h-24 px-3 py-2 text-sm bg-surface-2 border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={context.trim().length === 0}
            >
              Regenerate
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
