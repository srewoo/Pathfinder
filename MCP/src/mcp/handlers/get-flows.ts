import { getAllFlows, serializeFlowsForAI } from '../../core/flow/flow-store.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleGetFlows() {
  return withErrorHandling(async () => {
    const flows = await getAllFlows();
    return { content: [{ type: 'text' as const, text: serializeFlowsForAI(flows) }] };
  }, 'get_flows');
}
