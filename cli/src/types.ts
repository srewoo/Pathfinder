// Mirror of extension schemas needed by CLI
export type ActionType =
  | 'click'
  | 'type'
  | 'navigate'
  | 'wait'
  | 'assert'
  | 'scroll'
  | 'hover'
  | 'select'
  | 'clear'
  | 'press_key';

export type AssertType =
  | 'visible'
  | 'not_visible'
  | 'text'
  | 'not_text'
  | 'url'
  | 'count'
  | 'exact_count'
  | 'enabled'
  | 'disabled'
  | 'value'
  | 'attribute'
  | 'exists'
  | 'not_exists';

export interface ExecutionStep {
  order: number;
  action: ActionType;
  selector?: string;
  value?: string;
  timeout?: number;
  description: string;
  assertType?: AssertType;
  assertExpected?: string;
  key?: string;
  attribute?: string;
}

export interface TestCase {
  id: string;
  title: string;
  description: string;
  type: 'positive' | 'negative' | 'edge';
  status: string;
  startUrl?: string;
  createdAt: string;
}

export interface StepResult {
  step: ExecutionStep;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
}

export interface TestResult {
  id: string;
  testCaseId: string;
  testCaseTitle: string;
  status: 'passed' | 'failed' | 'error';
  startedAt: string;
  completedAt: string;
  duration: number;
  steps: StepResult[];
  errorMessage?: string;
  runId: string;
}

/** Format exported from the pathfinder extension */
export interface ExportedPlans {
  version: string;
  exportedAt: string;
  baseUrl?: string;
  testCases: TestCase[];
  plans: Record<string, ExecutionStep[]>;
}
