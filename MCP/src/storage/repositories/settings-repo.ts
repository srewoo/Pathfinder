import { getPool } from '../database.js';

export const settingsRepo = {
  async get(key: string): Promise<unknown | undefined> {
    const [rows] = await getPool().execute('SELECT value FROM settings WHERE `key` = ?', [key]);
    const row = (rows as any[])[0];
    if (!row) return undefined;
    return typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  },

  async set(key: string, value: unknown): Promise<void> {
    await getPool().execute(
      'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [key, JSON.stringify(value)]
    );
  },

  async delete(key: string): Promise<void> {
    await getPool().execute('DELETE FROM settings WHERE `key` = ?', [key]);
  },
};
