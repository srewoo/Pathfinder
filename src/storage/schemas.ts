import type { InferredSchema } from '../core/analysis/schema-infer';
import type { DataSet } from '../core/test-gen/dataset';

export type AIProvider = 'openai' | 'anthropic' | 'google';
export type Theme = 'dark' | 'light';

export type PlanningMode = 'single-shot' | 'interactive' | 'auto';

/** Test personality presets that control AI test generation strategy and tone. */
export type TestPersonalityId =
  | 'balanced'
  | 'happy_path'
  | 'aggressive_edge'
  | 'security_focused'
  | 'accessibility_first'
  | 'performance_minded'
  | 'custom';

export interface Settings {
  provider: AIProvider;
  apiKey: string;
  model: string;
  embeddingModel: string;
  maxExplorationDepth: number;
  maxCrawlPages: number;
  theme: Theme;
  /** Use local Transformers.js model (all-MiniLM-L6-v2) instead of API for embeddings. */
  useLocalEmbeddings: boolean;
  /** Number of tests to run concurrently (each in its own tab). Default 1 = sequential. */
  testConcurrency: number;
  /** Use vision LLM to describe images found in crawled pages. Adds AI cost per image. */
  describeImages: boolean;
  /**
   * When true, use AI to rank which elements to explore on each page (1 extra AI call/page).
   * Produces higher-quality exploration graphs. Default true.
   */
  agentMode: boolean;
  /**
   * Planning strategy for test step generation.
   * - 'auto': interactive first, falls back to single-shot on retry (default)
   * - 'interactive': walk the app live step-by-step before generating the plan
   * - 'single-shot': generate all steps from a single DOM snapshot (fastest)
   */
  planningMode: PlanningMode;
  /** Webhook configuration for CI/CD integration */
  webhook?: WebhookConfig;
  /**
   * Test generation personality — controls AI tone, temperature, and test type emphasis.
   * Default 'balanced'. Use 'custom' with customPersonalityPrompt for free-text override.
   */
  testPersonality?: TestPersonalityId;
  /** Free-text personality description when testPersonality is 'custom'. */
  customPersonalityPrompt?: string;
  /**
   * Retain redacted response bodies for 24h to debug contract findings (ADR 001 phase 4).
   *
   * Off by default. Schemas alone drive baseline diffing; bodies are only for a human
   * inspecting why a check fired. Values are redacted before storage and never included
   * in an export.
   */
  retainResponseBodies?: boolean;
  /**
   * TestRail credentials.
   *
   * Stored in chrome.storage.local like the AI key, and used only against the
   * user's own TestRail host — ADR-002 holds, nothing is proxied.
   */
  testrail?: {
    host: string;
    email: string;
    apiKey: string;
    /** Remembered so pushing results does not re-ask for the run. */
    lastRunId?: number;
  };
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
  /** Hash of extracted text content — used for change detection on re-crawl. */
  contentHash: string;
  /** HTTP ETag from the last fetch — sent as If-None-Match to get a 304 on re-crawl. */
  etag?: string;
  /** HTTP Last-Modified from the last fetch — sent as If-Modified-Since on re-crawl. */
  lastModified?: string;
  /** Same-origin outlinks discovered last crawl — keeps BFS complete when a page returns 304 (no body to re-parse). */
  links?: string[];
}

/**
 * A single form field captured from a page during exploration.
 * Used to generate grounded negative / edge-case tests.
 */
export interface FormField {
  selector: string;
  label?: string;
  /** input type, "select", or "textarea" */
  type: string;
  name?: string;
  placeholder?: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  /** For number / date inputs */
  min?: string;
  max?: string;
  /** HTML pattern attribute value */
  pattern?: string;
  /** Visible option labels for <select> and radio groups */
  options?: string[];
  /**
   * Conditional visibility — this field is only visible when another field has a specific value.
   * Discovered during exploration by toggling select/radio fields and observing DOM changes.
   */
  visibleWhen?: { fieldSelector: string; fieldValue: string };
}

/** Multi-step wizard/stepper form detected on a page */
export interface WizardStep {
  /** Step label (e.g. "Personal Info", "Payment Details") */
  label: string;
  /** Step number (1-based) */
  stepNumber: number;
  /** Total steps in the wizard */
  totalSteps: number;
  /** Selector of the step indicator element */
  selector?: string;
  /** Whether this step is currently active */
  isActive: boolean;
}

