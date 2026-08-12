/**
 * Turn a breaking schema change into a finding on the test that touched it
 * (ADR 001, phase 3).
 *
 * This is the point of the whole feature. A test asserts on the UI; if an API field it
 * depends on disappears, the UI may still render — an empty column, a missing badge —
 * and every assertion still passes. The test reports green while the contract broke
 * underneath it.
 *
 * Findings go through the same channel the state-diff oracles use, so the existing
 * `verdictWithOracles` downgrade applies with no new machinery: **PASS → NEEDS_REVIEW**,
 * never PASS → FAIL. A schema change is a prompt to look, not an assertion failure, and
 * turning it into a build break would get the signal switched off.
 *
 * Scoped per test on purpose: only endpoints THIS test actually called can implicate
 * it. A global "the API changed" banner would blame every test for one endpoint.
 */
import type { CapturedNetworkEntry, TestResult } from '../../storage/schemas';
import { buildBaseline, diffAgainstBaseline, type ApiBaseline } from './api-baseline';
import type { SchemaChange } from './schema-diff';

export type OracleFinding = NonNullable<TestResult['oracleFindings']>[number];

/**
 * Findings for one test's traffic, compared against the baseline.
 *
 * Returns an empty array when there is no baseline, no captured schema, or nothing
 * broke — the caller can attach unconditionally.
 */
export function schemaFindingsForResult(
  entries: readonly CapturedNetworkEntry[],
  baseline: ApiBaseline | undefined,
  origin: string | undefined
): OracleFinding[] {
  if (!baseline || !origin) return [];
  const withSchema = entries.filter((e) => e.responseSchema);
  if (withSchema.length === 0) return [];

  // Only the endpoints this test exercised are compared. Endpoints in the baseline the
  // test never called are absent from `current`, which the diff reports as "not
  // observed" — correctly, and irrelevant to this test's verdict.
  const current = buildBaseline(withSchema, { origin });
  const diff = diffAgainstBaseline(baseline, current);

  const findings: OracleFinding[] = [];
  for (const endpoint of diff.endpoints) {
    const breaking = endpoint.changes.filter((c) => c.class === 'breaking');
    if (breaking.length === 0) continue;
    findings.push({
      kind: 'api-schema-breaking',
      severity: 'high',
      message:
        `${endpoint.key} no longer returns the shape recorded in the baseline ` +
        `(${breaking.length} breaking change(s)). The test's assertions may still pass ` +
        `while a consumer of this response is broken.`,
      evidence: breaking.map(describeChange).join('; '),
      url: endpoint.key,
    });
  }
  return findings;
}

const describeChange = (c: SchemaChange): string => `${c.path}: ${c.detail}`;

/** Attach schema findings to a result, preserving any findings already there. */
export function withSchemaFindings(result: TestResult, findings: readonly OracleFinding[]): TestResult {
  if (findings.length === 0) return result;
  return { ...result, oracleFindings: [...(result.oracleFindings ?? []), ...findings] };
}

/** The origin most of a test's traffic belongs to. */
export function dominantOrigin(entries: readonly { url: string }[]): string | undefined {
  const counts = new Map<string, number>();
  for (const e of entries) {
    try {
      const origin = new URL(e.url).origin;
      counts.set(origin, (counts.get(origin) ?? 0) + 1);
    } catch { /* unparseable */ }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
