import { memoryStore, type MemoryCategory } from '../../memory/memory-store.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleMemory(action: 'set' | 'get', args: Record<string, unknown>) {
  return withErrorHandling(async () => {
    if (action === 'set') {
      await memoryStore.set(args.key as string, args.value, args.category as MemoryCategory);
      return { content: [{ type: 'text' as const, text: `Remembered: ${args.key}` }] };
    }

    const query = args.query as string;
    const results = await memoryStore.search(query);
    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No memories found for "${query}"` }] };
    }
    const formatted = results.map((r) => `[${r.category}] ${r.key}: ${JSON.stringify(r.value)}`).join('\n');
    return { content: [{ type: 'text' as const, text: formatted }] };
  }, 'memory');
}
