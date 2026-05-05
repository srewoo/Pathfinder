import fs from 'node:fs/promises';
import { initDatabase, closeDatabase } from '../storage/database.js';
import { documentRepo } from '../storage/repositories/document-repo.js';
import { vectorRepo } from '../storage/repositories/vector-repo.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('import-knowledge-snapshot');

type KnowledgeSnapshot = {
  version: number;
  exportedAt: string;
  docCount: number;
  vectorCount: number;
  documents: Array<{
    id: string;
    url: string;
    title: string;
    content: string;
    crawledAt: string;
    chunkCount: number;
    contentHash: string;
  }>;
  vectors: Array<{
    id: string;
    content: string;
    url: string;
    embedding: number[] | Record<string, number>;
    metadata: {
      title: string;
      section: string;
      crawledAt: string;
      chunkIndex: number;
      totalChunks: number;
      embeddingModel?: string;
    };
  }>;
};

function normalizeEmbedding(embedding: KnowledgeSnapshot['vectors'][number]['embedding']): number[] {
  if (Array.isArray(embedding)) return embedding;
  // Some exports serialize arrays as `{ "0": <num>, "1": <num>, ... }`.
  const keys = Object.keys(embedding)
    .map((k) => parseInt(k, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  return keys.map((i) => embedding[String(i)]);
}

function toMySqlDateTime(value: string): string {
  // MySQL DATETIME expects `YYYY-MM-DD HH:mm:ss` (no timezone suffix).
  // The snapshot uses ISO-8601 (often ending in `Z`), so normalize it.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    // Best-effort fallback: strip timezone/`T` so MySQL can attempt parsing.
    return value.replace('T', ' ').replace('Z', '').slice(0, 19);
  }
  return d.toISOString().slice(0, 19).replace('T', ' ');
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
    '/Users/sharajrewoo/Downloads/pathfinder-knowledge-help-mindtickle-com.json';
  const clearExisting = (getArg('clear') ?? 'false').toLowerCase() === 'true';
  const vectorBatchSize = Math.max(1, parseInt(getArg('vectorBatchSize') ?? '200', 10));

  if (!inputPath) throw new Error('Missing --input');

  const mysqlConfig = {
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: parseInt(process.env.MYSQL_PORT ?? '3306', 10),
    user: process.env.MYSQL_USER ?? 'pathfinder',
    password: process.env.MYSQL_PASSWORD ?? 'pathfinder',
    database: process.env.MYSQL_DATABASE ?? 'pathfinder',
  };

  log.info(`Loading snapshot from: ${inputPath}`);
  const raw = await fs.readFile(inputPath, 'utf8');
  const snapshot = JSON.parse(raw) as KnowledgeSnapshot;

  if (!Array.isArray(snapshot.documents) || !Array.isArray(snapshot.vectors)) {
    throw new Error('Invalid snapshot: expected "documents" and "vectors" arrays');
  }

  log.info(
    `Snapshot size: documents=${snapshot.documents.length} vectors=${snapshot.vectors.length}`
  );

  await initDatabase(mysqlConfig);

  if (clearExisting) {
    log.warn('Clearing existing knowledge base (documents + vectors)');
    await vectorRepo.clear();
    await documentRepo.clear();
  }

  // Import documents
  let importedDocs = 0;
  for (const doc of snapshot.documents) {
    await documentRepo.put({
      id: doc.id,
      url: doc.url,
      title: doc.title,
      content: doc.content,
      crawledAt: toMySqlDateTime(doc.crawledAt),
      chunkCount: doc.chunkCount,
      contentHash: doc.contentHash,
    });
    importedDocs++;
    if (importedDocs % 100 === 0) log.info(`Imported docs: ${importedDocs}`);
  }

  // Import vectors
  let importedVectors = 0;
  for (let i = 0; i < snapshot.vectors.length; i += vectorBatchSize) {
    const slice = snapshot.vectors.slice(i, i + vectorBatchSize);
    await vectorRepo.putBatch(
      slice.map((v) => ({
        id: v.id,
        url: v.url,
        content: v.content,
        embedding: normalizeEmbedding(v.embedding),
        metadata: v.metadata,
      }))
    );
    importedVectors += slice.length;
    if (importedVectors % 500 === 0) log.info(`Imported vectors: ${importedVectors}`);
  }

  log.info(`Import complete. documents=${importedDocs} vectors=${importedVectors}`);
  await closeDatabase();
}

main().catch((err) => {
  log.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

