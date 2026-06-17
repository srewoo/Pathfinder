import { useEffect } from 'react';
import { OneLineTestRunner } from './OneLineTestRunner';
import { TestCaseInput } from './TestCaseInput';
import { TestCaseList } from './TestCaseList';
import { TestSuiteRunner } from './TestSuiteRunner';
import { TestImportPanel } from './TestImportPanel';
import { useTestStore } from '../../stores/test-store';

export function TestPanel() {
  const store = useTestStore();
  const failedTestIds = store.testCases
    .filter((testCase) => testCase.status === 'failed' || testCase.status === 'error')
    .map((testCase) => testCase.id);

  useEffect(() => {
    store.loadAll();
  }, []);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div>
        <h2 className="text-xs font-semibold text-text-primary">Test Cases</h2>
        <p className="text-2xs text-text-muted mt-0.5">One-line QA checks, imported suites, and detailed manual tests</p>
      </div>

      <OneLineTestRunner />

      {store.error && (
        <div className="p-2.5 bg-error/10 border border-error/20 rounded-lg">
          <p className="text-xs text-error">{store.error}</p>
        </div>
      )}

      {store.preflightWarnings.length > 0 && (
        <div className="p-2.5 bg-warning/10 border border-warning/20 rounded-lg space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-warning font-medium">Execution preflight warnings</p>
            <button
              onClick={store.clearPreflightWarnings}
              className="text-2xs text-warning/80 hover:text-warning transition-colors"
            >
              Dismiss
            </button>
          </div>
          {store.preflightWarnings.map((warning) => (
            <p key={warning} className="text-2xs text-warning leading-relaxed">
              {warning}
            </p>
          ))}
        </div>
      )}

      <TestSuiteRunner
        testCases={store.testCases}
        isRunning={store.isRunning}
        selectedCount={store.selectedTestIds.length}
        hasFailures={store.testCases.some((testCase) => testCase.status === 'failed' || testCase.status === 'error')}
        onRunAll={store.runAllTests}
        onRunSelected={() => store.runSelectedTests(store.selectedTestIds)}
        onRunFailed={() => store.runSelectedTests(failedTestIds)}
        onRerunAll={() => store.runAllTests({ rerunAll: true })}
        onClear={store.clearResults}
      />

      <TestCaseInput />

      <TestImportPanel />

      <TestCaseList
        testCases={store.testCases}
        selectedTestIds={store.selectedTestIds}
        runningTestIds={store.runningTestIds}
        liveStepResults={store.liveStepResults}
        onRun={store.runTest}
        onDelete={store.deleteTestCase}
        onRegenerate={store.regenerateTestCase}
        onToggleSelection={store.toggleSelectedTest}
        onSelectAll={() => store.setSelectedTestIds(store.testCases.map((testCase) => testCase.id))}
        onSelectFailed={() => store.setSelectedTestIds(failedTestIds)}
        onClearSelection={store.clearSelectedTests}
        onDeleteSelected={() => store.deleteTests()}
      />
    </div>
  );
}
