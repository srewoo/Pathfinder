const IS_DEV = import.meta.env?.DEV ?? false;

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  data?: unknown;
  timestamp: string;
}

function formatEntry(entry: LogEntry): string {
  const ts = entry.timestamp.slice(11, 23);
  const ctx = entry.context ? `[${entry.context}]` : '';
  return `[pathfinder]${ctx} ${ts} ${entry.level.toUpperCase()}: ${entry.message}`;
}

function log(level: LogLevel, message: string, context?: string, data?: unknown): void {
  if (!IS_DEV && level === 'debug') return;

  const entry: LogEntry = {
    level,
    message,
    context,
    data,
    timestamp: new Date().toISOString(),
  };

  const formatted = formatEntry(entry);

  switch (level) {
    case 'error':
      console.error(formatted, data ?? '');
      break;
    case 'warn':
      console.warn(formatted, data ?? '');
      break;
    case 'debug':
      console.debug(formatted, data ?? '');
      break;
    default:
      console.info(formatted, data ?? '');
  }
}

export function createLogger(context: string) {
  return {
    info: (message: string, data?: unknown) => log('info', message, context, data),
    warn: (message: string, data?: unknown) => log('warn', message, context, data),
    error: (message: string, data?: unknown) => log('error', message, context, data),
    debug: (message: string, data?: unknown) => log('debug', message, context, data),
  };
}

export const logger = createLogger('core');
