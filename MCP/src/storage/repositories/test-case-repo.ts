import { getPool } from '../database.js';
import type { TestCase } from '../schemas.js';

export const testCaseRepo = {
  async get(id: string): Promise<TestCase | undefined> {
    const [rows] = await getPool().execute('SELECT data FROM test_cases WHERE id = ?', [id]);
    const row = (rows as any[])[0];
    if (!row) return undefined;
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  },

  async getAll(): Promise<TestCase[]> {
    const [rows] = await getPool().execute('SELECT data FROM test_cases ORDER BY created_at ASC');
    return (rows as any[]).map((r) => typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
  },

  async put(tc: TestCase): Promise<void> {
    const createdAt = (() => {
      // MySQL DATETIME rejects ISO strings that include timezone suffix (e.g. trailing `Z`).
      // Normalize to `YYYY-MM-DD HH:mm:ss`.
      if (typeof tc.createdAt !== 'string') return new Date().toISOString().slice(0, 19).replace('T', ' ');
      const d = new Date(tc.createdAt);
      if (Number.isNaN(d.getTime())) return tc.createdAt.replace('T', ' ').replace('Z', '').slice(0, 19);
      return d.toISOString().slice(0, 19).replace('T', ' ');
    })();

    await getPool().execute(
      `INSERT INTO test_cases (id, data, created_at) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [tc.id, JSON.stringify(tc), createdAt]
    );
  },

  async clear(): Promise<void> {
    await getPool().execute('DELETE FROM test_cases');
  },
};
