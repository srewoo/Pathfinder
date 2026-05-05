import { loadGraph, serializeGraphForAI } from '../../core/explorer/interaction-graph.js';
import { withErrorHandling } from './_error-wrapper.js';

export async function handleGetGraph() {
  return withErrorHandling(async () => {
    const graph = await loadGraph();
    if (!graph) return { content: [{ type: 'text' as const, text: 'No exploration data. Run explore_app first.' }] };
    return { content: [{ type: 'text' as const, text: serializeGraphForAI(graph) }] };
  }, 'get_graph');
}
