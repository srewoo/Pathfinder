import { getPool } from '../storage/database.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('memory');

export type MemoryCategory = 'selector_heal' | 'step_pattern' | 'tenant_quirk' | 'timing_profile' | 'test_outcome';

export interface MemoryEntry {
  key: string;
  value: unknown;
  category: MemoryCategory;
  updatedAt: string;
}

export const memoryStore = {
  async get(key: string): Promise<MemoryEntry | undefined> {
    const [rows] = await getPool().execute('SELECT `key`, value, category, updated_at FROM memory WHERE `key` = ?', [key]);
    const row = (rows as any[])[0];
    if (!row) return undefined;
    return { key: row.key, value: typeof row.value === 'string' ? JSON.parse(row.value) : row.value, category: row.category, updatedAt: row.updated_at };
  },

  async set(key: string, value: unknown, category: MemoryCategory): Promise<void> {
    await getPool().execute(
      'INSERT INTO memory (`key`, value, category) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), category = VALUES(category)',
      [key, JSON.stringify(value), category]
    );
  },

  async getByCategory(category: MemoryCategory): Promise<MemoryEntry[]> {
    const [rows] = await getPool().execute('SELECT `key`, value, category, updated_at FROM memory WHERE category = ?', [category]);
    return (rows as any[]).map((r) => ({ key: r.key, value: typeof r.value === 'string' ? JSON.parse(r.value) : r.value, category: r.category, updatedAt: r.updated_at }));
  },

  async delete(key: string): Promise<void> {
    await getPool().execute('DELETE FROM memory WHERE `key` = ?', [key]);
  },

  async search(query: string): Promise<MemoryEntry[]> {
    const [rows] = await getPool().execute(
      'SELECT `key`, value, category, updated_at FROM memory WHERE `key` LIKE ? OR JSON_EXTRACT(value, "$") LIKE ?',
      [`%${query}%`, `%${query}%`]
    );
    return (rows as any[]).map((r) => ({ key: r.key, value: typeof r.value === 'string' ? JSON.parse(r.value) : r.value, category: r.category, updatedAt: r.updated_at }));
  },
};
