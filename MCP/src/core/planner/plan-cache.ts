import type { ExecutionPlan } from '../../storage/schemas.js';
import { planCacheRepo } from '../../storage/repositories/plan-cache-repo.js';
import { sha256, generateId } from '../../utils/hash.js';

export async function computePlanHash(testSignature: string, pageUrl: string): Promise<string> {
  const pathname = (() => {
    try { return new URL(pageUrl).pathname || '/'; } catch { return pageUrl || 'no-page'; }
  })();
  return sha256(`${testSignature}::${pathname}`);
}

export async function getCachedPlan(hash: string, testCaseId: string): Promise<ExecutionPlan | undefined> {
  const plan = await planCacheRepo.getByHash(hash);
  if (!plan) return undefined;
  if (plan.testCaseId !== testCaseId) return undefined;
  return plan;
}

export async function cachePlan(
  testCaseId: string,
  hash: string,
  plan: Omit<ExecutionPlan, 'id' | 'testCaseId' | 'testCaseHash' | 'cachedAt'>
): Promise<ExecutionPlan> {
  const fullPlan: ExecutionPlan = {
    id: generateId(),
    testCaseId,
    testCaseHash: hash,
    cachedAt: new Date().toISOString(),
    ...plan,
  };
  await planCacheRepo.put(hash, testCaseId, fullPlan);
  return fullPlan;
}
