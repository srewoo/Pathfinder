import React from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'xs' | 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-primary hover:bg-primary-hover text-white border-transparent shadow-sm shadow-primary/20',
  secondary: 'bg-surface-2 hover:bg-surface-3 text-text-primary border-border-light',
  ghost: 'bg-transparent hover:bg-surface-2 text-text-secondary hover:text-text-primary border-transparent',
  danger: 'bg-error/10 hover:bg-error/20 text-error border-error/30',
  success: 'bg-success/10 hover:bg-success/20 text-success border-success/30',
};

const sizeClasses: Record<Size, string> = {
  xs: 'h-6 px-2 text-xs gap-1 rounded',
  sm: 'h-7 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-4 text-sm gap-2 rounded-lg',
};

export function Button({
  variant = 'secondary',
  size = 'sm',
  loading = false,
  icon,
  fullWidth = false,
  children,
  className = '',
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={[
        'inline-flex items-center justify-center font-medium border transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-primary/50',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
    >
      {loading ? (
        <Loader2 className="animate-spin" size={12} />
      ) : (
        icon && <span className="flex-shrink-0">{icon}</span>
      )}
      {children && <span>{children}</span>}
    </button>
  );
}
