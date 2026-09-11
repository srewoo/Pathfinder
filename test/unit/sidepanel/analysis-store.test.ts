/**
 * T05 regression: analysis reports must survive the panel and know what they
 * describe.
 *
 * They lived in `AnalysisPanel`'s own `useState`, with the completion listener
 * registered in its `useEffect`. `App.tsx` swaps mounted panels, so switching
 * tabs mid-analysis destroyed the state *and* unregistered the listener — the
 * result arrived with nobody to receive it, and returning showed an empty panel.
 *
 * Reports also arrived with no identity at all, so a slow result for one app
 * could be shown as the current result for another.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/storage/chrome-storage', () => ({
  analysisReportStorage: {
    get: vi.fn().mockResolvedValue({}),
    save: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
  },
}));

const { useAnalysisStore, reportKey } = await import('../../../src/sidepanel/stores/analysis-store');
const { analysisReportStorage } = await import('../../../src/storage/chrome-storage');

const APP_A = { origin: 'https://a.test', runId: 'run-a' };
const APP_B = { origin: 'https://b.test', runId: 'run-b' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(analysisReportStorage.get).mockResolvedValue({});
  // clearAllMocks clears calls, not implementations — without this the
  // deliberate quota rejection leaks into every later test.
  vi.mocked(analysisReportStorage.save).mockResolvedValue(undefined);
  useAnalysisStore.setState({
    reports: {},
    jobs: {
      coverage: { status: 'idle' },
      a11y: { status: 'idle' },
      contracts: { status: 'idle' },
      cost: { status: 'idle' },
    },
    loaded: false,
  });
});

describe('reportKey', () => {
  // Two apps must not share a slot.
  it('given_two_origins_then_their_coverage_reports_have_different_keys', () => {
    expect(reportKey('coverage', APP_A)).not.toBe(reportKey('coverage', APP_B));
  });

  it('given_two_runs_of_one_app_then_their_keys_differ', () => {
    expect(reportKey('coverage', { origin: 'https://a.test', runId: 'r1' })).not.toBe(
      reportKey('coverage', { origin: 'https://a.test', runId: 'r2' })
    );
  });

  // Accessibility is per-page, not per-app: two pages of one app are different
  // audits and must not overwrite each other.
  it('given_two_pages_then_their_a11y_reports_have_different_keys', () => {
    expect(reportKey('a11y', { pageUrl: 'https://a.test/one' })).not.toBe(
      reportKey('a11y', { pageUrl: 'https://a.test/two' })
    );
  });

  // Cost has no app or run; keying it by one would make a new empty report
  // every time the user switched tabs.
  it('given_any_scope_then_cost_always_uses_one_key', () => {
    expect(reportKey('cost', APP_A)).toBe(reportKey('cost', APP_B));
  });

  it('given_no_scope_then_a_key_is_still_produced', () => {
    expect(reportKey('coverage', undefined)).toBeTruthy();
  });
});

describe('a completion arriving while the panel is closed', () => {
  // The store is owned by App, which is always mounted, so this works whether
  // or not the panel exists.
  it('given_a_report_with_no_pending_request_then_it_is_still_stored', () => {
    useAnalysisStore.getState().acceptReport('coverage', '# Coverage', APP_A);

    expect(useAnalysisStore.getState().reportFor('coverage', APP_A)?.markdown).toBe('# Coverage');
  });

  it('given_a_stored_report_then_it_records_when_it_completed', () => {
    useAnalysisStore.getState().acceptReport('coverage', '# Coverage', APP_A);
    const report = useAnalysisStore.getState().reportFor('coverage', APP_A)!;

    expect(Date.parse(report.completedAt)).not.toBeNaN();
    expect(report.scope).toMatchObject(APP_A);
  });

  it('given_a_stored_report_then_it_is_persisted', () => {
    useAnalysisStore.getState().acceptReport('coverage', '# Coverage', APP_A);
    expect(analysisReportStorage.save).toHaveBeenCalled();
  });

  it('given_persisted_reports_then_load_restores_them', async () => {
    vi.mocked(analysisReportStorage.get).mockResolvedValue({
      [reportKey('coverage', APP_A)]: {
        type: 'coverage',
        markdown: '# Restored',
        completedAt: '2026-09-11T00:00:00.000Z',
        scope: APP_A,
      },
    } as never);

    await useAnalysisStore.getState().load();
    expect(useAnalysisStore.getState().reportFor('coverage', APP_A)?.markdown).toBe('# Restored');
  });

  // Losing a report this session because storage failed would be worse than
  // losing it on reload.
  it('given_persistence_fails_then_the_report_is_still_in_memory', () => {
    vi.mocked(analysisReportStorage.save).mockRejectedValue(new Error('quota'));
    useAnalysisStore.getState().acceptReport('coverage', '# Coverage', APP_A);

    expect(useAnalysisStore.getState().reportFor('coverage', APP_A)).toBeDefined();
  });
});

describe('two apps or runs do not cross-contaminate', () => {
  it('given_reports_for_two_apps_then_each_keeps_its_own', () => {
    const store = useAnalysisStore.getState();
    store.acceptReport('coverage', '# A', APP_A);
    store.acceptReport('coverage', '# B', APP_B);

    expect(useAnalysisStore.getState().reportFor('coverage', APP_A)?.markdown).toBe('# A');
    expect(useAnalysisStore.getState().reportFor('coverage', APP_B)?.markdown).toBe('# B');
  });
});

describe('out-of-order responses', () => {
  // The scenario: the user starts coverage for app A, switches and starts it for
  // app B, and A's slow answer lands last. It must not clear B's spinner.
  it('given_a_superseded_response_then_the_newer_request_is_still_running', () => {
    const store = useAnalysisStore.getState();
    store.beginRequest('coverage'); // request 1, immediately superseded
    const second = store.beginRequest('coverage');

    store.acceptReport('coverage', '# Stale A', { ...APP_A, requestId: 'request-1' });

    const job = useAnalysisStore.getState().jobs.coverage;
    expect(job.status).toBe('running');
    expect(job.status === 'running' && job.requestId).toBe(second);
  });

  // It is still a true report about that scope, so it is kept — just not shown
  // as the answer to the question now being asked.
  it('given_a_superseded_response_then_it_is_still_stored_under_its_own_key', () => {
    const store = useAnalysisStore.getState();
    store.beginRequest('coverage');
    store.beginRequest('coverage');
    store.acceptReport('coverage', '# Stale A', { ...APP_A, requestId: 'request-1' });

    expect(useAnalysisStore.getState().reportFor('coverage', APP_A)?.markdown).toBe('# Stale A');
  });

  it('given_the_matching_response_then_the_job_returns_to_idle', () => {
    const store = useAnalysisStore.getState();
    const requestId = store.beginRequest('coverage');
    store.acceptReport('coverage', '# Fresh', { ...APP_A, requestId });

    expect(useAnalysisStore.getState().jobs.coverage.status).toBe('idle');
  });

  // An auto-run after a suite has no requestId to echo, and must not be
  // mistaken for a superseded answer.
  it('given_an_unsolicited_report_then_it_clears_a_pending_job', () => {
    const store = useAnalysisStore.getState();
    store.beginRequest('coverage');
    store.acceptReport('coverage', '# Auto', { ...APP_A, requestId: undefined });

    expect(useAnalysisStore.getState().jobs.coverage.status).toBe('idle');
  });
});

describe('failure, timeout and late completion are distinguished', () => {
  it('given_a_precondition_failure_then_the_job_carries_the_real_reason', () => {
    useAnalysisStore.getState().failJob('contracts', 'No OpenAPI spec loaded');
    const job = useAnalysisStore.getState().jobs.contracts;

    expect(job.status).toBe('failed');
    expect(job.status === 'failed' && job.reason).toBe('No OpenAPI spec loaded');
  });

  it('given_a_running_job_then_the_timeout_marks_it_timed_out', () => {
    const store = useAnalysisStore.getState();
    store.beginRequest('a11y');
    store.timeoutJob('a11y');

    expect(useAnalysisStore.getState().jobs.a11y.status).toBe('timeout');
  });

  // A result that arrived while the panel was closed must not be retroactively
  // timed out by a timer that is still pending.
  it('given_a_job_that_already_answered_then_a_late_timeout_does_nothing', () => {
    const store = useAnalysisStore.getState();
    const requestId = store.beginRequest('a11y');
    store.acceptReport('a11y', '# A11y', { pageUrl: 'https://a.test/p', requestId });

    store.timeoutJob('a11y');
    expect(useAnalysisStore.getState().jobs.a11y.status).toBe('idle');
  });

  it('given_a_failed_job_then_a_late_timeout_does_not_overwrite_the_reason', () => {
    const store = useAnalysisStore.getState();
    store.beginRequest('contracts');
    store.failJob('contracts', 'No spec');
    store.timeoutJob('contracts');

    expect(useAnalysisStore.getState().jobs.contracts.status).toBe('failed');
  });

  it('given_one_section_failing_then_the_others_are_unaffected', () => {
    useAnalysisStore.getState().failJob('contracts', 'No spec');
    expect(useAnalysisStore.getState().jobs.coverage.status).toBe('idle');
  });
});

describe('storage stays bounded', () => {
  // Reports are markdown; a long session across many runs would otherwise grow
  // chrome.storage without limit.
  it('given_many_reports_then_the_oldest_are_dropped', () => {
    const store = useAnalysisStore.getState();
    for (let i = 0; i < 40; i++) {
      store.acceptReport('coverage', `# ${i}`, { origin: 'https://a.test', runId: `run-${i}` });
    }

    const reports = useAnalysisStore.getState().reports;
    expect(Object.keys(reports).length).toBeLessThanOrEqual(24);
    // The most recent survives.
    expect(reports[reportKey('coverage', { origin: 'https://a.test', runId: 'run-39' })]).toBeDefined();
  });
});
