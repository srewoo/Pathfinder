import { readFile } from 'fs/promises';
import type { InteractionGraph } from '../../storage/schemas.js';
import { graphRepo } from '../../storage/repositories/graph-repo.js';
import { createLogger } from '../../utils/logger.js';
import { withErrorHandling } from './_error-wrapper.js';

const log = createLogger('import-graph');

export async function handleExportGraph(args: { file_path?: string } = {}) {
  return withErrorHandling(async () => {
    const graph = await graphRepo.load();
    if (!graph || graph.nodes.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No interaction graph found. Run `explore_app` first to build one.',
        }],
      };
    }

    const json = JSON.stringify(graph, null, 2);
    log.info(`Exported graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    if (args.file_path) {
      const { writeFile } = await import('fs/promises');
      await writeFile(args.file_path, json, 'utf-8');
      return {
        content: [{
          type: 'text' as const,
          text: [
            `Interaction graph saved to ${args.file_path}`,
            `  Pages: ${graph.nodes.length}`,
            `  Navigation edges: ${graph.edges.length}`,
            `  Explored at: ${graph.createdAt}`,
          ].join('\n'),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: [
          `Exported interaction graph: ${graph.nodes.length} pages, ${graph.edges.length} navigation edges.`,
          `Explored at: ${graph.createdAt}`,
          `\nJSON snapshot (copy this to use with \`import_explore\`, or use file_path to save directly):\n`,
          json,
        ].join('\n'),
      }],
    };
  }, 'export_graph');
}

export async function handleImportGraph(args: { graph_json?: string; file_path?: string }) {
  return withErrorHandling(async () => {
    let raw: string;
    if (args.file_path) {
      raw = await readFile(args.file_path, 'utf-8');
    } else if (args.graph_json) {
      raw = args.graph_json;
    } else {
      return {
        content: [{ type: 'text' as const, text: 'Provide either file_path (path to JSON file) or graph_json (inline JSON string).' }],
        isError: true,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to parse graph JSON: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }

    // Validate minimal structure
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj['nodes']) || !Array.isArray(obj['edges'])) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Invalid graph JSON: must have "nodes" and "edges" arrays. Use `export_graph` to see the expected format.',
        }],
        isError: true,
      };
    }

    const graph: InteractionGraph = {
      nodes: obj['nodes'] as InteractionGraph['nodes'],
      edges: obj['edges'] as InteractionGraph['edges'],
      createdAt: typeof obj['createdAt'] === 'string' ? obj['createdAt'] : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await graphRepo.save(graph);
    log.info(`Imported graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    return {
      content: [{
        type: 'text' as const,
        text: [
          `Graph imported successfully.`,
          `  Pages: ${graph.nodes.length}`,
          `  Navigation edges: ${graph.edges.length}`,
          `  Originally explored: ${graph.createdAt}`,
          ``,
          `You can now run \`run_one_liners\` against any environment — URLs will be automatically rewritten to match the target URL's origin.`,
        ].join('\n'),
      }],
    };
  }, 'import_graph');
}
