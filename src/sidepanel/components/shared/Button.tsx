import React from 'react';
import { Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-quiet';
type Size = 'xs' | 'sm' | 'md';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: React.ReactNode;
  fullWidth?: boolean;
}

/**
 * Weight follows consequence.
 *
 * `danger` used to be a 10%-opacity tint with a 30%-opacity border while
 * `secondary` was a solid fill — so "Delete" was visually LIGHTER than "Cancel",
 * which is exactly backwards for the pair that matters most. A confirmed
 * destructive action now carries the heaviest treatment in the set.
 *
 * `danger-quiet` exists for the other destructive case: an icon-only affordance in
 * a dense row, where a solid red fill per row would turn a list into an alarm.
 *
 * `success` was removed. A green button is not a hierarchy tier — if it means "the
 * confirming choice", that is `primary`.
 */
const variantClasses: Record<Variant, string> = {
  primary: 'bg-primary hover:bg-primary-hover text-white border-transparent shadow-sm shadow-primary/25',
  danger: 'bg-error hover:bg-error/90 text-white border-transparent shadow-sm shadow-error/25',
  secondary: 'bg-surface-2 hover:bg-surface-3 text-text-primary border-border-light',
  'danger-quiet': 'bg-transparent hover:bg-error/10 text-error-text border-transparent',
  ghost: 'bg-transparent hover:bg-surface-2 text-text-secondary hover:text-text-primary border-transparent',
};

const sizeClasses: Record<Size, string> = {
  xs: 'h-6 px-2 text-2xs gap-1 rounded-sm',
  sm: 'h-7 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-4 text-sm gap-2 rounded-lg',
};

/** The spinner was a fixed 12px, so on `md` it was visibly smaller than the icon. */
const spinnerSize: Record<Size, number> = { xs: 10, sm: 12, md: 14 };

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
        <Loader2 className="animate-spin" size={spinnerSize[size]} />
      ) : (
        icon && <span className="flex-shrink-0">{icon}</span>
      )}
      {children && <span>{children}</span>}
    </button>
  );
}
