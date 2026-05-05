import { readFile } from 'fs/promises';
import { documentRepo } from '../../storage/repositories/document-repo.js';
import { vectorRepo } from '../../storage/repositories/vector-repo.js';
import { createLogger } from '../../utils/logger.js';
import { withErrorHandling } from './_error-wrapper.js';

const log = createLogger('knowledge-io');

export async function handleExportKnowledge(args: { file_path?: string } = {}) {
  return withErrorHandling(async () => {
    const vectors = await vectorRepo.getAll();
    if (vectors.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text: 'No knowledge base found. Run `crawl_knowledge` first.',
        }],
      };
    }

    // Group by URL for a readable summary
    const byUrl = new Map<string, number>();
    for (const v of vectors) {
      byUrl.set(v.url, (byUrl.get(v.url) ?? 0) + 1);
    }

    const exportData = {
      exportedAt: new Date().toISOString(),
      totalVectors: vectors.length,
      documents: [...byUrl.entries()].map(([url, chunks]) => ({ url, chunks })),
      vectors: vectors.map((v) => ({
        id: v.id,
        url: v.url,
        content: v.content,
        embedding: v.embedding,
        metadata: v.metadata,
      })),
    };

    const json = JSON.stringify(exportData, null, 2);
    log.info(`Exported knowledge: ${vectors.length} vectors across ${byUrl.size} documents`);

    if (args.file_path) {
      const { writeFile } = await import('fs/promises');
      await writeFile(args.file_path, json, 'utf-8');
      return {
        content: [{
          type: 'text' as const,
          text: [
            `Knowledge base saved to ${args.file_path}`,
            `  Vectors: ${vectors.length}`,
            `  Documents: ${byUrl.size}`,
            '',
            'Documents:',
            ...[...byUrl.entries()].map(([url, chunks]) => `  - ${url} (${chunks} chunks)`),
          ].join('\n'),
        }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: [
          `Exported knowledge base: ${vectors.length} vectors across ${byUrl.size} documents.`,
          '',
          'Documents:',
          ...[...byUrl.entries()].map(([url, chunks]) => `  - ${url} (${chunks} chunks)`),
          '',
          'JSON snapshot (use with `import_knowledge`, or use file_path to save directly):',
          '',
          json,
        ].join('\n'),
      }],
    };
  }, 'export_knowledge');
}

export async function handleImportKnowledge(args: { knowledge_json?: string; file_path?: string }) {
  return withErrorHandling(async () => {
    let raw: string;
    if (args.file_path) {
      raw = await readFile(args.file_path, 'utf-8');
    } else if (args.knowledge_json) {
      raw = args.knowledge_json;
    } else {
      return {
        content: [{ type: 'text' as const, text: 'Provide either file_path (path to JSON file) or knowledge_json (inline JSON string).' }],
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
          text: `Failed to parse knowledge JSON: ${err instanceof Error ? err.message : String(err)}`,
        }],
        isError: true,
      };
    }

    const obj = parsed as Record<string, unknown>;
    const vectors = obj['vectors'];
    if (!Array.isArray(vectors)) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Invalid knowledge JSON: must have a "vectors" array. Use `export_knowledge` to get the expected format.',
        }],
        isError: true,
      };
    }

    // Clear existing knowledge first
    await vectorRepo.clear();

    // Import vectors
    const records = vectors.map((v: any) => ({
      id: v.id ?? `imported_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      url: v.url ?? '',
      content: v.content ?? '',
      embedding: Array.isArray(v.embedding) ? v.embedding : [],
      metadata: v.metadata ?? { title: '', section: '', crawledAt: new Date().toISOString(), chunkIndex: 0, totalChunks: 1 },
    }));

    await vectorRepo.putBatch(records);
    log.info(`Imported ${records.length} vectors`);

    const urls = new Set(records.map((r: any) => r.url));
    return {
      content: [{
        type: 'text' as const,
        text: [
          `Knowledge base imported: ${records.length} vectors across ${urls.size} documents.`,
          '',
          'You can now use this knowledge for test planning and expansion.',
        ].join('\n'),
      }],
    };
  }, 'import_knowledge');
}
