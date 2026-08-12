/**
 * State-diff oracles — written false-positive-first.
 *
 * Every oracle here can accuse a correct app if its guards are wrong, so the
 * suppression cases get as much attention as the detections. Roughly half these
 * tests assert that an oracle stays SILENT.
 */
import { describe, it, expect } from 'vitest';
import {
  claimsError,
  claimsSuccess,
  detectMissingPersistence,
  detectSuccessOverFailure,
  detectSuccessWithoutWrite,
  detectSurfacedError,
  detectUnexpectedWrite,
  runStateOracles,
} from '../../../src/core/analysis/state-oracles';
import type { StateDiff } from '../../../src/core/analysis/state-diff';
import type { NetworkResponse } from '../../../src/core/driver';

const res = (method: string, status: number, url = 'https://app.test/api/x'): NetworkResponse => ({
  requestId: `${method}-${status}`,
  url,
  method,
  status,
});

function diff(over: Partial<StateDiff> = {}): StateDiff {
  return {
    navigated: false,
    urlBefore: 'https://app.test/',
    urlAfter: 'https://app.test/',
    titleChanged: false,
    elementDelta: 0,
    tagDeltas: {},
    newMessages: [],
    fieldChanges: [],
    textChanged: false,
    storageChanges: [],
    requests: [],
    mutatingRequests: [],
    failedRequests: [],
    inert: false,
    ...over,
  };
}

const ctx = { action: 'Save' };

describe('claimsSuccess / claimsError', () => {
  it('given_common_success_wording_then_it_is_recognised', () => {
    for (const m of ['Saved', 'Order created', 'Successfully updated', 'Item deleted']) {
      expect(claimsSuccess([m]), m).toBe(true);
    }
  });

  it('given_neutral_wording_then_it_is_not_a_success_claim', () => {
    // "Details panel opened" must not read as a persistence claim.
    for (const m of ['Details panel opened', 'Loading…', '3 results']) {
      expect(claimsSuccess([m]), m).toBe(false);
    }
  });

  it('given_error_wording_then_it_is_recognised', () => {
    for (const m of [
      'Could not save — please try again',
      "Couldn't save your changes",
      'Save failed',
      'Invalid card number',
      'Access denied',
      'Something went wrong',
      'Your order was not created',
    ]) {
      expect(claimsError([m]), m).toBe(true);
    }
  });

  it('given_ordinary_copy_containing_generic_words_then_it_is_NOT_an_error', () => {
    // This predicate also SUPPRESSES success-over-failure, so over-matching would
    // hide real contradictions.
    for (const m of ['Something wrong? Contact support', 'Report a problem']) {
      expect(claimsError([m]), m).toBe(false);
    }
  });
});

describe('detectSuccessWithoutWrite — the headline oracle', () => {
  it('given_success_with_no_persistence_anywhere_then_it_fires', () => {
    const f = detectSuccessWithoutWrite(diff({ newMessages: ['Saved successfully'] }), ctx);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('success-without-persistence');
    expect(f[0].severity).toBe('high');
    expect(f[0].evidence).toMatch(/zero network requests/);
  });

  it('given_a_server_request_then_it_stays_silent', () => {
    // Evidence of contact. An app that saves over WebSocket or batches writes must
    // not be accused.
    expect(
      detectSuccessWithoutWrite(
        diff({ newMessages: ['Saved'], requests: [res('GET', 200)] }),
        ctx
      )
    ).toEqual([]);
  });

  it('given_a_storage_write_then_it_stays_silent', () => {
    // A local-first app legitimately persists client-side.
    expect(
      detectSuccessWithoutWrite(
        diff({
          newMessages: ['Draft saved successfully'],
          storageChanges: [{ scope: 'local', key: 'draft', change: 'added', after: 'x' }],
        }),
        ctx
      )
    ).toEqual([]);
  });

  it('given_a_navigation_then_it_stays_silent', () => {
    // Navigating is itself evidence the action was processed somewhere.
    expect(
      detectSuccessWithoutWrite(
        diff({ newMessages: ['Saved'], navigated: true, urlAfter: 'https://app.test/done' }),
        ctx
      )
    ).toEqual([]);
  });

  it('given_no_success_claim_then_it_stays_silent', () => {
    expect(
      detectSuccessWithoutWrite(diff({ newMessages: ['Details panel opened'] }), ctx)
    ).toEqual([]);
  });

  it('given_a_PRE_EXISTING_banner_then_it_stays_silent', () => {
    // `newMessages` only contains messages that APPEARED. A stale banner saying
    // nothing about this action must not become evidence about it.
    expect(detectSuccessWithoutWrite(diff({ newMessages: [] }), ctx)).toEqual([]);
  });
});

