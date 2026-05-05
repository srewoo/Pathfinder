import { getPool } from '../database.js';
import type { InteractionGraph } from '../schemas.js';

export const graphRepo = {
  async load(): Promise<InteractionGraph | undefined> {
    const [rows] = await getPool().execute('SELECT data FROM interaction_graph ORDER BY id DESC LIMIT 1');
    const row = (rows as any[])[0];
    if (!row) return undefined;
    return typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  },

  async save(graph: InteractionGraph): Promise<void> {
    const pool = getPool();
    await pool.execute('DELETE FROM interaction_graph');
    await pool.execute('INSERT INTO interaction_graph (data) VALUES (?)', [JSON.stringify(graph)]);
  },
};
