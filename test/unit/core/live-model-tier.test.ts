/**
 * T10 item 5: the live-model tier must report its absence, not hide it.
 *
 * The failure this guards against is the quiet one — a run without credentials
 * falling through to another tier and reporting those numbers as model quality.
 * Every required field is required because a model measurement missing it
 * cannot be compared to another one, and a number that cannot be compared is
 * worse than no number.
 */
import { describe, it, expect } from 'vitest';
import {
  planLiveModelRun,
  formatLiveModel,
  LIVE_MODEL_SETUP,
  type LiveModelSkipped,
} from '../../evaluation/live-model-tier';
import { FIXTURE_VERSION } from '../../evaluation/harness';

const COMPLETE = {
  apiKey: 'test-key-not-a-real-credential',
  model: 'claude-sonnet-5',
  temperature: 0,
  promptVersions: { testGeneration: '3', oracle: '2' },
  sampleSize: 5,
};

describe('missing prerequisites are reported as skipped', () => {
  it.each([
    ['no api key', { ...COMPLETE, apiKey: undefined }, /api key/i],
    ['no model', { ...COMPLETE, model: undefined }, /name its model/i],
    ['no temperature', { ...COMPLETE, temperature: undefined }, /temperature/i],
    ['no prompt versions', { ...COMPLETE, promptVersions: {} }, /prompt versions/i],
    ['no sample size', { ...COMPLETE, sampleSize: 0 }, /sample size/i],
  ])('given_%s_then_the_tier_is_skipped_with_a_reason', (_name, creds, pattern) => {
    const result = planLiveModelRun(creds);

    expect(result.skipped).toBe(true);
    expect((result as LiveModelSkipped).reason).toMatch(pattern);
  });

  // A dead end is not an honest report. The acceptance criteria ask for
  // reproducible setup instructions alongside the skip.
  it('given_a_skip_then_it_carries_reproducible_setup_instructions', () => {
    const result = planLiveModelRun({}) as LiveModelSkipped;

    expect(result.setup).toBe(LIVE_MODEL_SETUP);
    expect(result.setup).toMatch(/re-run/i);
  });

  it('given_a_skip_then_its_rendering_refuses_to_claim_anything', () => {
    const rendered = formatLiveModel(planLiveModelRun({}));

    expect(rendered).toMatch(/SKIPPED/);
    expect(rendered).toMatch(/no claim about model quality/i);
  });
});

describe('a runnable configuration records everything needed to compare it', () => {
  it('given_complete_credentials_then_the_run_is_not_skipped', () => {
    expect(planLiveModelRun(COMPLETE).skipped).toBe(false);
  });

  it('given_complete_credentials_then_the_provenance_names_model_settings_and_sample', () => {
    const result = planLiveModelRun(COMPLETE);

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.provenance).toMatchObject({
      model: 'claude-sonnet-5',
      settings: { temperature: 0 },
      promptVersions: { testGeneration: '3', oracle: '2' },
      fixtureVersion: FIXTURE_VERSION,
      sampleSize: 5,
    });
  });

  // The key is a credential. It must never travel into a report.
  it('given_a_report_then_the_api_key_appears_nowhere_in_it', () => {
    const rendered = formatLiveModel(planLiveModelRun(COMPLETE));

    expect(rendered).not.toContain(COMPLETE.apiKey);
  });

  it('given_a_report_then_it_carries_the_tier_caveat', () => {
    const rendered = formatLiveModel(planLiveModelRun(COMPLETE));

    expect(rendered).toMatch(/vary run to run/i);
  });

  it('given_a_report_then_the_prompt_versions_are_legible_in_it', () => {
    const rendered = formatLiveModel(planLiveModelRun(COMPLETE));

    expect(rendered).toContain('testGeneration@3');
  });
});
