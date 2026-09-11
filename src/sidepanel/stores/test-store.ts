import { create } from 'zustand';
import { hasPermissionFor, requestPermissionFor } from '../../drivers/host-permissions';
import type { TestCase, TestResult, Flow } from '../../storage/schemas';
import { testCaseDB, testResultDB } from '../../storage/indexed-db';
import { getAllFlows } from '../../core/flow/flow-store';
import { createUserTestCase } from '../../core/test-gen/test-generator';
import { parseDataSet } from '../../core/test-gen/dataset';
import { settingsStorage } from '../../storage/chrome-storage';
import { createTestRailClient } from '../../core/integrations/testrail-client';
import {
  caseIdFromTestCaseId,
  importRunAsTestCases,
  pushResultsToTestRail,
  testRailConfigFrom,
} from '../../core/integrations/testrail-sync';
import { createLogger } from '../../utils/logger';

const log = createLogger('test-store');
import { sendToBackground } from '../../messaging/messenger';

interface ImportProgress {
  current: number;
  total: number;
  title: string;
  phase: 'expanding' | 'saving';
}

export interface LiveStepResult {
  stepOrder: number;
  status: 'passed' | 'failed' | 'skipped';
  action: string;
  description: string;
  error?: string;
}

type RunMode = 'single' | 'suite' | null;

interface TestState {
  testCases: TestCase[];
  results: TestResult[];
  flows: Flow[];
  selectedTestIds: string[];
  preflightWarnings: string[];
  isRunning: boolean;
  runMode: RunMode;
  runningTestIds: string[];
  liveStepResults: Record<string, LiveStepResult[]>;
  isImporting: boolean;
  importProgress: ImportProgress | null;
  isExpanding: boolean;
  error: string | null;
  /** When set, rewrite the explored app's origin to this URL before running tests. */
  targetOrigin: string;
  /**
   * Why a pasted CSV was rejected, keyed by test case id.
   *
   * Rendered next to the input: strict validation that fails silently is
   * indistinguishable from a broken feature.
   */
  datasetErrors: Record<string, string[] | undefined>;
  /** Latest stability-gate verdict per test case, for display. */
  stabilitySummaries: Record<string, string | undefined>;
  /** Outcome of the last TestRail import or push, for display. */
  testRailStatus: { message: string; failures: string[] } | null;

  loadAll: () => Promise<void>;
  addUserTest: (title: string, description: string, options?: { type?: 'positive' | 'negative' | 'edge'; steps?: string[]; startUrl?: string; executionPresetId?: string }) => Promise<void>;
  deleteTestCase: (id: string) => Promise<void>;
  /** Delete the given test cases (defaults to the current selection). */
  deleteTests: (ids?: string[]) => Promise<void>;
  generateTestsForFlow: (flowId: string) => Promise<void>;
  regenerateTestCase: (testCaseId: string, additionalContext: string) => Promise<void>;
  importTests: (tests: unknown[], options?: { runAfterImport?: boolean }) => Promise<void>;
  setTargetOrigin: (url: string) => void;
  attachDataSet: (testCaseId: string, csv: string) => Promise<void>;
  clearDataSet: (testCaseId: string) => Promise<void>;
  setQuarantined: (testCaseId: string, value: boolean) => Promise<void>;
  checkStability: (testCaseId: string, attempts?: number) => Promise<void>;
  resumeTest: (testCaseId: string, startFromStep: number) => Promise<void>;
  importFromTestRail: (runId: number) => Promise<void>;
  setTestRailRunId: (runId: number) => Promise<void>;
  pushResultsToTestRail: (runId: number) => Promise<void>;
  runTest: (testCaseId: string) => Promise<void>;
  runSelectedTests: (testCaseIds: string[]) => Promise<void>;
  runAllTests: (options?: { rerunAll?: boolean }) => Promise<void>;
  clearResults: () => Promise<void>;
  exportPlans: () => Promise<void>;
  clearError: () => void;
  clearPreflightWarnings: () => void;
  toggleSelectedTest: (testCaseId: string) => void;
  setSelectedTestIds: (testCaseIds: string[]) => void;
  clearSelectedTests: () => void;
  setTestStarted: (testCaseId: string) => void;
  setStepResult: (payload: {
    testCaseId: string;
    stepOrder: number;
    status: string;
    action: string;
    description: string;
    error?: string;
  }) => void;
  setTestComplete: (testCaseId: string, status: string) => void;
  setAllTestsComplete: () => void;
  setImportProgress: (progress: ImportProgress) => void;
  setImportComplete: () => void;
  setImportError: (error: string) => void;
}

