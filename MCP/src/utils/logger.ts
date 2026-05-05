type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const IS_DEV = process.env.NODE_ENV !== 'production';

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

function writeStderr(text: string): void {
  process.stderr.write(text + '\n');
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

  if (data !== undefined && data !== '') {
    const dataStr = data instanceof Error
      ? data.stack ?? data.message
      : typeof data === 'string' ? data : JSON.stringify(data);
    writeStderr(`${formatted} ${dataStr}`);
  } else {
    writeStderr(formatted);
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
