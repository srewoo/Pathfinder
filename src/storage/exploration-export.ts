import type { Flow, InteractionGraph } from './schemas';
import { flowDB, graphDB } from './indexed-db';

export const EXPLORATION_EXPORT_VERSION = '1' as const;

export interface ExplorationExport {
  version: typeof EXPLORATION_EXPORT_VERSION;
  exportedAt: string;
  pageCount: number;
  edgeCount: number;
  flowCount: number;
  graph: InteractionGraph | null;
  flows: Flow[];
}

export interface ExplorationImportResult {
  pageCount: number;
  edgeCount: number;
  flowCount: number;
}

export async function exportExploration(baseUrl?: string): Promise<ExplorationImportResult> {
  const [graph, flows] = await Promise.all([
    graphDB.load(),
    flowDB.getAll(),
  ]);

  const payload: ExplorationExport = {
    version: EXPLORATION_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    pageCount: graph?.nodes.length ?? 0,
    edgeCount: graph?.edges.length ?? 0,
    flowCount: flows.length,
    graph: graph ?? null,
    flows,
  };

  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const hostname = safeHostname(baseUrl ?? graph?.nodes[0]?.url ?? flows[0]?.startUrl ?? 'exploration');
  const date = new Date().toISOString().slice(0, 10);
  const filename = `pathfinder-exploration-${hostname}-${date}.json`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return {
    pageCount: payload.pageCount,
    edgeCount: payload.edgeCount,
    flowCount: payload.flowCount,
  };
}

export async function importExploration(file: File): Promise<ExplorationImportResult> {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;
  assertValidExplorationExport(parsed);

  await Promise.all([graphDB.clear(), flowDB.clear()]);

  if (parsed.graph) {
    await graphDB.save(parsed.graph);
  }

  await Promise.all(parsed.flows.map((flow) => flowDB.put(flow)));

  return {
    pageCount: parsed.graph?.nodes.length ?? 0,
    edgeCount: parsed.graph?.edges.length ?? 0,
    flowCount: parsed.flows.length,
  };
}

export async function clearExplorationArtifacts(): Promise<void> {
  await Promise.all([graphDB.clear(), flowDB.clear()]);
}

function assertValidExplorationExport(value: unknown): asserts value is ExplorationExport {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid file: not a JSON object');
  }

  const obj = value as Record<string, unknown>;
  if (obj['version'] !== EXPLORATION_EXPORT_VERSION) {
    throw new Error(
      `Unsupported exploration export version: ${String(obj['version'])}. Expected "${EXPLORATION_EXPORT_VERSION}".`
    );
  }
  if (!Array.isArray(obj['flows'])) {
    throw new Error('Invalid file: missing flows array');
  }
  if (obj['graph'] !== null && obj['graph'] !== undefined && typeof obj['graph'] !== 'object') {
    throw new Error('Invalid file: graph must be an object or null');
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/\./g, '-');
  } catch {
    return url.slice(0, 30).replace(/[^a-z0-9-]/gi, '-');
  }
}
