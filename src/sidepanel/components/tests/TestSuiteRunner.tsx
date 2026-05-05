import { Play, RotateCcw, PackageOpen, RefreshCw, Square } from 'lucide-react';
import { Button } from '../shared/Button';
import { useTestStore } from '../../stores/test-store';
import { sendToBackground } from '../../../messaging/messenger';
import type { TestCase } from '../../../storage/schemas';

interface TestSuiteRunnerProps {
  testCases: TestCase[];
  isRunning: boolean;
  selectedCount: number;
  hasFailures: boolean;
  onRunAll: () => void;
  onRunSelected: () => void;
  onRunFailed: () => void;
  onRerunAll: () => void;
  onClear: () => void;
}

export function TestSuiteRunner({
  testCases,
  isRunning,
  selectedCount,
  hasFailures,
  onRunAll,
  onRunSelected,
  onRunFailed,
  onRerunAll,
  onClear,
}: TestSuiteRunnerProps) {
  const store = useTestStore();
  const passed = testCases.filter((tc) => tc.status === 'passed').length;
  const failed = testCases.filter((tc) => tc.status === 'failed' || tc.status === 'error').length;
  const pending = testCases.filter((tc) => tc.status === 'pending').length;
  const running = testCases.filter((tc) => tc.status === 'running').length;

  if (testCases.length === 0) return null;

  return (
    <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-3">
      <div className="grid grid-cols-4 gap-1 text-center">
        <div>
          <div className="text-sm font-bold text-text-primary">{testCases.length}</div>
          <div className="text-2xs text-text-muted">Total</div>
        </div>
        <div>
          <div className="text-sm font-bold text-success">{passed}</div>
          <div className="text-2xs text-text-muted">Passed</div>
        </div>
        <div>
          <div className="text-sm font-bold text-error">{failed}</div>
          <div className="text-2xs text-text-muted">Failed</div>
        </div>
        <div>
          <div className="text-sm font-bold text-text-muted">{pending + running}</div>
          <div className="text-2xs text-text-muted">Pending</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {isRunning ? (
          <Button
            variant="danger"
            icon={<Square size={11} />}
            onClick={() => sendToBackground({ type: 'STOP_TESTS' })}
          >
            Stop Execution
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<Play size={11} />}
            onClick={onRunAll}
            disabled={testCases.length === 0}
          >
            Run Pending
          </Button>
        )}
        <Button
          variant={hasFailures ? 'secondary' : 'ghost'}
          icon={<RefreshCw size={11} />}
          onClick={onRerunAll}
          disabled={isRunning || testCases.length === 0}
        >
          Rerun All
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant={selectedCount > 0 ? 'success' : 'ghost'}
          icon={<PackageOpen size={11} />}
          onClick={onRunSelected}
          disabled={isRunning || selectedCount === 0}
        >
          {selectedCount > 0 ? `Run Selected (${selectedCount})` : 'Run Selected'}
        </Button>
        <Button
          variant={hasFailures ? 'danger' : 'ghost'}
          icon={<RefreshCw size={11} />}
          onClick={onRunFailed}
          disabled={isRunning || !hasFailures}
        >
          Rerun Failed
        </Button>
      </div>

      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<RotateCcw size={11} />}
          onClick={onClear}
          disabled={isRunning}
          title="Reset test results"
        />
        <Button
          variant="ghost"
          size="sm"
          icon={<PackageOpen size={11} />}
          onClick={store.exportPlans}
          disabled={isRunning || testCases.length === 0}
          title="Export plans for CLI runner"
        />
      </div>

      <div className="space-y-1">
        <label className="text-2xs text-text-muted font-medium">Run against URL (optional)</label>
        <input
          type="url"
          className="w-full text-xs bg-surface-1 border border-border rounded px-2 py-1 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-primary"
          placeholder="https://staging.example.com"
          value={store.targetOrigin}
          onChange={(e) => store.setTargetOrigin(e.target.value)}
          disabled={isRunning}
          title="Override the explored origin — tests will run against this URL instead"
        />
      </div>
    </div>
  );
}
