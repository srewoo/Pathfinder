export type AIProvider = 'openai' | 'anthropic' | 'google';
export type Theme = 'dark' | 'light';

export interface Settings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  embeddingModel: string;
  maxExplorationDepth: number;
  maxCrawlPages: number;
  theme: Theme;
  useLocalEmbeddings: boolean;
  testConcurrency: number;
  describeImages: boolean;
  webhook?: WebhookConfig;
}

export interface VectorRecord {
  id: string;
  content: string;
  url: string;
  embedding: number[];
  metadata: {
    title: string;
    section: string;
    breadcrumbPath?: string;
    crawledAt: string;
    chunkIndex: number;
    totalChunks: number;
    embeddingModel?: string;
  };
}

export interface CrawledDocument {
  id: string;
  url: string;
  title: string;
  content: string;
  crawledAt: string;
  chunkCount: number;
  contentHash: string;
}

export interface FormField {
  selector: string;
  label?: string;
  type: string;
  name?: string;
  placeholder?: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
  options?: string[];
}

export interface ModalDiscovery {
  triggerSelector: string;
  triggerLabel: string;
  title?: string;
  formFields?: FormField[];
  content?: string;
}

export interface FormSubmissionOutcome {
  filledFields: string[];
  submitSelector: string;
  result: 'success' | 'validation_error' | 'navigation' | 'unknown';
  resultUrl?: string;
  resultMessage?: string;
  errorSelectors?: string[];
}

export interface PageNode {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
  elementCount: number;
  breadcrumb?: string;
  headings?: string[];
  modals?: ModalDiscovery[];
  formFields?: FormField[];
  formOutcomes?: FormSubmissionOutcome[];
}

export interface PageEdge {
  from: string;
  to: string;
  action: string;
  selector: string;
  label: string;
}

export interface InteractionGraph {
  nodes: PageNode[];
  edges: PageEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface FlowStep {
  order: number;
  action: string;
  target?: string;
  value?: string;
  description: string;
  selector?: string;
  expectedOutcome?: string;
}

export interface StartUrlInference {
  method: 'navigate_step' | 'edge_match' | 'node_match';
  confidence: 'high' | 'medium' | 'low';
  score: number;
  reason: string;
}

export interface Flow {
  flowId: string;
  name: string;
  description: string;
  steps: FlowStep[];
  startUrl?: string;
  startUrlInference?: StartUrlInference;
  source: 'exploration' | 'documentation' | 'hybrid';
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionPreset {
  id: string;
  name: string;
  description?: string;
  personaLabel?: string;
  startUrl?: string;
  requiresAuthenticatedSession: boolean;
  setupSteps?: string[];
  setupNotes?: string;
  authCookies?: AuthCookie[];
  authCheckUrl?: string;
  authCheckSelector?: string;
  logoutIndicatorSelector?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  expirationDate?: number;
}

export interface TestCase {
  id: string;
  title: string;
  description: string;
  type: 'positive' | 'negative' | 'edge';
  sourceFlowId?: string;
  source: 'generated' | 'user';
  steps?: string[];
  executionPresetId?: string;
  executionPresetName?: string;
  personaLabel?: string;
  requiresAuthenticatedSession?: boolean;
  setupSteps?: string[];
  setupNotes?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error';
  createdAt: string;
  startUrl?: string;
}

export type ActionType =
  | 'click'
  | 'double_click'
  | 'type'
  | 'navigate'
  | 'wait'
  | 'assert'
  | 'scroll'
  | 'hover'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'clear'
  | 'press_key'
  | 'drag_drop'
  | 'upload_file'
  | 'dismiss_dialog'
  | 'switch_tab'
  | 'if_visible'
  | 'loop'
  | 'capture_value'
  | 'use_captured';

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
  targetSelector?: string;
  thenStep?: ExecutionStep;
  elseStep?: ExecutionStep;
  loopCount?: number;
  loopSteps?: ExecutionStep[];
  captureName?: string;
  captureSource?: 'text' | 'value' | 'attribute';
}

export interface ExecutionPlan {
  id: string;
  testCaseId: string;
  testCaseHash: string;
  steps: ExecutionStep[];
  cachedAt: string;
  /** Set when a test run using this plan passed. Verified plans never expire from cache. */
  verifiedAt?: string;
}

export interface HealingAttempt {
  stepOrder: number;
  originalSelector: string;
  method: 'alternative' | 'similarity' | 'ai';
  healedSelector?: string;
  success: boolean;
  error?: string;
}

export interface StepResult {
  step: ExecutionStep;
  status: 'passed' | 'failed' | 'skipped';
  duration: number;
  error?: string;
  healingAttempt?: HealingAttempt;
  screenshot?: string;
}

export interface CapturedNetworkEntry {
  url: string;
  method: string;
  status: number;
  statusText: string;
  mimeType: string;
  duration: number;
  bodySize: number;
}

export interface TestResult {
  id: string;
  testCaseId: string;
  testCaseTitle: string;
  status: 'passed' | 'failed' | 'error' | 'running';
  startedAt: string;
  completedAt?: string;
  duration?: number;
  steps: StepResult[];
  screenshot?: string;
  errorMessage?: string;
  domSnapshot?: string;
  healingAttempts: HealingAttempt[];
  runId: string;
  harEntries?: CapturedNetworkEntry[];
  visualDiff?: { diffPercent: number; matches: boolean; diffImage?: string };
}

export interface TestRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  testCaseIds: string[];
  results: TestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    error: number;
    avgDuration?: number;
    healedCount?: number;
  };
}

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  trigger: 'test_complete' | 'suite_complete' | 'both';
  enabled: boolean;
}

export interface InteractiveElement {
  selector: string;
  tag: string;
  type?: string;
  text?: string;
  ariaLabel?: string;
  role?: string;
  classes?: string[];
  testId?: string;
  disabled?: boolean;
  name?: string;
  contentEditable?: boolean;
  visible: boolean;
  position: { x: number; y: number; width: number; height: number };
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: InteractiveElement[];
  domCompressed: string;
  capturedAt: string;
}

export interface CrawlProgress {
  total: number;
  crawled: number;
  embedded: number;
  skipped: number;
  currentUrl: string;
  status: 'crawling' | 'embedding' | 'done' | 'error';
  error?: string;
}

export interface ExplorationProgress {
  pagesVisited: number;
  elementsFound: number;
  edgesRecorded: number;
  currentPage: string;
  status: 'running' | 'paused' | 'done' | 'error';
  error?: string;
}