/** A modal/dialog discovered when a button was clicked during exploration */
export interface ModalDiscovery {
  /** Selector of the button that triggered the modal */
  triggerSelector: string;
  /** Button text */
  triggerLabel: string;
  /** Title or heading found inside the modal */
  title?: string;
  /** Form fields found inside the modal */
  formFields?: FormField[];
  /** Key text content visible in the modal (truncated) */
  content?: string;
  /** Outcome observed when the modal form was submitted during exploration */
  formOutcome?: FormSubmissionOutcome;
}

/** Maps a specific form field to the error observed for it during form submission */
export interface FieldError {
  /** Selector of the form field that caused the error */
  fieldSelector: string;
  /** Label or name of the field for human readability */
  fieldLabel?: string;
  /** Selector of the error message element closest to this field */
  errorSelector: string;
  /** Text content of the error message */
  errorMessage: string;
}

/** Outcome observed when a form was submitted during exploration */
export interface FormSubmissionOutcome {
  /** Selectors of fields that were filled before submission */
  filledFields: string[];
  /** CSS selector of the submit trigger (button, Enter key, etc.) */
  submitSelector: string;
  /** What happened after submission */
  result: 'success' | 'validation_error' | 'navigation' | 'unknown';
  /** URL after submission (if navigation occurred) */
  resultUrl?: string;
  /** Visible text of error/success messages captured after submission */
  resultMessage?: string;
  /** Selectors of error message elements that appeared */
  errorSelectors?: string[];
  /** Per-field error mapping — links specific fields to their error messages */
  fieldErrors?: FieldError[];
}

/** A clickable action (button/link) available on a page */
export interface PageAction {
  /** CSS selector */
  selector: string;
  /** Visible text of the element */
  label: string;
  /** Element tag: button, a, etc. */
  tag: string;
  /** ARIA role if present */
  role?: string;
  /** Semantic type: navigation, action, toggle, menu, external */
  kind: 'navigation' | 'action' | 'toggle' | 'menu' | 'external';
}

/**
 * What became available once something was selected.
 *
 * Bulk actions are usually the highest-consequence controls on a list page and
 * they do not exist until a row is checked, so nothing that only reads the
 * initial DOM can find them.
 */
export interface SelectionDiscovery {
  /** Selector of the checkbox/toggle that was clicked. */
  triggerSelector: string;
  /** Human label for the trigger (aria-label, nearby text, or the selector). */
  triggerLabel: string;
  /** Controls that appeared only after selection. */
  revealedActions: PageAction[];
  /**
   * Whether the toggle was successfully returned to its original state.
   *
   * Recorded rather than assumed: a page left with rows selected changes what
   * every later step on that page does, and a reader needs to know when that
   * happened instead of inferring it from odd downstream results.
   */
  resetOk: boolean;
}

/** A data table or list discovered on a page */
export interface DataTable {
  /** CSS selector of the table or list container */
  selector: string;
  /** Column headers (for <table>) or list item pattern (for <ul>/<ol>) */
  columns?: string[];
  /** Approximate visible row/item count */
  rowCount: number;
  /** Action buttons found inside rows (e.g. Edit, Delete, View) */
  rowActions?: string[];
  /** Whether pagination controls are present */
  hasPagination: boolean;
  /** Whether sort controls are present */
  hasSorting: boolean;
  /** Whether filter/search controls are present */
  hasFiltering: boolean;
}

/** API endpoint observed during page load or form submission */
export interface ObservedAPI {
  /** API endpoint URL (without query params for dedup) */
  endpoint: string;
  /** HTTP method */
  method: string;
  /** Response status code */
  status: number;
  /** Request content type (e.g. application/json) */
  requestContentType?: string;
  /** Response content type */
  responseContentType?: string;
  /** Whether this was triggered during form submission vs. page load */
  context: 'page_load' | 'form_submit' | 'click_action';
}

/** Classification of a page based on its DOM structure and content */
export type PageType =
  | 'list'       // data table, card grid, list view
  | 'detail'     // single-record view, profile page
  | 'form'       // page primarily for data entry
  | 'dashboard'  // charts, stats, overview widgets
  | 'settings'   // configuration/preferences page
  | 'auth'       // login, register, forgot password
  | 'error'      // 404, 500, error pages
  | 'empty'      // blank or "no data" state
  | 'other';     // doesn't fit any specific category

