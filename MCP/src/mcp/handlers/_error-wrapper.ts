import { createLogger } from '../../utils/logger.js';

const log = createLogger('mcp-handler');

export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  toolName: string
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Tool ${toolName} failed: ${message}`, err);
    return {
      content: [{ type: 'text' as const, text: `Error in ${toolName}: ${message}` }],
      isError: true,
    } as T;
  }
}
