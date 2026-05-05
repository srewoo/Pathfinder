import fs from 'node:fs/promises';
import { initDatabase, closeDatabase } from '../storage/database.js';
import { graphRepo } from '../storage/repositories/graph-repo.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('import-interaction-graph');

type InteractionGraphShape = {
  nodes: unknown[];
  edges: unknown[];
  createdAt?: string;
  updatedAt?: string;
};

function extractGraph(payload: unknown): InteractionGraphShape {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid snapshot: expected an object');
  }

  const obj = payload as Record<string, unknown>;

  // Some exports are wrapper objects: { graph: { nodes, edges, ... }, ... }
  if (obj.graph && typeof obj.graph === 'object') {
    const g = obj.graph as Record<string, unknown>;
    const nodes = g.nodes;
    const edges = g.edges;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      throw new Error('Invalid snapshot: graph wrapper must contain nodes[] and edges[]');
    }
    return {
      nodes,
      edges,
      createdAt: typeof g.createdAt === 'string' ? g.createdAt : undefined,
      updatedAt: typeof g.updatedAt === 'string' ? g.updatedAt : undefined,
    };
  }

  // Others are direct graphs: { nodes, edges, ... }
  const nodes = obj.nodes;
  const edges = obj.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error('Invalid snapshot: must contain "nodes" and "edges" arrays (or wrapper "graph")');
  }

  return {
    nodes,
    edges,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : undefined,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : undefined,
  };
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  const standaloneIdx = process.argv.indexOf(`--${name}`);
  if (standaloneIdx >= 0) return process.argv[standaloneIdx + 1];
  return undefined;
}

async function main() {
  const inputPath =
    getArg('input') ??
    '/Users/sharajrewoo/Downloads/pathfinder-exploration-hubspotcallai-integration-mindtickle-com-2026-03-23.json';

  const mysqlConfig = {
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: parseInt(process.env.MYSQL_PORT ?? '3306', 10),
    user: process.env.MYSQL_USER ?? 'pathfinder',
    password: process.env.MYSQL_PASSWORD ?? 'pathfinder',
    database: process.env.MYSQL_DATABASE ?? 'pathfinder',
  };

  log.info(`Loading graph snapshot: ${inputPath}`);
  const raw = await fs.readFile(inputPath, 'utf8');
  const payload = JSON.parse(raw) as unknown;
  const graph = extractGraph(payload);

  const createdAt = graph.createdAt ?? new Date().toISOString();
  const updatedAt = graph.updatedAt ?? new Date().toISOString();

  await initDatabase(mysqlConfig);
  await graphRepo.save({
    nodes: graph.nodes as any,
    edges: graph.edges as any,
    createdAt,
    updatedAt,
  });

  log.info(`Imported interaction graph: pages=${graph.nodes.length} edges=${graph.edges.length}`);
  await closeDatabase();
}

main().catch((err) => {
  log.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

