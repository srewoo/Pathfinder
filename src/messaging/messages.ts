import type {
  ExecutionStep,
  InteractiveElement,
  FormField,
  CrawlProgress,
  ExplorationProgress,
  PageSnapshot,
} from '../storage/schemas';

// ─── Background → Content Script messages ───────────────────────────────────

export type ContentScriptMessage =
  | { type: 'EXECUTE_ACTION'; payload: ExecutionStep }
  | { type: 'SCAN_PAGE' }
  | { type: 'GET_DOM_SNAPSHOT' }
  | { type: 'GET_ELEMENTS' }
  | { type: 'GET_FORM_FIELDS' }
  | { type: 'GET_LINKS'; payload: { origin: string } }
  | { type: 'REVEAL_PAGE_CONTENT' }
  | { type: 'WAIT_FOR_IDLE'; settleMs?: number }
  | { type: 'DETECT_FORM_MESSAGES' }
  | { type: 'GET_PAGE_METADATA' }
  | { type: 'DETECT_MODAL' }
  | { type: 'GET_PAGE_ACTIONS' }
  | { type: 'GET_DATA_TABLES' }
  | { type: 'GET_PAGE_TYPE' }
  | { type: 'GET_FIELD_ERRORS' }
  | { type: 'VALIDATE_SELECTORS'; payload: { selectors: string[] } }
  | { type: 'GET_WIZARD_STEPS' }
  | { type: 'GET_CONDITIONAL_FIELDS' }
  | { type: 'PING' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_RECORDED_ACTIONS' }
  | { type: 'DETECT_SPA_ROUTES' };

// ─── Content Script → Background messages ───────────────────────────────────

export type ContentScriptResponse =
  | { type: 'ACTION_RESULT'; success: boolean; error?: string }
  | { type: 'PAGE_SNAPSHOT'; payload: PageSnapshot }
  | { type: 'ELEMENTS'; payload: InteractiveElement[] }
  | { type: 'FORM_FIELDS'; payload: FormField[] }
  | { type: 'LINKS'; payload: Array<{ url: string; text: string }> }
  | { type: 'REVEAL_DONE' }
  | { type: 'IDLE_READY' }
  | { type: 'FORM_MESSAGES'; payload: { hasError: boolean; hasSuccess: boolean; message?: string; selectors?: string[] } }
  | { type: 'PAGE_METADATA'; payload: { breadcrumb?: string; headings: string[] } }
  | { type: 'MODAL_DETECTED'; payload: { found: boolean; title?: string; content?: string; formFields?: import('../storage/schemas').FormField[] } }
  | { type: 'PAGE_ACTIONS'; payload: import('../storage/schemas').PageAction[] }
  | { type: 'DATA_TABLES'; payload: import('../storage/schemas').DataTable[] }
  | { type: 'PAGE_TYPE'; payload: { pageType: import('../storage/schemas').PageType; isErrorPage: boolean; httpStatus?: number } }
  | { type: 'FIELD_ERRORS'; payload: import('../storage/schemas').FieldError[] }
  | { type: 'SELECTOR_VALIDATION'; payload: boolean }
  | { type: 'WIZARD_STEPS'; payload: Array<{ label: string; stepNumber: number; totalSteps: number; selector?: string; isActive: boolean }> }
  | { type: 'CONDITIONAL_FIELDS'; payload: Array<{ fieldSelector: string; triggerSelector: string; triggerValue: string }> }
  | { type: 'PONG' }
  | { type: 'SPA_ROUTES'; payload: { framework: string; routes: string[] } };

// ─── Sidebar / Popup → Background messages ──────────────────────────────────

export type BackgroundMessage =
  | { type: 'START_CRAWL'; payload: { url: string } }
  | { type: 'STOP_CRAWL' }
  | { type: 'START_EXPLORATION'; payload: { depth: number; singlePageOnly?: boolean; includeDangerous?: boolean } }
  | { type: 'STOP_EXPLORATION' }
  | { type: 'STOP_TESTS' }
  | { type: 'REEXPLORE_PAGE'; payload: { url: string } }
  | { type: 'LEARN_FLOWS' }
  | { type: 'GENERATE_TESTS'; payload: { flowId: string } }
  | { type: 'RUN_TEST'; payload: { testCaseId: string; targetOrigin?: string } }
  | { type: 'RUN_SELECTED_TESTS'; payload: { testCaseIds: string[]; concurrency?: number; targetOrigin?: string } }
  | { type: 'RUN_ALL_TESTS'; payload?: { rerunAll?: boolean; concurrency?: number; targetOrigin?: string } }
  | { type: 'PREVIEW_TESTS'; payload: { tests: unknown[] } }
  | { type: 'EXPORT_PLANS' }
  | { type: 'IMPORT_TESTS'; payload: { tests: unknown[] } }
  | { type: 'EXPAND_TEST_CASE'; payload: { title: string; description: string; type: 'positive' | 'negative' | 'edge'; steps?: string[]; startUrl?: string; executionPresetId?: string } }
  | { type: 'REGENERATE_TEST_CASE'; payload: { testCaseId: string; additionalContext: string } }
  | { type: 'GET_STATUS' }
  | { type: 'OPEN_SIDE_PANEL' }
  | { type: 'CLEAR_ALL_DATA' }
  | { type: 'TAKE_SCREENSHOT' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'GET_RECORDED_ACTIONS' }
  | { type: 'PARSE_OPENAPI_SPEC'; payload: { specJson: string } }
  | { type: 'COMPARE_SCREENSHOTS'; payload: { baseline: string; current: string; threshold?: number } }
  // Auth session management
  | { type: 'CAPTURE_AUTH_COOKIES'; payload: { presetId: string; url: string } }
  | { type: 'VERIFY_AUTH'; payload: { presetId: string } }
  // Reporting & Export
  | { type: 'EXPORT_HTML_REPORT'; payload: { runId?: string } }
  | { type: 'EXPORT_JUNIT_XML'; payload: { runId?: string } }
  | { type: 'EXPORT_JSON_REPORT'; payload: { runId?: string } }
  | { type: 'GET_TEST_TRENDS' }
  // Video recording
  | { type: 'START_SCREENCAST'; payload: { tabId: number } }
  | { type: 'STOP_SCREENCAST'; payload: { tabId: number } }
  // Webhook
  | { type: 'TEST_WEBHOOK'; payload: { url: string; headers?: Record<string, string> } }
  // Analysis features
  | { type: 'GET_HAR_IMPACT'; payload?: { runId?: string } }
  | { type: 'RUN_A11Y_AUDIT' }
  | { type: 'VALIDATE_API_CONTRACTS'; payload?: { runId?: string } };

// ─── Background → Sidebar messages (progress updates) ───────────────────────

export type SidebarMessage =
  | { type: 'CRAWL_PROGRESS'; payload: CrawlProgress }
  | { type: 'CRAWL_COMPLETE'; payload: { docCount: number; vectorCount: number; skippedCount: number } }
  | { type: 'CRAWL_ERROR'; payload: { error: string } }
  | { type: 'EXPLORATION_PROGRESS'; payload: ExplorationProgress }
  | { type: 'EXPLORATION_COMPLETE' }
  | { type: 'EXPLORATION_ERROR'; payload: { error: string } }
  | { type: 'CRAWL_STOPPED' }
  | { type: 'EXPLORATION_STOPPED' }
  | { type: 'TESTS_STOPPED' }
  | { type: 'REEXPLORE_COMPLETE'; payload: { url: string } }
  | { type: 'REEXPLORE_ERROR'; payload: { url: string; error: string } }
  | { type: 'FLOWS_LEARNED'; payload: { count: number } }
  | { type: 'TESTS_GENERATED'; payload: { count: number; flowId: string } }
  | { type: 'TEST_STARTED'; payload: { testCaseId: string } }
  | {
      type: 'TEST_STEP_RESULT';
      payload: {
        testCaseId: string;
        stepOrder: number;
        status: string;
        action: string;
        description: string;
        error?: string;
      };
    }
  | { type: 'TEST_COMPLETE'; payload: { testCaseId: string; status: string } }
  | { type: 'ALL_TESTS_COMPLETE'; payload: { passed: number; failed: number; total: number } }
  | { type: 'IMPORT_PROGRESS'; payload: { current: number; total: number; title: string; phase: 'expanding' | 'saving' } }
  | { type: 'IMPORT_COMPLETE'; payload: { count: number } }
  | { type: 'IMPORT_ERROR'; payload: { error: string } }
  | { type: 'EXPAND_COMPLETE'; payload: { testCaseId: string } }
  | { type: 'EXPAND_ERROR'; payload: { error: string } }
  | { type: 'REGENERATE_COMPLETE'; payload: { testCaseId: string } }
  | { type: 'REGENERATE_ERROR'; payload: { error: string } }
  | { type: 'STATUS_UPDATE'; payload: Record<string, unknown> }
  | { type: 'RECORDING_STARTED' }
  | { type: 'RECORDING_STOPPED'; payload: { actionCount: number } }
  // Analysis results
  | { type: 'HAR_IMPACT_COMPLETE'; payload: { coveragePercent: number; totalEndpoints: number; gaps: number; report: string } }
  | { type: 'A11Y_AUDIT_COMPLETE'; payload: { totalIssues: number; critical: number; serious: number; report: string } }
  | { type: 'CONTRACT_VALIDATION_COMPLETE'; payload: { violations: number; errors: number; warnings: number; report: string } };

export type AnyMessage = BackgroundMessage | ContentScriptMessage | SidebarMessage;
