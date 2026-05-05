import { getPool } from '../database.js';
import type { ExecutionPlan } from '../schemas.js';

// Unverified plans expire after 7 days. Verified plans (confirmed by a passing test run) never expire.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const planCacheRepo = {
  async getByHash(hash: string): Promise<ExecutionPlan | undefined> {
    const [rows] = await getPool().execute(
      'SELECT plan, cached_at, verified_at FROM plan_cache WHERE hash = ?',
      [hash]
    );
    const row = (rows as any[])[0];
    if (!row) return undefined;

    // Verified plans never expire — they have been confirmed by at least one passing run
    if (!row.verified_at) {
      const age = Date.now() - new Date(row.cached_at).getTime();
      if (age > CACHE_TTL_MS) return undefined;
    }

    const plan: ExecutionPlan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
    if (row.verified_at) plan.verifiedAt = new Date(row.verified_at).toISOString();
    return plan;
  },

  async put(hash: string, testCaseId: string, plan: ExecutionPlan): Promise<void> {
    await getPool().execute(
      // verified_at intentionally excluded from ON DUPLICATE KEY UPDATE —
      // we never want to overwrite a verified plan's verified_at timestamp
      `INSERT INTO plan_cache (hash, test_case_id, plan, cached_at) VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE plan = VALUES(plan), cached_at = NOW()`,
      [hash, testCaseId, JSON.stringify(plan)]
    );
  },

  /**
   * Mark a plan as verified after a successful test run.
   * Verified plans are never evicted by the TTL — they remain
   * valid until the UI changes and the plan explicitly fails.
   */
  async markVerified(hash: string): Promise<void> {
    await getPool().execute(
      'UPDATE plan_cache SET verified_at = NOW() WHERE hash = ? AND verified_at IS NULL',
      [hash]
    );
  },

  /**
   * Clear verified status on a plan (e.g. after it starts failing again).
   * This allows the TTL to apply again and lets fresh planning regenerate it.
   */
  async unverify(hash: string): Promise<void> {
    await getPool().execute(
      'UPDATE plan_cache SET verified_at = NULL WHERE hash = ?',
      [hash]
    );
  },
};