/**
 * A frame on a page whose contents the scan could not reach.
 *
 * Same-origin frames are walked as part of the page, so they never appear here.
 * A cross-origin frame cannot be — the browser refuses `contentDocument`, and
 * reaching in would need per-frame injection and frame-aware routing through
 * the whole messaging layer, which still would not cover a third-party widget
 * the extension has no host permission for.
 *
 * Recording the gap is the point: coverage that silently omits a payment or
 * sign-in iframe is a wrong number, and one that names it is a caveat.
 */
export interface UnscannedFrame {
  /** Origin taken from the embedder's own `src` attribute, when it has one. */
  origin?: string;
  /** Whatever the embedder labelled it — title, aria-label, name or id. */
  label?: string;
  /** Rendered size, so a report can say how much of the page this is. */
  width: number;
  height: number;
  reason: 'cross-origin';
}

export interface PageNode {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
  elementCount: number;
  /**
   * Fingerprint of the page's interactive structure (element selectors + form
   * field signatures). On a fresh re-scan, an unchanged fingerprint lets the
   * explorer skip the expensive click/modal/form interaction for that page.
   */
  structureHash?: string;
  /**
   * Normalized URL pattern with dynamic segments replaced by `:param`.
   * e.g. "/assets/all-assets-list/asset/:param" — signals this node
   * represents one instance of a parameterized route template.
   */
  urlPattern?: string;
  /** Breadcrumb path discovered on the page (e.g. "Home > Settings > Users") */
  breadcrumb?: string;
  /** Key headings on the page (h1/h2) for structural context */
  headings?: string[];
  /** Modals/dialogs discovered by clicking buttons on this page */
  modals?: ModalDiscovery[];
  /**
   * Forms revealed in place by a click — no dialog, no navigation.
   *
   * The pattern this exists for, measured on a live login page: "Sign in with
   * your username" swaps the username/password fields into the page. The URL
   * does not change and no dialog opens, so neither the modal nor the
   * navigation branch sees it, and the one-shot form scan runs before any click
   * — so the fields were invisible to test generation, which then invented a
   * "username input field" it had never observed.
   *
   * Shares `ModalDiscovery` because the useful content is identical: the
   * trigger, and the fields it brings into existence. A test has to click the
   * trigger before it can type anything.
   */
  revealedForms?: ModalDiscovery[];
  /**
   * True once the click/interaction pass ran this page to completion.
   *
   * The structure fingerprint is computed from the pre-click scan, so it is
   * identical whether or not the page's modals and revealed forms were ever
   * captured. Without this flag, a page whose interaction pass was cut short —
   * by the page budget, an abort, or an error — stored a fingerprint anyway and
   * was then treated as "unchanged" on every later run, keeping the shortfall
   * permanently. A fingerprint only licenses a skip when there was nothing left
   * to do behind it.
   */
  interactionComplete?: boolean;
  /**
   * Frames on this page that the scan could not see into.
   *
   * Present so coverage is not overstated: everything else on a `PageNode`
   * describes what *was* found, and without this a page whose entire checkout
   * lives in a third-party iframe looks as thoroughly mapped as one with
   * nothing hidden at all.
   */
  unscannedFrames?: UnscannedFrame[];
  /** Form fields discovered on this page during exploration */
  formFields?: FormField[];
  /** Outcomes observed when forms on this page were submitted during exploration */
  formOutcomes?: FormSubmissionOutcome[];
  /** Classified page type based on DOM heuristics */
  pageType?: PageType;
  /** Clickable actions available on this page (buttons, links with meaningful labels) */
  actions?: PageAction[];
  /** Data tables or lists found on this page */
  dataTables?: DataTable[];
  /** Bulk-action toolbars discovered by selecting rows on this page */
  selectionActions?: SelectionDiscovery[];
  /** API endpoints observed during page load */
  apiEndpoints?: ObservedAPI[];
  /** Whether this page appears to be an error page (404, 500, etc.) */
  isErrorPage?: boolean;
  /** HTTP status code if detected (e.g. from meta tags or error patterns) */
  httpStatus?: number;
  /** Page load time in ms observed during exploration (navigation → DOM idle) */
  loadTimeMs?: number;
  /**
   * Full-page screenshot (base64 PNG data URL) captured during exploration when
   * `captureScreenshots` is enabled. Lets a human visually verify the mapped
   * page. Opt-in because storing one per node is storage-heavy.
   */
  screenshot?: string;
  /** Multi-step wizard/stepper form detected on this page */
  wizardSteps?: WizardStep[];
  /**
   * In-page views/tabs discovered on this page — clicks that change only the
   * URL query/hash (e.g. `?aiFeatureTab=overview`) rather than navigating to a
   * new page. These represent feature tabs/panels and are surfaced to flow
   * learning so it can generate a flow per feature.
   */
  tabs?: Array<{
    label: string;
    url: string;
    /**
     * Form fields inside the view, captured while the tab was open.
     *
     * The tab used to be catalogued as a label and a URL and nothing else — the
     * explorer opened it, recorded that it existed, and navigated straight back
     * out. A settings page with six tabs therefore yielded six labels and none
     * of their forms, and generation could only ever produce "open the tab and
     * verify it loads".
     */
    formFields?: FormField[];
    /** Interactive elements counted inside the view. */
    elementCount?: number;
    /** Headings inside the view — what the tab is actually for. */
    headings?: string[];
  }>;
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

/** A point-in-time snapshot of the interaction graph for version history. */
export interface GraphSnapshot {
  id: string;
  graph: InteractionGraph;
  savedAt: string;
  nodeCount: number;
  edgeCount: number;
  /** Optional human-readable label (e.g. "before re-explore", "v2 with modals"). */
  label?: string;
}

export interface FlowStep {
  order: number;
  action: string;
  target?: string;
  value?: string;
  description: string;
  /** CSS selector discovered during exploration — grounds the step to a real DOM element */
  selector?: string;
  /** Expected outcome of this step (e.g. "success message visible", "validation error shown") */
  expectedOutcome?: string;
}

export interface StartUrlInference {
  method: 'navigate_step' | 'edge_match' | 'node_match';
  confidence: 'high' | 'medium' | 'low';
  score: number;
  reason: string;
}

/**
 * Test-design coverage category a flow targets. Drives the Phase-2 coverage
 * matrix (a feature isn't "covered" until its happy + relevant negative paths
 * exist) and lets test generation map a flow to a TestCase.type.
 */
export type FlowCoverageType =
  | 'happy'        // primary success path
  | 'validation'   // required-field / format validation error path
  | 'boundary'     // min/max/length/pattern edge values
  | 'empty'        // empty / no-data state
  | 'navigation'   // multi-hop journey between pages
  | 'exploratory'; // open a feature/tab/modal and verify it renders

/** A documentation chunk a flow was grounded against (Phase-2 per-flow RAG). */
export interface KnowledgeRef {
  /** Source document URL. */
  url: string;
  /** Section / heading the chunk came from, if known. */
  section?: string;
  /** Hybrid retrieval score (semantic + keyword), 0–1. */
  score: number;
  /** Short snippet of the grounding text (truncated). */
  snippet?: string;
}

export interface Flow {
  flowId: string;
  name: string;
  description: string;
  steps: FlowStep[];
  /** Deterministic starting page inferred from the exploration graph. */
  startUrl?: string;
  /** Why pathfinder picked this start URL from exploration data. */
  startUrlInference?: StartUrlInference;
  source: 'exploration' | 'documentation' | 'hybrid';
  /** Test-design coverage category this flow targets (Phase-2 coverage matrix). */
  coverageType?: FlowCoverageType;
  /** Documentation chunks this flow was grounded against (Phase-2 per-flow RAG). */
  knowledgeRefs?: KnowledgeRef[];
  /**
   * Stable, content-derived identity (hash of the step signature). Used to
   * reconcile flows across re-learns: a flow whose signature already exists is
   * updated in place (keeping its flowId, so linked test cases stay attached)
   * rather than duplicated. (Phase-3 reconcile.)
   */
  signature?: string;
  /**
   * Set when a re-learn no longer produces this flow's signature — i.e. the
   * feature it covered appears to have been removed from the app. Reversible:
   * cleared automatically if the flow reappears on a later re-learn. User- and
   * documentation-authored flows are never marked stale.
   */
  stale?: boolean;
  /** ISO timestamp when this flow was first marked stale. */
  staleSince?: string;
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
  /** Captured auth cookies to inject before test execution */
  authCookies?: AuthCookie[];
  /** URL to check for auth status (returns 200 if authenticated, 401/403 if not) */
  authCheckUrl?: string;
  /** CSS selector whose presence on the page indicates "logged in" state */
  authCheckSelector?: string;
  /** CSS selector whose presence indicates "logged out" / session expired */
  logoutIndicatorSelector?: string;
  createdAt: string;
  updatedAt: string;
}

/** Serialized browser cookie for auth state persistence */
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

/**
 * Per-step provenance — how trustworthy a generated step is, surfaced in the UI
 * so users can see which steps are high-fidelity vs. which to review.
 *  - grounded:     built from a DOM selector (or explored URL) captured during
 *                  exploration — highest fidelity.
 *  - doc_asserted: an assertion whose expected outcome is grounded in crawled docs.
 *  - inferred:     AI-suggested; the selector is validated against the live page
 *                  and self-healed at run time, but wasn't captured up front.
 */
export type StepConfidence = 'grounded' | 'doc_asserted' | 'inferred';

export interface TestCase {
  id: string;
  title: string;
  description: string;
  type: 'positive' | 'negative' | 'edge';
  sourceFlowId?: string;
  /**
   * The source flow's `signature` at the moment this test was generated.
   *
   * Lets a passing run be checked against the flow as it stands now: if the
   * flow has since been re-learnt into a different shape, the run exercised
   * something else and its result must stop counting as validation of this
   * flow. Without it, the most reassuring label in the product is the one most
   * likely to be out of date. Absent on user-authored and legacy tests.
   */
  flowSignature?: string;
  source: 'generated' | 'user';
  steps?: string[];
  /** Provenance per step, aligned by index with `steps`. Optional — absent for legacy/user tests. */
  stepConfidence?: StepConfidence[];
  /**
   * Deterministic execution plan built from selectors captured during
   * exploration. When present, the planner runs these steps verbatim (no LLM)
   * on the first attempt — the strongest CDP-executability guarantee — only
   * re-deriving via the LLM if they fail and a fresh plan is requested.
   * Set only when every step maps to a concrete executable step.
   */
  preplan?: ExecutionStep[];
  executionPresetId?: string;
  executionPresetName?: string;
  personaLabel?: string;
  requiresAuthenticatedSession?: boolean;
  setupSteps?: string[];
  setupNotes?: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'error';
  createdAt: string;
  /** URL the test should start from — captured during planning for isolation */
  startUrl?: string;
  /**
   * Data-driven input. When present the test runs once per row, with
   * `{{column}}` in step values resolved from that row.
   *
   * The AI cost of planning is paid once; every additional row is free.
   */
  dataSet?: DataSet;
  /**
   * Excluded from suite runs because the stability gate saw this test produce
   * different outcomes across identical back-to-back runs.
   *
   * Quarantine, not deletion: an unstable test still carries information, and
   * the user decides whether to fix or drop it. Set by the gate, cleared by the
   * user.
   */
  quarantined?: boolean;
}

export type ActionType =
  | 'click'
  | 'double_click' // double-click (edit modes, tree nodes, etc.)
  | 'type'
  | 'navigate'
  | 'wait'
  | 'assert'
  | 'scroll'
  | 'hover'
  | 'select'       // select an option from a <select> or custom dropdown
  | 'check'        // explicitly tick a checkbox or select a radio button
  | 'uncheck'      // explicitly untick a checkbox
  | 'clear'        // clear an input field before typing
  | 'press_key'    // press a keyboard key (Enter, Tab, Escape, Ctrl+A, etc.)
  | 'drag_drop'    // drag source element and drop onto targetSelector
  | 'upload_file'  // set file(s) on an input[type="file"]
  | 'dismiss_dialog' // dismiss JS alert/confirm/prompt dialogs
  | 'if_visible'   // conditional: run nested step only if selector is visible
  | 'loop'         // repeat nested steps N times
  | 'capture_value' // capture text/value from element into named variable
  | 'use_captured'; // substitute captured variable into value field

export type AssertType =
  | 'visible'
  | 'not_visible'
  | 'text'
  | 'not_text'
  | 'url'
  | 'count'
  | 'exact_count'  // exact match instead of >=
  | 'enabled'
  | 'disabled'
  | 'value'        // input value equals expected
  | 'attribute'    // element attribute equals expected
  | 'exists'       // element is in DOM (may be hidden)
  | 'not_exists'   // element is absent from DOM
  // ── Network / API oracles (evaluated against captured HAR, CDP mode) ──
  | 'api_called'      // an API request matching the spec was observed
  | 'api_not_called'  // NO API request matched the spec (e.g. no error endpoint hit)
  | 'api_status';     // a matching API request returned the expected status (e.g. "POST /api/login 200")

export interface ExecutionStep {
  order: number;
  action: ActionType;
  selector?: string;
  value?: string;
  timeout?: number;
  description: string;
  assertType?: AssertType;
  assertExpected?: string;
  /** For press_key action: key name, e.g. 'Enter', 'Tab', 'Escape' */
  key?: string;
  /** For attribute assertion: the attribute name to check */
  attribute?: string;
  /** For drag_drop action: CSS selector of the drop target element */
  targetSelector?: string;
  /** For if_visible: nested step to execute when condition is met */
  thenStep?: ExecutionStep;
  /** For if_visible: nested step to execute when condition is NOT met */
  elseStep?: ExecutionStep;
  /** For loop: number of iterations */
  loopCount?: number;
  /** For loop: nested steps to repeat */
  loopSteps?: ExecutionStep[];
  /** For capture_value: variable name to store the captured value */
  captureName?: string;
  /** For capture_value: what to capture — 'text', 'value', or 'attribute' */
  captureSource?: 'text' | 'value' | 'attribute';
}

export interface ExecutionPlan {
  id: string;
  testCaseId: string;
  testCaseHash: string;
  steps: ExecutionStep[];
  cachedAt: string;
}

export interface HealingAttempt {
  stepOrder: number;
  originalSelector: string;
  /**
   * `visual` is the vision-model tier: it reads the screenshot captured at the
   * moment of failure rather than the DOM, which is the only way to resolve an
   * icon-only control or a canvas-rendered widget.
   */
  method: 'alternative' | 'similarity' | 'ai' | 'visual';
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
  /** Base64 PNG screenshot captured at the moment of step failure. */
  screenshot?: string;
  /**
   * Whether this step's target was backed by capture when the test was authored.
   *
   * `false` means exploration never recorded the element, so a failure here is
   * more likely a generation gap than a product defect. Absent on records
   * written before grounding was tracked — unknown, deliberately not assumed.
   */
  groundedAtAuthoring?: boolean;
}

/** Network request captured during test execution via CDP */
export interface CapturedNetworkEntry {
  url: string;
  method: string;
  status: number;
  statusText: string;
  mimeType: string;
  duration: number;
  bodySize: number;
  /**
   * Request body, when the browser captured one (10KB cap).
   *
   * Already captured in memory by the CDP client and previously dropped at this
   * boundary. Kept now because GraphQL endpoint identity depends on it — every
   * operation shares one URL, so `operationName` is the only way to tell them apart.
   */
  requestBody?: string;
  /**
   * Structure of the response body — NOT the body itself (ADR 001).
   *
   * Storing the shape instead of the payload is what makes baseline diffing safe to
   * ship: a schema holds no tokens, emails or salaries, is a few hundred bytes for a
   * 400KB list, and only changes when the contract changes. Two bodies differ on every
   * run through ids and timestamps.
   */
  responseSchema?: InferredSchema;
}


/**
 * One attempt at running a test.
 *
 * The retry ladder makes up to three attempts and returned only the last one,
 * so a test that failed twice and passed on the third was indistinguishable
 * from one that passed first time — the single most useful signal about a
 * flaky test was computed and then thrown away.
 *
 * Deliberately carries no screenshot or DOM snapshot. Those are large, and
 * three copies of near-identical evidence per test is how a result store
 * becomes unusable; the final result keeps the one that matters, and the
 * failure text plus the failing step order is what makes an earlier attempt
 * interpretable.
 */
export interface AttemptRecord {
  /** 0-based, matching the retry ladder. */
  attempt: number;
  status: 'passed' | 'failed' | 'error';
  durationMs: number;
  /** Why it failed, already redacted by the same path as the final result. */
  errorMessage?: string;
  /** Order of the first step that failed, for jumping straight to it. */
  failedStepOrder?: number;
  failedStepError?: string;
  /** Distinct locators healed during this attempt. */
  healedLocators: number;
  /** Whether this attempt replanned from scratch (the selector fix). */
  freshPlan: boolean;
  /** Step-timeout multiplier used (the timing fix). */
  timeoutMultiplier: number;
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
  /**
   * Findings from the state-diff oracles (core/analysis/state-oracles.ts).
   *
   * These are defects the test's own assertions did not necessarily catch — e.g.
   * the UI reported success while the server was never contacted. A test can PASS
   * and still carry findings, which is exactly the point: "no assertion failed" is
   * a weaker statement than "nothing went wrong".
   */
  oracleFindings?: Array<{
    kind: string;
    severity: 'high' | 'medium' | 'low';
    message: string;
    evidence: string;
    stepOrder?: number;
    url?: string;
  }>;
  runId: string;
  /**
   * Screencast frames captured while this test ran, when recording was enabled.
   *
   * Was attached with an `as any` cast and read by nothing: frames were captured,
   * persisted, and unwatchable. Typed here so the player can find them.
   */
  screencastFrames?: Array<{ data: string; timestamp: number; sessionId: number }>;
  /** Network HAR entries captured via CDP during test execution */
  harEntries?: CapturedNetworkEntry[];
  /** Visual diff result when comparing against a baseline screenshot */
  visualDiff?: { diffPercent: number; matches: boolean; diffImage?: string };
  /**
   * Every attempt, in order, when the test needed more than one.
   *
   * Absent for a first-attempt pass and on records written before this was
   * tracked — which is why `retriedToPass` treats absence as "not retried"
   * rather than unknown.
   */
  attempts?: AttemptRecord[];
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
    /** Average execution duration in ms */
    avgDuration?: number;
    /** Number of tests that required healing */
    healedCount?: number;
  };
}

