/**
 * Analysis reports and job state, outside the panel that shows them.
 *
 * They used to live in `AnalysisPanel`'s own `useState`, with the completion
 * listener registered in its `useEffect`. `App.tsx` swaps mounted panels, so
 * switching tabs mid-analysis threw the state away *and* unregistered the
 * listener — the result arrived with nobody to receive it, and returning to the
 * tab showed an empty panel with no indication that anything had happened.
 *
 * Reports are keyed by what they describe rather than by type alone, so two apps
 * or two runs cannot overwrite each other, and a slow response cannot be
 * displayed as the current one.
 */
import { create } from 'zustand';
import type { AnalysisScope } from '../../messaging/messages';
import { analysisReportStorage } from '../../storage/chrome-storage';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';

const log = createLogger('analysis-store');

export type AnalysisSection = 'coverage' | 'a11y' | 'contracts' | 'cost';

export interface AnalysisReport {
  type: AnalysisSection;
  markdown: string;
  /** ISO timestamp — stored, so it survives a reload with its real age. */
  completedAt: string;
  scope: AnalysisScope;
}

export type JobState =
  | { status: 'idle' }
  | { status: 'running'; requestId: string; startedAt: number }
  | { status: 'failed'; reason: string }
  | { status: 'timeout' };

/**
 * A report's identity.
 *
 * Cost is deliberately session-wide: it has no app or run, and keying it by one
 * would create a new empty report every time the user changed tabs.
 */
export function reportKey(type: AnalysisSection, scope: AnalysisScope | undefined): string {
  if (type === 'cost') return 'cost';
  if (type === 'a11y') return `a11y|${scope?.pageUrl ?? scope?.origin ?? '-'}`;
  return `${type}|${scope?.origin ?? '-'}|${scope?.runId ?? '-'}`;
}

interface AnalysisState {
  reports: Record<string, AnalysisReport>;
  /** In-flight / failed state per section, so the panel can render either. */
  jobs: Record<AnalysisSection, JobState>;
  loaded: boolean;

  load: () => Promise<void>;
  /** Register a request and return the id to send with it. */
  beginRequest: (type: AnalysisSection) => string;
  /** Accept a completion, unless a newer request has superseded it. */
  acceptReport: (type: AnalysisSection, markdown: string, scope: AnalysisScope | undefined) => void;
  failJob: (type: AnalysisSection, reason: string) => void;
  timeoutJob: (type: AnalysisSection) => void;
  reportFor: (type: AnalysisSection, scope: AnalysisScope | undefined) => AnalysisReport | undefined;
}

const IDLE_JOBS: Record<AnalysisSection, JobState> = {
  coverage: { status: 'idle' },
  a11y: { status: 'idle' },
  contracts: { status: 'idle' },
  cost: { status: 'idle' },
};

/** Keep storage bounded — reports are markdown and one app can accumulate many. */
const MAX_STORED_REPORTS = 24;

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  reports: {},
  jobs: { ...IDLE_JOBS },
  loaded: false,

  load: async () => {
    const reports = await analysisReportStorage
      .get<Record<string, AnalysisReport>>()
      .catch(() => ({} as Record<string, AnalysisReport>));
    set({ reports, loaded: true });
  },

  beginRequest: (type) => {
    const requestId = generateId();
    set((state) => ({
      jobs: { ...state.jobs, [type]: { status: 'running', requestId, startedAt: Date.now() } },
    }));
    return requestId;
  },

  acceptReport: (type, markdown, scope) => {
    const job = get().jobs[type];
    // A completion whose requestId does not match the in-flight one is a late
    // answer to a superseded question. It is stored under its own key — it is
    // still a true report about that scope — but it must not clear the spinner
    // or claim to be the current result.
    const supersededResponse =
      job.status === 'running' && scope?.requestId !== undefined && scope.requestId !== job.requestId;

    const report: AnalysisReport = {
      type,
      markdown,
      completedAt: new Date().toISOString(),
      scope: scope ?? {},
    };
    const key = reportKey(type, scope);

    set((state) => {
      const reports = { ...state.reports, [key]: report };
      // Oldest first out, so a long session cannot grow storage without bound.
      const keys = Object.keys(reports);
      if (keys.length > MAX_STORED_REPORTS) {
        keys
          .sort((a, b) => reports[a].completedAt.localeCompare(reports[b].completedAt))
          .slice(0, keys.length - MAX_STORED_REPORTS)
          .forEach((k) => delete reports[k]);
      }
      return {
        reports,
        jobs: supersededResponse ? state.jobs : { ...state.jobs, [type]: { status: 'idle' } },
      };
    });

    if (supersededResponse) {
      log.info(`Late ${type} report stored under ${key} — a newer request is still running`);
    }
    analysisReportStorage.save(get().reports).catch((err) => {
      // A report that cannot be persisted is still usable this session; losing
      // it on reload is better than losing it now.
      log.warn('Could not persist analysis reports', err);
    });
  },

  failJob: (type, reason) =>
    set((state) => ({ jobs: { ...state.jobs, [type]: { status: 'failed', reason } } })),

  timeoutJob: (type) =>
    set((state) => {
      // Only a still-running job times out. A job that already answered must not
      // be retroactively marked as having timed out.
      if (state.jobs[type].status !== 'running') return state;
      return { jobs: { ...state.jobs, [type]: { status: 'timeout' } } };
    }),

  reportFor: (type, scope) => get().reports[reportKey(type, scope)],
}));
