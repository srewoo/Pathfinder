import { stopOperation, listActiveOperations } from '../../orchestrator/operation-abort.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleCancelOperation(args: { operation?: string }) {
  return withErrorHandling(async () => {
    const op = args.operation ?? 'all';
    if (op === 'all') {
      const active = listActiveOperations();
      active.forEach((name) => stopOperation(name));
      return {
        content: [{ type: 'text' as const, text: active.length > 0 ? `Stopped: ${active.join(', ')}` : 'No operations were running' }],
      };
    }
    const stopped = stopOperation(op);
    return {
      content: [{ type: 'text' as const, text: stopped ? `Stopped "${op}" operation` : `No "${op}" operation was running` }],
    };
  }, 'cancel_operation');
}