/** Webhook configuration for CI/CD integration */
export interface WebhookConfig {
  url: string;
  /** HTTP headers to include (e.g. Authorization) */
  headers?: Record<string, string>;
  /** Whether to send on every test completion or only on suite completion */
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
  /** Stable CSS classes (filtered to exclude utility classes like Tailwind) */
  classes?: string[];
  /** data-testid or data-test-id attribute */
  testId?: string;
  /** Whether the element is disabled */
  disabled?: boolean;
  /** name attribute for form elements */
  name?: string;
  /** Whether this is a contenteditable element */
  contentEditable?: boolean;
  /**
   * `href` for anchors, absolute where the browser resolved it.
   *
   * Carried so a link can be judged by where it GOES, not only by what it says.
   * A `<a href="/logout"><i class="icon"></i></a>` has no text and no label; the
   * URL is the only thing that reveals it ends the session.
   */
  href?: string;
  /**
   * True when this element is the representative click target for a clickable
   * table/grid row — the way list pages reach a record's detail page.
   *
   * One per row, not one per cell: a measured page had 450 pointer-cursor cells
   * that were really 50 rows × 9 cells, and the rows carried no `<a href>` at all,
   * so nothing but a click could discover the destination.
   */
  rowNavigation?: boolean;
  /**
   * Class tokens of icons inside this element (e.g. `bi-trash`, `fa-pencil`).
   *
   * The only signal available for an icon-only control. A `<button>` whose sole
   * content is `<i class="oxd-icon bi-trash">` has no text, no aria-label and no
   * title, so a text-based danger check is blind to it — on a real app, 50 delete
   * buttons per page looked identical to 50 harmless ones.
   */
  iconClasses?: string[];
  /**
   * The element's tabindex, when it has one.
   *
   * A design-system dropdown is often a `<div tabindex="0">` with no role. It is
   * focusable and clickable for a user, so tabindex is what distinguishes it from
   * decorative markup.
   */
  tabIndex?: number;
  /**
   * True when the element sits inside a table/grid/list region.
   *
   * Used to tell a row-selection checkbox (safe to toggle — it changes only
   * client-side selection) apart from a settings toggle (which often persists
   * immediately via PATCH). The two look identical in the DOM otherwise.
   */
  inDataRegion?: boolean;
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
  /** Pages skipped because their content hash matched the stored version. */
  skipped: number;
  currentUrl: string;
  status: 'crawling' | 'embedding' | 'done' | 'error';
  error?: string;
}