export const useTestStore = create<TestState>((set, get) => ({
  testCases: [],
  results: [],
  flows: [],
  selectedTestIds: [],
  preflightWarnings: [],
  isRunning: false,
  runMode: null,
  runningTestIds: [],
  liveStepResults: {},
  isImporting: false,
  importProgress: null,
  isExpanding: false,
  error: null,
  targetOrigin: '',
  datasetErrors: {},
  stabilitySummaries: {},
  testRailStatus: null,

  setTargetOrigin: (url) => set({ targetOrigin: url }),

  /**
   * Pull a TestRail run's cases in as Pathfinder test cases.
   *
   * Called from the side panel rather than the worker: this is `fetch` plus an
   * IndexedDB write, and routing it through a message would add a hop for no
   * capability. The host permission is requested first — the user grants their
   * own TestRail instance, not a blanket origin.
   */
  importFromTestRail: async (runId) => {
    set({ error: null, testRailStatus: null, isImporting: true });
    try {
      const settings = await settingsStorage.get();
      const config = testRailConfigFrom(settings);
      if (!config) {
        set({ error: 'Add your TestRail host, email and API key in Settings first.' });
        return;
      }
      if (!(await hasPermissionFor([config.host]))) {
        const granted = await requestPermissionFor([config.host]);
        if (!granted) {
          set({ error: `Permission to reach ${config.host} was declined.` });
          return;
        }
      }

      const client = createTestRailClient(config);
      const imported = importRunAsTestCases(await client.getTests(runId), runId);
      if (imported.length === 0) {
        set({ testRailStatus: { message: `Run ${runId} has no tests.`, failures: [] } });
        return;
      }

      await Promise.all(imported.map((tc) => testCaseDB.put(tc)));
      await get().setTestRailRunId(runId);
      await get().loadAll();
      set({
        testRailStatus: {
          message: `Imported ${imported.length} case(s) from run ${runId}.`,
          failures: [],
        },
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ isImporting: false });
    }
  },

  /**
   * Push the current results back to a TestRail run.
   *
   * A partial push is reported in full: knowing that 48 of 50 landed, and which
   * two did not, is recoverable. A silent partial push is not.
   */
  pushResultsToTestRail: async (runId) => {
    set({ error: null, testRailStatus: null });
    try {
      const settings = await settingsStorage.get();
      const config = testRailConfigFrom(settings);
      if (!config) {
        set({ error: 'Add your TestRail host, email and API key in Settings first.' });
        return;
      }
      if (!(await hasPermissionFor([config.host]))) {
        const granted = await requestPermissionFor([config.host]);
        if (!granted) {
          set({ error: `Permission to reach ${config.host} was declined.` });
          return;
        }
      }

      const summary = await pushResultsToTestRail({
        runId,
        results: get().results,
        client: createTestRailClient(config),
        caseIdFor: (r) => caseIdFromTestCaseId(r.testCaseId),
      });

      await get().setTestRailRunId(runId);
      set({
        testRailStatus: {
          message: `Pushed ${summary.pushed} result(s), attached ${summary.attached} screenshot(s).`,
          failures: summary.failures.map((f) =>
            f.caseId ? `C${f.caseId}: ${f.error}` : f.error
          ),
        },
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  /**
   * Re-run a test from a given step.
   *
   * Uses the same live-progress plumbing as a normal single-test run, so the UI
   * behaves identically; only the starting point differs.
   */
  resumeTest: async (testCaseId, startFromStep) => {
    set({ error: null });
    const resp = await sendToBackground<{ success: boolean; error?: string }>({
      type: 'RESUME_TEST',
      payload: { testCaseId, startFromStep, targetOrigin: get().targetOrigin || undefined },
    });
    if (!resp?.success) set({ error: resp?.error ?? 'Failed to resume the test' });
  },

  /** Remember the run so the next import or push does not re-ask. */
  setTestRailRunId: async (runId: number) => {
    const settings = await settingsStorage.get();
    if (!settings.testrail) return;
    await settingsStorage.save({ ...settings, testrail: { ...settings.testrail, lastRunId: runId } });
  },


  /**
   * Attach pasted CSV as this test's data set.
   *
   * Parse errors are stored, not thrown: the user pasted a sheet and needs to
   * see which line or column is wrong, in place.
   */
  attachDataSet: async (testCaseId, csv) => {
    const { dataSet, errors } = parseDataSet(csv);
    if (!dataSet) {
      set((s) => ({ datasetErrors: { ...s.datasetErrors, [testCaseId]: errors } }));
      return;
    }
    const testCase = get().testCases.find((tc) => tc.id === testCaseId);
    if (!testCase) return;

    const updated: TestCase = { ...testCase, dataSet };
    await testCaseDB.put(updated);
    set((s) => ({
      testCases: s.testCases.map((tc) => (tc.id === testCaseId ? updated : tc)),
      datasetErrors: { ...s.datasetErrors, [testCaseId]: undefined },
    }));
  },

  clearDataSet: async (testCaseId) => {
    const testCase = get().testCases.find((tc) => tc.id === testCaseId);
    if (!testCase) return;

    const updated: TestCase = { ...testCase };
    delete updated.dataSet;
    await testCaseDB.put(updated);
    set((s) => ({
      testCases: s.testCases.map((tc) => (tc.id === testCaseId ? updated : tc)),
      datasetErrors: { ...s.datasetErrors, [testCaseId]: undefined },
    }));
  },

  setQuarantined: async (testCaseId, value) => {
    const testCase = get().testCases.find((tc) => tc.id === testCaseId);
    if (!testCase) return;

    const updated: TestCase = { ...testCase, quarantined: value };
    await testCaseDB.put(updated);
    set((s) => ({
      testCases: s.testCases.map((tc) => (tc.id === testCaseId ? updated : tc)),
    }));
  },

  /**
   * Run a test several times back to back and quarantine it if it disagrees
   * with itself.
   *
   * The gate runs in the background worker — it drives real execution, which
   * the side panel cannot do — so this action only dispatches and applies the
   * verdict it gets back.
   */
  checkStability: async (testCaseId, attempts) => {
    set((s) => ({
      error: null,
      runningTestIds: [...s.runningTestIds, testCaseId],
    }));
    try {
      const resp = await sendToBackground<{
        success: boolean;
        error?: string;
        verdict?: string;
        summary?: string;
        quarantine?: boolean;
      }>({ type: 'CHECK_STABILITY', payload: { testCaseId, attempts } });

      if (!resp?.success) {
        set({ error: resp?.error ?? 'Stability check failed' });
        return;
      }
      if (resp.quarantine) await get().setQuarantined(testCaseId, true);
      set((s) => ({
        stabilitySummaries: { ...s.stabilitySummaries, [testCaseId]: resp.summary },
      }));
      await get().loadAll();
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set((s) => ({
        runningTestIds: s.runningTestIds.filter((id) => id !== testCaseId),
      }));
    }
  },

  loadAll: async () => {
    const [testCases, results, flows] = await Promise.all([
      testCaseDB.getAll(),
      testResultDB.getAll(),
      getAllFlows(),
    ]);
    set({
      testCases,
      results: results.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      flows,
      selectedTestIds: get().selectedTestIds.filter((testCaseId) =>
        testCases.some((testCase) => testCase.id === testCaseId)
      ),
    });
  },

  addUserTest: async (title, description, options) => {
    set({ isExpanding: true, error: null });
    try {
      const resp = await sendToBackground<{ success: boolean; error?: string; testCaseId?: string }>({
        type: 'EXPAND_TEST_CASE',
        payload: {
          title,
          description,
          type: options?.type ?? 'positive',
          steps: options?.steps,
          startUrl: options?.startUrl,
          executionPresetId: options?.executionPresetId,
        },
      });

      if (resp?.success) {
        // Reload from DB so the enriched test case appears with its AI-generated steps
        await get().loadAll();
      } else {
        // Background returned an error (e.g. no API key) — fall back to direct save
        log.warn('EXPAND_TEST_CASE failed, saving sparse test case:', resp?.error);
        const testCase = await createUserTestCase(title, description, options ?? {});
        set((state) => ({ testCases: [...state.testCases, testCase] }));
      }
    } catch (err) {
      log.warn('EXPAND_TEST_CASE threw, saving sparse test case:', err);
      const testCase = await createUserTestCase(title, description, options ?? {});
      set((state) => ({ testCases: [...state.testCases, testCase] }));
    } finally {
      set({ isExpanding: false });
    }
  },

  deleteTestCase: async (id) => {
    await testCaseDB.delete(id);
    set((state) => ({
      testCases: state.testCases.filter((tc) => tc.id !== id),
      results: state.results.filter((result) => result.testCaseId !== id),
      runningTestIds: state.runningTestIds.filter((runningId) => runningId !== id),
      selectedTestIds: state.selectedTestIds.filter((selectedId) => selectedId !== id),
    }));
  },

  deleteTests: async (ids) => {
    const idsToDelete = ids ?? get().selectedTestIds;
    if (idsToDelete.length === 0) return;
    const idSet = new Set(idsToDelete);
    // Never delete a test that's mid-run.
    const running = new Set(get().runningTestIds);
    const deletable = [...idSet].filter((id) => !running.has(id));
    if (deletable.length === 0) return;
    const deletedSet = new Set(deletable);
    await Promise.all(deletable.map((id) => testCaseDB.delete(id)));
    set((state) => ({
      testCases: state.testCases.filter((tc) => !deletedSet.has(tc.id)),
      results: state.results.filter((result) => !deletedSet.has(result.testCaseId)),
      selectedTestIds: state.selectedTestIds.filter((selectedId) => !deletedSet.has(selectedId)),
    }));
  },

  regenerateTestCase: async (testCaseId, additionalContext) => {
    set((state) => ({ 
      isExpanding: true, 
      error: null,
      runningTestIds: [...state.runningTestIds, testCaseId] 
    }));
    try {
      const resp = await sendToBackground<{ success: boolean; error?: string; testCaseId?: string }>({
        type: 'REGENERATE_TEST_CASE',
        payload: { testCaseId, additionalContext },
      });

      if (resp?.success) {
        await get().loadAll();
      } else {
        set({ error: resp?.error ?? 'Failed to regenerate test case' });
      }
    } catch (err) {
      set({ error: String(err) });
    } finally {
      set((state) => ({ 
        isExpanding: false,
        runningTestIds: state.runningTestIds.filter(id => id !== testCaseId)
      }));
    }
  },

  generateTestsForFlow: async (flowId) => {
    set({ error: null });
    const resp = await sendToBackground<{ success: boolean; error?: string }>({
      type: 'GENERATE_TESTS',
      payload: { flowId },
    });
    if (!resp?.success) {
      set({ error: resp?.error ?? 'Failed to generate tests' });
    }
  },

  importTests: async (tests, options = {}) => {
    set({ isImporting: true, importProgress: null, error: null });
    const resp = await sendToBackground<{
      success: boolean;
      error?: string;
      importedIds?: string[];
    }>({ type: 'IMPORT_TESTS', payload: { tests } });

    if (!resp?.success) {
      set({ isImporting: false, error: resp?.error ?? 'Failed to import tests' });
      return;
    }

    if (options.runAfterImport && resp.importedIds && resp.importedIds.length > 0) {
      await get().runSelectedTests(resp.importedIds);
    }
  },

  runTest: async (testCaseId) => {
    set({
      isRunning: true,
      runMode: 'single',
      runningTestIds: [testCaseId],
      liveStepResults: {},
      preflightWarnings: [],
      error: null,
    });

    const resp = await sendToBackground<{ success: boolean; error?: string; warnings?: string[] }>({
      type: 'RUN_TEST',
      payload: { testCaseId, targetOrigin: get().targetOrigin || undefined },
    });

    if (!resp?.success) {
      set({
        isRunning: false,
        runMode: null,
        runningTestIds: [],
        preflightWarnings: resp?.warnings ?? [],
        error: resp?.error ?? 'Failed to start test',
      });
      return;
    }

    set({ preflightWarnings: resp.warnings ?? [] });
  },

  runSelectedTests: async (testCaseIds) => {
    if (testCaseIds.length === 0) return;

    set({
      isRunning: true,
      runMode: testCaseIds.length === 1 ? 'single' : 'suite',
      runningTestIds: testCaseIds.length === 1 ? testCaseIds : [],
      liveStepResults: {},
      preflightWarnings: [],
      error: null,
    });

    const resp = await sendToBackground<{ success: boolean; error?: string; warnings?: string[] }>({
      type: 'RUN_SELECTED_TESTS',
      payload: { testCaseIds, targetOrigin: get().targetOrigin || undefined },
    });

    if (!resp?.success) {
      set({
        isRunning: false,
        runMode: null,
        runningTestIds: [],
        preflightWarnings: resp?.warnings ?? [],
        error: resp?.error ?? 'Failed to start selected tests',
      });
      return;
    }

    set({ preflightWarnings: resp.warnings ?? [] });
  },

  runAllTests: async (options = {}) => {
    // fix.md §7.5: access is granted per app, from the user's click. Without it
    // every request in the run would be blocked, which presents as a
    // hard-to-diagnose wall of failures rather than a permission problem.
    const targets = get().testCases.map((t) => t.startUrl).filter((u): u is string => Boolean(u));
    if (targets.length > 0 && !(await hasPermissionFor(targets))) {
      const granted = await requestPermissionFor(targets);
      if (!granted) {
        set({
          isRunning: false,
          error:
            'Pathfinder needs permission to access the sites these tests target. ' +
            'Grant access when prompted, then run again.',
        });
        return;
      }
    }

    set({
      isRunning: true,
      runMode: 'suite',
      runningTestIds: [],
      liveStepResults: {},
      preflightWarnings: [],
      error: null,
    });
    const resp = await sendToBackground<{ success: boolean; error?: string; warnings?: string[] }>({
      type: 'RUN_ALL_TESTS',
      payload: { ...options, targetOrigin: get().targetOrigin || undefined },
    });

    if (!resp?.success) {
      set({
        isRunning: false,
        runMode: null,
        runningTestIds: [],
        preflightWarnings: resp?.warnings ?? [],
        error: resp?.error ?? 'Failed to start test suite',
      });
      return;
    }

    set({ preflightWarnings: resp.warnings ?? [] });
  },

  exportPlans: async () => {
    const resp = await sendToBackground<{
      success: boolean;
      data?: unknown;
      error?: string;
    }>({ type: 'EXPORT_PLANS' });
    if (!resp?.success || !resp.data) {
      set({ error: resp?.error ?? 'Failed to export plans' });
      return;
    }

    const json = JSON.stringify(resp.data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pathfinder-plans-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },

  clearResults: async () => {
    await testResultDB.clear();
    const testCases = await testCaseDB.getAll();
    const reset = testCases.map((tc) => ({ ...tc, status: 'pending' as const }));
    await Promise.all(reset.map((tc) => testCaseDB.put(tc)));
    set({
      results: [],
      testCases: reset,
      isRunning: false,
      runMode: null,
      runningTestIds: [],
      liveStepResults: {},
      error: null,
    });
  },

  clearError: () => set({ error: null }),
  clearPreflightWarnings: () => set({ preflightWarnings: [] }),

  toggleSelectedTest: (testCaseId) => {
    set((state) => ({
      selectedTestIds: state.selectedTestIds.includes(testCaseId)
        ? state.selectedTestIds.filter((selectedId) => selectedId !== testCaseId)
        : [...state.selectedTestIds, testCaseId],
    }));
  },

  setSelectedTestIds: (testCaseIds) => {
    const uniqueIds = Array.from(new Set(testCaseIds));
    set({ selectedTestIds: uniqueIds });
  },

  clearSelectedTests: () => set({ selectedTestIds: [] }),

  setTestStarted: (testCaseId) => {
    set((state) => ({
      isRunning: true,
      runningTestIds: state.runningTestIds.includes(testCaseId)
        ? state.runningTestIds
        : [...state.runningTestIds, testCaseId],
      testCases: state.testCases.map((testCase) =>
        testCase.id === testCaseId ? { ...testCase, status: 'running' } : testCase
      ),
      liveStepResults: {
        ...state.liveStepResults,
        [testCaseId]: [],
      },
    }));
  },

  setStepResult: (payload) => {
    const status = normalizeStepStatus(payload.status);
    if (!status) return;

    set((state) => {
      const current = state.liveStepResults[payload.testCaseId] ?? [];
      const next = current
        .filter((step) => step.stepOrder !== payload.stepOrder)
        .concat({
          stepOrder: payload.stepOrder,
          status,
          action: payload.action,
          description: payload.description,
          error: payload.error,
        })
        .sort((a, b) => a.stepOrder - b.stepOrder);

      return {
        liveStepResults: {
          ...state.liveStepResults,
          [payload.testCaseId]: next,
        },
      };
    });
  },

  setTestComplete: (testCaseId, status) => {
    set((state) => {
      const nextRunningIds = state.runningTestIds.filter((runningId) => runningId !== testCaseId);
      const isSingleRun = state.runMode === 'single';

      return {
        isRunning: isSingleRun ? false : state.isRunning,
        runMode: isSingleRun ? null : state.runMode,
        runningTestIds: nextRunningIds,
        testCases: state.testCases.map((testCase) =>
          testCase.id === testCaseId ? { ...testCase, status: normalizeTestStatus(status) } : testCase
        ),
      };
    });

    void get().loadAll();
  },

  setAllTestsComplete: () => {
    set({ isRunning: false, runMode: null, runningTestIds: [], liveStepResults: {} });
    void get().loadAll();
  },

  setImportProgress: (progress) => {
    set({ importProgress: progress, isImporting: true });
  },

  setImportComplete: () => {
    set({ isImporting: false, importProgress: null, error: null });
    void get().loadAll();
  },

  setImportError: (error) => {
    set({ isImporting: false, importProgress: null, error });
  },
}));

function normalizeTestStatus(status: string): TestCase['status'] {
  if (status === 'passed' || status === 'failed' || status === 'error' || status === 'running') {
    return status;
  }
  return 'pending';
}

function normalizeStepStatus(status: string): LiveStepResult['status'] | null {
  if (status === 'passed' || status === 'failed' || status === 'skipped') {
    return status;
  }
  return null;
}
