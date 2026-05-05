import React from 'react';

interface SidebarProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Root sidebar shell — wraps all panel content with consistent dimensions,
 * overflow handling, and dark-surface base. Used as the outermost container
 * in the Chrome Side Panel (400 px wide, full viewport height).
 */
export function Sidebar({ children, className = '' }: SidebarProps) {
  return (
    <div
      className={[
        'flex flex-col h-screen w-full',
        'bg-surface text-text-primary',
        'overflow-hidden select-none',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  );
}
