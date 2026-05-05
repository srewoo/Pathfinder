import { graphRepo } from '../../storage/repositories/graph-repo.js';
import { vectorRepo } from '../../storage/repositories/vector-repo.js';
import { createLogger } from '../../utils/logger.js';
import { withErrorHandling } from './_error-wrapper.js';

const log = createLogger('clear-data');

export async function handleClearGraph() {
  return withErrorHandling(async () => {
    const graph = await graphRepo.load();
    const nodeCount = graph?.nodes.length ?? 0;
    const edgeCount = graph?.edges.length ?? 0;

    await graphRepo.save({ nodes: [], edges: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    log.info(`Cleared interaction graph (${nodeCount} nodes, ${edgeCount} edges)`);

    return {
      content: [{
        type: 'text' as const,
        text: `Interaction graph cleared. Removed ${nodeCount} pages and ${edgeCount} navigation edges. Run \`explore_app\` to rebuild.`,
      }],
    };
  }, 'clear_graph');
}

export async function handleClearKnowledge() {
  return withErrorHandling(async () => {
    const before = await vectorRepo.getAll();
    const count = before.length;

    await vectorRepo.clear();
    log.info(`Cleared knowledge vector store (${count} vectors)`);

    return {
      content: [{
        type: 'text' as const,
        text: `Knowledge base cleared. Removed ${count} vectors. Run \`crawl_knowledge\` to rebuild.`,
      }],
    };
  }, 'clear_knowledge');
}
