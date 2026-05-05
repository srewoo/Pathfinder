import { getPool } from '../database.js';
import type { VectorRecord } from '../schemas.js';

function encodeEmbedding(embedding: number[]): Buffer {
  const floats = new Float32Array(embedding);
  return Buffer.from(floats.buffer);
}

function decodeEmbedding(buf: Buffer): number[] {
  // MySQL drivers can return Buffer *slices* whose `byteOffset` isn't 4-byte aligned.
  // Float32Array requires the starting offset to be aligned, so we clone into a new Buffer.
  const aligned = Buffer.from(buf);
  const floats = new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
  return Array.from(floats);
}

export const vectorRepo = {
  async getAll(): Promise<VectorRecord[]> {
    const [rows] = await getPool().execute('SELECT id, url, chunk_index, text, embedding, metadata FROM vectors');
    return (rows as any[]).map((row) => ({
      id: String(row.id),
      url: row.url,
      content: row.text,
      embedding: decodeEmbedding(row.embedding),
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
    }));
  },

  async putBatch(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    const pool = getPool();
    for (const r of records) {
      await pool.execute(
        'INSERT INTO vectors (url, chunk_index, text, embedding, metadata) VALUES (?, ?, ?, ?, ?)',
        [r.url, r.metadata.chunkIndex, r.content, encodeEmbedding(r.embedding), JSON.stringify(r.metadata)]
      );
    }
  },

  async deleteByUrl(url: string): Promise<void> {
    await getPool().execute('DELETE FROM vectors WHERE url = ?', [url]);
  },

  async clear(): Promise<void> {
    await getPool().execute('DELETE FROM vectors');
  },
};