describe('detectSuccessOverFailure', () => {
  it('given_success_shown_over_a_500_then_it_fires_with_both_sides_quoted', () => {
    const f = detectSuccessOverFailure(
      diff({
        newMessages: ['Saved successfully'],
        requests: [res('POST', 500)],
        failedRequests: [res('POST', 500)],
      }),
      ctx
    );
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toMatch(/Saved successfully/);
    expect(f[0].evidence).toMatch(/500/);
  });

  it('given_the_app_also_reports_the_error_then_it_stays_silent', () => {
    // Correct behaviour: the failure was surfaced. Not a contradiction.
    expect(
      detectSuccessOverFailure(
        diff({
          newMessages: ['Saved', 'Error: could not persist'],
          failedRequests: [res('POST', 500)],
        }),
        ctx
      )
    ).toEqual([]);
  });

  it('given_a_failure_with_no_success_claim_then_it_stays_silent', () => {
    expect(
      detectSuccessOverFailure(diff({ failedRequests: [res('POST', 500)] }), ctx)
    ).toEqual([]);
  });

  it('given_several_failures_then_it_reports_the_worst_status', () => {
    const f = detectSuccessOverFailure(
      diff({
        newMessages: ['Saved'],
        failedRequests: [res('POST', 404), res('POST', 503)],
      }),
      ctx
    );
    expect(f[0].message).toMatch(/503/);
  });
});

describe('detectUnexpectedWrite', () => {
  it('given_a_read_only_run_that_writes_then_it_fires_per_request', () => {
    const f = detectUnexpectedWrite(
      diff({ mutatingRequests: [res('POST', 200), res('DELETE', 204)] }),
      { action: 'Explore', readOnly: true }
    );
    expect(f).toHaveLength(2);
    expect(f[0].kind).toBe('unexpected-mutation');
  });

  it('given_a_run_that_is_not_read_only_then_it_stays_silent', () => {
    expect(
      detectUnexpectedWrite(diff({ mutatingRequests: [res('POST', 200)] }), {
        action: 'Save',
        readOnly: false,
      })
    ).toEqual([]);
  });
});

describe('detectMissingPersistence', () => {
  it('given_a_declared_write_intent_with_no_write_then_it_fires', () => {
    const f = detectMissingPersistence(diff(), { action: 'Save', expectedToWrite: true });
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('missing-persistence');
  });

  it('given_no_declared_intent_then_it_stays_silent', () => {
    // Without an explicit declaration this would fire on every navigation click.
    expect(detectMissingPersistence(diff(), { action: 'Open menu' })).toEqual([]);
  });

  it('given_a_storage_write_then_the_intent_is_satisfied', () => {
    expect(
      detectMissingPersistence(
        diff({ storageChanges: [{ scope: 'session', key: 'k', change: 'added', after: 'v' }] }),
        { action: 'Save', expectedToWrite: true }
      )
    ).toEqual([]);
  });
});

describe('detectSurfacedError', () => {
  it('given_an_error_message_then_it_is_reported', () => {
    const f = detectSurfacedError(diff({ newMessages: ['Invalid card number'] }), ctx);
    expect(f).toHaveLength(1);
    expect(f[0].evidence).toMatch(/Invalid card number/);
  });

  it('given_only_success_messages_then_it_stays_silent', () => {
    expect(detectSurfacedError(diff({ newMessages: ['Saved'] }), ctx)).toEqual([]);
  });
});

describe('runStateOracles', () => {
  it('given_a_clean_successful_save_then_nothing_is_reported', () => {
    // The most important test in the file: a correct app must produce silence.
    expect(
      runStateOracles(
        diff({
          newMessages: ['Order created successfully'],
          requests: [res('POST', 201)],
          mutatingRequests: [res('POST', 201)],
        }),
        { action: 'Create order', expectedToWrite: true }
      )
    ).toEqual([]);
  });

  it('given_a_contradiction_then_the_highest_severity_finding_reads_first', () => {
    const f = runStateOracles(
      diff({
        newMessages: ['Saved successfully'],
        requests: [res('POST', 500)],
        failedRequests: [res('POST', 500)],
      }),
      { action: 'Save' }
    );
    expect(f[0].kind).toBe('success-over-failure');
    expect(f[0].severity).toBe('high');
  });

  it('given_every_finding_then_it_carries_evidence', () => {
    const f = runStateOracles(diff({ newMessages: ['Saved successfully'] }), { action: 'Save' });
    for (const finding of f) expect(finding.evidence.length).toBeGreaterThan(20);
  });
});
