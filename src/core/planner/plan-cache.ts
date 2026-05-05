import type { ExecutionPlan } from '../../storage/schemas';
import { planDB } from '../../storage/indexed-db';
import { sha256, generateId } from '../../utils/hash';

const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Compute a cache key that incorporates the test content, page URL, and an
 * optional DOM element count. Including the element count ensures the cache
 * is automatically invalidated when the page structure changes significantly
 * (e.g., new form fields added, sections removed) without relying solely on TTL.
 */
export async function computePlanHash(testSignature: string, pageUrl: string, elementCount?: number): Promise<string> {
  // Bucket element count into ranges of 10 to avoid cache churn from minor DOM changes
  const bucketedCount = elementCount != null ? Math.floor(elementCount / 10) * 10 : 0;
  return sha256(`${testSignature}::${getPathnameForHash(pageUrl)}::${bucketedCount}`);
}

export async function getCachedPlan(hash: string, testCaseId: string): Promise<ExecutionPlan | undefined> {
  const plan = await planDB.getByHash(hash);
  if (!plan) return undefined;

  // Defense-in-depth: ensure the cached plan belongs to this specific test case.
  // Two test cases with identical content would share a hash without this guard.
  if (plan.testCaseId !== testCaseId) return undefined;

  const age = Date.now() - new Date(plan.cachedAt).getTime();
  if (age > CACHE_TTL_MS) return undefined;

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

  await planDB.put(fullPlan);
  return fullPlan;
}

function getPathnameForHash(pageUrl: string): string {
  if (!pageUrl) return 'no-page';

  try {
    return new URL(pageUrl).pathname || '/';
  } catch {
    return pageUrl;
  }
}
