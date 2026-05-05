import React from 'react';
import { CheckCircle2, XCircle, AlertCircle, Clock, Loader2, MinusCircle } from 'lucide-react';

type Status = 'passed' | 'failed' | 'error' | 'running' | 'pending' | 'skipped';

interface StatusIndicatorProps {
  status: Status;
  size?: number;
  showLabel?: boolean;
  className?: string;
}

const config: Record<Status, { icon: React.ElementType; color: string; label: string }> = {
  passed: { icon: CheckCircle2, color: 'text-success', label: 'Passed' },
  failed: { icon: XCircle, color: 'text-error', label: 'Failed' },
  error: { icon: AlertCircle, color: 'text-error', label: 'Error' },
  running: { icon: Loader2, color: 'text-primary-light', label: 'Running' },
  pending: { icon: Clock, color: 'text-text-muted', label: 'Pending' },
  skipped: { icon: MinusCircle, color: 'text-text-muted', label: 'Skipped' },
};

export function StatusIndicator({
  status,
  size = 14,
  showLabel = false,
  className = '',
}: StatusIndicatorProps) {
  const { icon: Icon, color, label } = config[status];

  return (
    <span className={`inline-flex items-center gap-1 ${color} ${className}`}>
      <Icon
        size={size}
        className={status === 'running' ? 'animate-spin' : ''}
      />
      {showLabel && (
        <span className="text-xs font-medium">{label}</span>
      )}
    </span>
  );
}
