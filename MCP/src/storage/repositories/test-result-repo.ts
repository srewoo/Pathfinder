import { getPool } from '../database.js';
import type { TestResult } from '../schemas.js';

export const testResultRepo = {
  async put(result: TestResult): Promise<void> {
    await getPool().execute(
      `INSERT INTO test_results (id, test_case_id, run_id, data) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [result.id, result.testCaseId, result.runId, JSON.stringify(result)]
    );
  },

  async getByRunId(runId: string): Promise<TestResult[]> {
    const [rows] = await getPool().execute('SELECT data FROM test_results WHERE run_id = ?', [runId]);
    return (rows as any[]).map((r) => typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
  },

  async getByTestCaseId(testCaseId: string): Promise<TestResult[]> {
    const [rows] = await getPool().execute(
      'SELECT data FROM test_results WHERE test_case_id = ? ORDER BY created_at DESC',
      [testCaseId]
    );
    return (rows as any[]).map((r) => typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
  },
};
