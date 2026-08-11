import { describe, it, expect } from 'vitest';
import {
  createMutationLedger,
  entryFor,
  stripQuery,
} from '../../../src/core/safety/mutation-ledger';
import { createPolicy, decide } from '../../../src/core/safety/origin-policy';

describe('mutation ledger', () => {
  it('given_a_permitted_mutation_then_it_is_recorded_as_permitted', () => {
    const l = createMutationLedger();
    l.record({ url: 'https://app.test/api/orders', method: 'POST', outcome: 'permitted' }, 1000);
    expect(l.permitted()).toHaveLength(1);
    expect(l.refused()).toHaveLength(0);
    expect(l.entries()[0].at).toBe(1000);
  });

  it('given_a_refusal_then_the_rule_and_reason_are_kept', () => {
    const l = createMutationLedger();
    const policy = createPolicy({ allowedOrigins: ['https://app.test'] });
    const decision = decide({ url: 'https://prod.corp/api', method: 'DELETE' }, policy);
    l.record(entryFor({ url: 'https://prod.corp/api', method: 'DELETE' }, decision), 5);

    const [e] = l.refused();
    expect(e.rule).toBe('origin');
    expect(e.reason).toContain('not on the project allowlist');
  });

  it('given_a_status_note_then_it_attaches_to_the_matching_entry', () => {
    const l = createMutationLedger();
    l.record({ url: 'https://app.test/a', method: 'POST', outcome: 'permitted' }, 1);
    l.noteStatus('https://app.test/a', 'POST', 201);
    expect(l.entries()[0].status).toBe(201);
  });

  it('given_two_identical_requests_then_a_status_fills_only_the_first_unfilled_one', () => {
    const l = createMutationLedger();
    l.record({ url: 'https://app.test/a', method: 'POST', outcome: 'permitted' }, 1);
    l.record({ url: 'https://app.test/a', method: 'POST', outcome: 'permitted' }, 2);
    l.noteStatus('https://app.test/a', 'POST', 500);
    l.noteStatus('https://app.test/a', 'POST', 201);
    // Most-recent-first fill: the newest unfilled entry takes the first status.
    const statuses = l.entries().map((e) => e.status);
    expect(statuses).toContain(500);
    expect(statuses).toContain(201);
  });

  it('given_a_summary_then_it_counts_by_rule_and_lists_changed_endpoints', () => {
    const l = createMutationLedger();
    l.record({ url: 'https://app.test/api/x?token=SECRET', method: 'POST', outcome: 'permitted' }, 1);
    l.record({ url: 'https://app.test/api/y', method: 'PUT', outcome: 'permitted' }, 2);
    l.record({ url: 'https://other/api', method: 'GET', outcome: 'refused', rule: 'origin' }, 3);
    l.record({ url: 'https://app.test/api/z', method: 'DELETE', outcome: 'refused', rule: 'method' }, 4);

    const s = l.summary();
    expect(s.mutationsPermitted).toBe(2);
    expect(s.requestsRefused).toBe(2);
    expect(s.refusedByOrigin).toBe(1);
    expect(s.refusedByMethod).toBe(1);
    expect(s.changedEndpoints).toEqual([
      'POST https://app.test/api/x',
      'PUT https://app.test/api/y',
    ]);
  });

  it('given_a_url_with_a_token_in_the_query_then_the_summary_strips_it', () => {
    // Query strings routinely carry tokens and PII, which must never reach a
    // report (CLAUDE.md §12.2).
    const l = createMutationLedger();
    l.record(
      { url: 'https://app.test/reset?token=abc123&email=a@b.co', method: 'POST', outcome: 'permitted' },
      1
    );
    const [endpoint] = l.summary().changedEndpoints;
    expect(endpoint).not.toContain('abc123');
    expect(endpoint).not.toContain('a@b.co');
  });

  it('given_more_entries_than_the_cap_then_it_stays_bounded', () => {
    // An unbounded ledger is a memory leak in a long crawl (CLAUDE.md §11.1).
    const l = createMutationLedger();
    for (let i = 0; i < 5000; i++) {
      l.record({ url: `https://app.test/${i}`, method: 'POST', outcome: 'permitted' }, i);
    }
    expect(l.entries().length).toBeLessThanOrEqual(2000);
    // Recent evidence is what survives.
    expect(l.entries()[l.entries().length - 1].url).toContain('4999');
  });

  it('given_clear_then_it_empties', () => {
    const l = createMutationLedger();
    l.record({ url: 'https://app.test/a', method: 'POST', outcome: 'permitted' }, 1);
    l.clear();
    expect(l.entries()).toHaveLength(0);
  });
});

describe('stripQuery', () => {
  it('given_a_url_with_a_query_then_it_is_removed', () => {
    expect(stripQuery('https://a.test/p?x=1#f')).toBe('https://a.test/p');
  });
  it('given_an_unparseable_url_then_it_falls_back_to_a_split', () => {
    expect(stripQuery('notaurl?x=1')).toBe('notaurl');
  });
});

describe('entryFor', () => {
  it('given_an_allow_decision_then_outcome_is_permitted_with_no_rule', () => {
    const e = entryFor({ url: 'https://a/', method: 'POST' }, { allow: true });
    expect(e.outcome).toBe('permitted');
    expect(e.rule).toBeUndefined();
  });
});
