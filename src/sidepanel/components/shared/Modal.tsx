import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, width = 'max-w-sm' }: ModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={`relative w-full ${width} max-h-[calc(100vh-2rem)] bg-surface-1 border border-border rounded-xl shadow-2xl animate-slide-in overflow-hidden flex flex-col`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <button
            onClick={onClose}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}