/** Event emitted during crawling for error reporting and observability. */
export interface CrawlEvent {
  type: 'error' | 'warning' | 'info';
  url: string;
  message: string;
  timestamp: string;
  /** Optional error code for programmatic handling */
  code?: 'fetch_failed' | 'pdf_extraction_failed' | 'embed_failed' | 'robots_blocked' | 'render_failed' | 'timeout';
}

export interface ExplorationProgress {
  pagesVisited: number;
  elementsFound: number;
  edgesRecorded: number;
  currentPage: string;
  status: 'running' | 'paused' | 'done' | 'error';
  error?: string;
  /**
   * Coverage snapshot — populated live during the run and finalised on
   * completion. Lets the UI show real coverage rather than raw visit counts,
   * and distinguishes "we scanned an empty page" from "the scan failed".
   */
  coverage?: ExplorationCoverage;
}

/**
 * Coverage/health summary for an exploration run. Answers the questions the
 * product promises ("find untested paths", "broken links") with concrete
 * numbers instead of raw counts.
 */
export interface ExplorationCoverage {
  /** Pages the crawler attempted (dequeued and navigated to). */
  pagesAttempted: number;
  /** Pages whose DOM was successfully read (content script responded). */
  pagesScanned: number;
  /**
   * Pages that failed to scan — content script never responded, navigation
   * failed, or the page errored. These are NOT the same as empty pages.
   */
  pagesFailed: number;
  /**
   * Destination URLs that were discovered (recorded as edges) but never
   * crawled — capped out by depth, page limit, run budget, or a saturated URL
   * pattern. These are the "untested paths" the product surfaces.
   */
  untestedPaths: number;
  /** Distinct broken links found (edges whose destination returned an error page / 4xx-5xx). */
  brokenLinks: number;
  /**
   * Coverage ratio in [0,1], interpreted relative to the run's SCOPE:
   *  · crawl runs ("from here" / "whole app"): mappedPages / (mappedPages +
   *    untestedPaths) — how much of everything discovered was actually mapped.
   *  · single-page runs ("this page only"): pagesScanned / pagesAttempted — the
   *    anchored page is the whole intended scope, so a clean run is 1.0 and the
   *    links it found are reported as `untestedPaths` (a next-step hint), not a
   *    coverage deduction.
   */
  coverageRatio: number;
  /**
   * RISK-WEIGHTED coverage in [0,1].
   *
   * `coverageRatio` above is self-referential — it measures how much of what the
   * crawler discovered it went on to visit, so an explorer that finds one page and
   * visits it scores 1.0. This weights pages by the risk they carry (forms,
   * required and sensitive fields, observed mutating endpoints, wizards, auth
   * gating), so skipping a checkout page costs far more than skipping an about
   * page. See core/explorer/risk-coverage.ts.
   */
  riskCoverageRatio?: number;
  /** Unexplored pages carrying above-average risk. The actionable number. */
  highRiskGaps?: number;
  /**
   * True when the run was scoped to a single page (no link following). Signals
   * consumers that `coverageRatio` measures only the anchored page and that
   * `untestedPaths` are discovered-but-out-of-scope links, not gaps.
   */
  singlePage: boolean;
  /**
   * Whether the run finished naturally (queue drained) vs. was truncated by a
   * limit or stopped. A truncated run's coverage is a floor, not the total.
   */
  complete: boolean;
  /**
   * What this run structurally could not cover, as opposed to what it ran out
   * of budget for.
   *
   * `untestedPaths` and `coverageRatio` describe work that was skipped and
   * could be resumed. This describes work that no resume will reach, so the two
   * must not be added together or a limitation reads as a backlog. Absent when
   * the run hit no such limit.
   */
  unsupported?: {
    /**
     * Cross-origin frames — third-party sign-in, payment and consent widgets.
     *
     * Same-origin frames are NOT counted: those are walked as part of the page.
     * Reaching into a cross-origin one would need per-frame injection, frame-
     * aware routing, and a host permission the extension does not have in the
     * general case — so this is reported, not queued.
     */
    crossOriginFrames?: {
      /** Frames found across the run. */
      frames: number;
      /** Pages carrying at least one. The denominator that makes it readable. */
      pages: number;
    };
  };
  /**
   * Human-readable warnings surfaced during the run (scan failures, form
   * exploration errors, auth issues). Empty when the run was clean.
   */
  warnings: string[];
}
