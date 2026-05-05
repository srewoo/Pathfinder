/**
 * Knowledge base export / import utilities.
 *
 * Export format (JSON):
 * {
 *   version: "1",
 *   exportedAt: ISO-8601 string,
 *   docCount: number,
 *   vectorCount: number,
 *   documents: CrawledDocument[],
 *   vectors: VectorRecord[],
 * }
 *
 * Files are named:  pathfinder-knowledge-{hostname}-{YYYY-MM-DD}.json
 * Typical size:     ~10–50 MB depending on corpus size and embedding dimensions.
 */

import type { CrawledDocument, VectorRecord } from './schemas';
import { documentDB, vectorDB } from './indexed-db';

export const EXPORT_VERSION = '1' as const;

export interface KnowledgeExport {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  docCount: number;
  vectorCount: number;
  documents: CrawledDocument[];
  vectors: VectorRecord[];
}

export interface ImportResult {
  docCount: number;
  vectorCount: number;
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Serialises all documents + vectors from IndexedDB and triggers a browser
 * download of the resulting JSON file. Returns the export metadata.
 */
export async function exportKnowledge(baseUrl?: string): Promise<ImportResult> {
  const [documents, vectors] = await Promise.all([
    documentDB.getAll(),
    vectorDB.getAll(),
  ]);

  const payload: KnowledgeExport = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    docCount: documents.length,
    vectorCount: vectors.length,
    documents,
    vectors,
  };

  const json = JSON.stringify(payload);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const hostname = safeHostname(baseUrl ?? documents[0]?.url ?? 'knowledge');
  const date = new Date().toISOString().slice(0, 10);
  const filename = `pathfinder-knowledge-${hostname}-${date}.json`;

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  // Release the object URL after a short delay so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  return { docCount: documents.length, vectorCount: vectors.length };
}

// ── Import ────────────────────────────────────────────────────────────────────

/**
 * Reads a File object, validates the export envelope, then writes all
 * documents and vectors into IndexedDB (replacing existing data).
 */
export async function importKnowledge(file: File): Promise<ImportResult> {
  const text = await file.text();
  const parsed = JSON.parse(text) as unknown;

  assertValidExport(parsed);

  const { documents, vectors } = parsed;

  // Clear existing knowledge before writing imported data.
  await Promise.all([vectorDB.clear(), documentDB.clear()]);

  // Write in parallel for speed — each putBatch opens its own transaction.
  await Promise.all([
    documentDB.putBatch(documents),
    vectorDB.putBatch(vectors),
  ]);

  return { docCount: documents.length, vectorCount: vectors.length };
}

// ── Validation ────────────────────────────────────────────────────────────────

function assertValidExport(value: unknown): asserts value is KnowledgeExport {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid file: not a JSON object');
  }

  const obj = value as Record<string, unknown>;

  if (obj['version'] !== EXPORT_VERSION) {
    throw new Error(`Unsupported export version: ${obj['version']}. Expected "${EXPORT_VERSION}".`);
  }
  if (!Array.isArray(obj['documents'])) {
    throw new Error('Invalid file: missing documents array');
  }
  if (!Array.isArray(obj['vectors'])) {
    throw new Error('Invalid file: missing vectors array');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/\./g, '-');
  } catch {
    return url.slice(0, 30).replace(/[^a-z0-9-]/gi, '-');
  }
}

/** Estimate the file size string from document + vector counts. */
export function estimateExportSize(docCount: number, vectorCount: number): string {
  // Rough: each vector ~384 dims × ~10 chars = 3.8 KB; each doc ~2 KB text
  const estBytes = vectorCount * 384 * 10 + docCount * 2000;
  if (estBytes < 1_000_000) return `~${Math.round(estBytes / 1000)} KB`;
  return `~${(estBytes / 1_000_000).toFixed(1)} MB`;
}
