/**
 * The live-model tier: a real model generating the tests the harness then runs.
 *
 * The deterministic and real-browser tiers answer "does the engine detect a
 * seeded defect". Neither says anything about the model — they run scenarios
 * whose steps are fixed. Only this tier can support a claim about generation
 * quality, and it is the tier that is hardest to report honestly, for two
 * reasons that shape everything below.
 *
 * **It needs credentials, which this repository does not carry.** Absence of
 * credentials must therefore produce a SKIPPED result, never a pass and never
 * silence. A run that quietly falls back to the deterministic tier and reports
 * those numbers as model quality is the specific failure this design exists to
 * make impossible.
 *
 * **Its results are not reproducible on their own.** A number from a model is
 * meaningless without the model id, the temperature and any other setting that
 * moves the output, the prompt versions, the fixture version, and how many
 * samples it is an average of. Those are required fields here rather than
 * optional metadata, so a report that cannot name them cannot be produced at
 * all.
 */
import { FIXTURE_VERSION, TIER_CAVEATS } from './harness';

export interface LiveModelProvenance {
  /** Exact model identifier, e.g. `claude-sonnet-5`. Never a family name. */
  model: string;
  /** Settings that move the output. Temperature at minimum. */
  settings: { temperature: number; maxTokens?: number; [key: string]: unknown };
  /**
   * Prompt version identifiers, from `src/core/ai/prompt-versions.ts`.
   *
   * A model measurement taken against different prompts is a different
   * measurement, and prompts change far more often than models do.
   */
  promptVersions: Record<string, string>;
  fixtureVersion: string;
  /** Generations per scenario. A single sample is an anecdote, not a rate. */
  sampleSize: number;
}

export interface LiveModelSkipped {
  tier: 'live-model';
  skipped: true;
  /** What was missing, specifically enough to act on. */
  reason: string;
  /** What a reader would need to supply to run it. */
  setup: string;
}

export interface LiveModelReport {
  tier: 'live-model';
  skipped: false;
  caveat: string;
  provenance: LiveModelProvenance;
  generatedAt: string;
}

export interface LiveModelCredentials {
  apiKey?: string;
  model?: string;
  temperature?: number;
  promptVersions?: Record<string, string>;
  sampleSize?: number;
}

/**
 * Reproducible setup instructions, quoted verbatim in a skipped report.
 *
 * A skipped tier that does not say how to un-skip it is a dead end, and the
 * acceptance criteria for this work ask for exactly this.
 */
export const LIVE_MODEL_SETUP =
  'Set PATHFINDER_EVAL_API_KEY and PATHFINDER_EVAL_MODEL in the environment, then ' +
  're-run `npm run evaluate:model`. The key is used only against the configured ' +
  'provider; fixtures stay on 127.0.0.1 and no application data leaves the machine.';

/**
 * Decide whether the live-model tier can run, and describe the outcome either way.
 *
 * Deliberately a pure decision rather than a runner: the point of contention is
 * not how to call a model, it is that the absence of a model must be reported
 * as absence. Keeping that decision separate means it can be tested without a
 * network, which is the only way a test of "reports unavailable credentials as
 * skipped" is worth anything.
 */
export function planLiveModelRun(
  credentials: LiveModelCredentials
): LiveModelReport | LiveModelSkipped {
  const skipped = (reason: string): LiveModelSkipped => ({
    tier: 'live-model',
    skipped: true,
    reason,
    setup: LIVE_MODEL_SETUP,
  });

  if (!credentials.apiKey) return skipped('no API key configured for evaluation');
  if (!credentials.model) {
    return skipped('no model identified — a result that cannot name its model is not comparable');
  }
  if (credentials.temperature === undefined) {
    return skipped('no temperature recorded — the same prompt at a different temperature is a different measurement');
  }
  const promptVersions = credentials.promptVersions;
  if (!promptVersions || Object.keys(promptVersions).length === 0) {
    return skipped('no prompt versions recorded — prompts change more often than models do');
  }
  const sampleSize = credentials.sampleSize ?? 0;
  if (sampleSize < 1) {
    return skipped('sample size not set — a single sample is an anecdote, not a rate');
  }

  return {
    tier: 'live-model',
    skipped: false,
    caveat: TIER_CAVEATS['live-model'],
    generatedAt: new Date().toISOString(),
    provenance: {
      model: credentials.model,
      settings: { temperature: credentials.temperature },
      promptVersions,
      fixtureVersion: FIXTURE_VERSION,
      sampleSize,
    },
  };
}

/** Render either outcome so the two can never be confused for one another. */
export function formatLiveModel(result: LiveModelReport | LiveModelSkipped): string {
  if (result.skipped) {
    return [
      '# Pathfinder evaluation — live-model',
      '',
      `**SKIPPED:** ${result.reason}.`,
      '',
      'No claim about model quality can be made from this run.',
      '',
      `To run it: ${result.setup}`,
    ].join('\n');
  }

  const p = result.provenance;
  return [
    '# Pathfinder evaluation — live-model',
    '',
    `Model ${p.model} · temperature ${p.settings.temperature} · ${p.sampleSize} sample(s) per scenario`,
    `Prompts ${Object.entries(p.promptVersions).map(([k, v]) => `${k}@${v}`).join(', ')}`,
    `Fixtures ${p.fixtureVersion} · ${result.generatedAt}`,
    '',
    `**Tier caveat:** ${result.caveat}`,
  ].join('\n');
}
