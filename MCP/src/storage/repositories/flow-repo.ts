import { getPool } from '../database.js';
import type { Flow } from '../schemas.js';

export const flowRepo = {
  async get(flowId: string): Promise<Flow | undefined> {
    const [rows] = await getPool().execute('SELECT data FROM flows WHERE id = ?', [flowId]);
    const row = (rows as any[])[0];
    if (!row) return undefined;
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  },

  async getAll(): Promise<Flow[]> {
    const [rows] = await getPool().execute('SELECT data FROM flows ORDER BY created_at ASC');
    return (rows as any[]).map((r) => typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
  },

  async put(flow: Flow): Promise<void> {
    await getPool().execute(
      `INSERT INTO flows (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`,
      [flow.flowId, JSON.stringify(flow), flow.createdAt, flow.updatedAt]
    );
  },

  async delete(flowId: string): Promise<void> {
    await getPool().execute('DELETE FROM flows WHERE id = ?', [flowId]);
  },

  async clear(): Promise<void> {
    await getPool().execute('DELETE FROM flows');
  },
};
