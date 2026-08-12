import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/sidepanel/**/*.{ts,tsx,html}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: 'var(--surface)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        border: {
          DEFAULT: 'var(--border)',
          light: 'var(--border-light)',
        },
        // `DEFAULT` is the FILL (backgrounds, borders, icons); `text` is the
        // text-safe variant. Several of these hues pass comfortably as a 15%
        // fill and fail WCAG AA as 11px text in light mode — warning at 2.91:1,
        // success at 3.44:1 — so the split is what lets component code stay
        // theme-agnostic without shipping unreadable labels.
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          light: 'var(--primary-light)',
          deep: 'var(--primary-deep)',
          dim: 'var(--primary-dim)',
          text: 'var(--primary-text)',
        },
        success: {
          DEFAULT: 'var(--success)',
          dim: 'var(--success-dim)',
          text: 'var(--success-text)',
        },
        error: {
          DEFAULT: 'var(--error)',
          dim: 'var(--error-dim)',
          text: 'var(--error-text)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          dim: 'var(--warning-dim)',
          text: 'var(--warning-text)',
        },
        info: {
          DEFAULT: 'var(--info)',
          dim: 'var(--info-dim)',
          text: 'var(--info-text)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          faint: 'var(--text-faint)',
          code: 'var(--text-code)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      // A real scale at a ~1.18 ratio, with line heights.
      //
      // Was a single `2xs: 0.65rem` (10.4px) entry — and 96% of the panel used
      // either that or `xs` (12px), two sizes 1.6px apart, which is a font size
      // and a slightly smaller font size rather than a hierarchy. 10.4px is also
      // below comfortable reading size for body copy in a side panel.
      //
      // The same class was ALSO defined in index.css's utilities layer, so which
      // definition won depended on emission order. This is now the only source.
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],      // 11px
        xs: ['0.8125rem', { lineHeight: '1.125rem' }],     // 13px
        sm: ['0.9375rem', { lineHeight: '1.25rem' }],      // 15px
      },
      // Radius follows element height, so an 18px pill and a 400px container stop
      // sharing a value.
      borderRadius: {
        sm: '3px',
        DEFAULT: '5px',
        md: '6px',
        lg: '8px',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 2s linear infinite',
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-in': 'slideIn 0.2s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideIn: {
          '0%': { transform: 'translateY(-8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
