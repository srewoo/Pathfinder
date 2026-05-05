import { getPool } from '../database.js';
import type { CrawledDocument } from '../schemas.js';

export const documentRepo = {
  async getByUrl(url: string): Promise<CrawledDocument | undefined> {
    const [rows] = await getPool().execute(
      'SELECT content, title, content_hash, crawled_at FROM documents WHERE url = ?',
      [url]
    );
    const row = (rows as any[])[0];
    if (!row) return undefined;
    return {
      id: url,
      url,
      title: row.title,
      content: row.content,
      crawledAt: row.crawled_at,
      chunkCount: 0,
      contentHash: row.content_hash,
    };
  },

  async put(doc: CrawledDocument): Promise<void> {
    await getPool().execute(
      `INSERT INTO documents (url, content, title, content_hash, crawled_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), title = VALUES(title),
       content_hash = VALUES(content_hash), crawled_at = VALUES(crawled_at)`,
      [doc.url, doc.content, doc.title, doc.contentHash, doc.crawledAt]
    );
  },

  async deleteByUrl(url: string): Promise<void> {
    await getPool().execute('DELETE FROM documents WHERE url = ?', [url]);
  },

  async clear(): Promise<void> {
    await getPool().execute('DELETE FROM documents');
  },
};
