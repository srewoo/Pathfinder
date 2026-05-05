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
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          light: 'var(--primary-light)',
          dim: 'var(--primary-dim)',
        },
        success: {
          DEFAULT: 'var(--success)',
          dim: 'var(--success-dim)',
        },
        error: {
          DEFAULT: 'var(--error)',
          dim: 'var(--error-dim)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          dim: 'var(--warning-dim)',
        },
        info: {
          DEFAULT: 'var(--info)',
          dim: 'var(--info-dim)',
        },
        text: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted: 'var(--text-muted)',
          code: 'var(--text-code)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        '2xs': '0.65rem',
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
