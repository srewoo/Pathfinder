import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppConfig } from '../config/config.js';
import { withErrorHandling } from './handlers/_error-wrapper.js';
import { handleRunOneLiners } from './handlers/run-one-liners.js';
import { handleCrawlKnowledge } from './handlers/crawl-knowledge.js';
import { handleExploreApp } from './handlers/explore-app.js';
import { handleLearnFlows } from './handlers/learn-flows.js';
import { handleExpandTests } from './handlers/expand-tests.js';
import { handleGetResults } from './handlers/get-results.js';
import { handleGetGraph } from './handlers/get-graph.js';
import { handleGetFlows } from './handlers/get-flows.js';
import { handleMemory } from './handlers/memory.js';
import { handleExportKnowledge, handleImportKnowledge } from './handlers/knowledge-io.js';
import { handleExportGraph, handleImportGraph } from './handlers/import-graph.js';
import { handleClearGraph, handleClearKnowledge } from './handlers/clear-data.js';
import { handleRunCsv } from './handlers/run-csv.js';
import { handleCaptureAuth, handleImportChromeCookies } from './handlers/capture-auth.js';
import { handleCancelOperation } from './handlers/cancel-operation.js';
import { handleVersion } from './handlers/version.js';
import { TOOL_VERSIONS } from './protocol-version.js';

export function registerTools(server: McpServer, config: AppConfig): void {
  // ─── Core Test Execution ────────────────────────────────────────────────

  server.tool(
    'run_one_liners',
    'Expand and execute one-liner test cases against a target web application. Returns HTML report with results.',
    {
      test_cases: z.array(z.string()).describe('One-liner test descriptions'),
      target_url: z.string().url().describe('Target application URL'),
      batch_size: z.number().min(1).max(5).default(3).describe('Number of tests to expand in parallel'),
      headless: z.boolean().default(true).describe('Run browser in headless mode'),
      concurrency: z.number().min(1).max(4).default(3).describe('Max parallel browser tabs'),
      shared_context: z.string().optional().describe('Additional context for test expansion'),
      storage_state_path: z.string().optional().describe('Path to a Playwright storageState JSON file for pre-authenticated sessions'),
      planning_mode: z.enum(['single-shot', 'interactive', 'auto']).default('auto').describe('Planning strategy: single-shot (fast, one AI call), interactive (AI walks the app live — best quality), auto (interactive on attempt 1, single-shot on retries)'),
      validate_plan: z.boolean().default(true).describe('Validate and auto-repair selectors against the live page before execution (single-shot only)'),
    },
    (args) => withErrorHandling(() => handleRunOneLiners(args, config), 'run_one_liners')
  );

  server.tool(
    'run_csv',
    'Run or expand test cases from CSV content. Supports plain text (one test per line) or CSV with headers: title, type, context, start_url.',
    {
      csv_content: z.string().describe('CSV content with test cases — one per line or with header row'),
      target_url: z.string().url().describe('Target application URL'),
      mode: z.enum(['run', 'expand']).default('run').describe('"run" to execute tests, "expand" to only generate detailed steps'),
      batch_size: z.number().min(1).max(5).default(3),
      headless: z.boolean().default(true),
      concurrency: z.number().min(1).max(4).default(3),
      storage_state_path: z.string().optional().describe('Path to a Playwright storageState JSON file for pre-authenticated sessions'),
    },
    (args) => withErrorHandling(() => handleRunCsv(args, config), 'run_csv')
  );

  server.tool(
    'expand_tests',
    'Expand one-liner descriptions into detailed test cases without executing them',
    {
      test_cases: z.array(z.string()).describe('One-liner test descriptions'),
      target_url: z.string().url().optional(),
      batch_size: z.number().min(1).max(5).default(3),
    },
    (args) => withErrorHandling(() => handleExpandTests(args, config), 'expand_tests')
  );

  // ─── Knowledge Base (RAG) ──────────────────────────────────────────────

  server.tool(
    'crawl_knowledge',
    'Crawl documentation websites to build RAG knowledge base for smarter test planning',
    {
      url: z.string().url().describe('Starting URL to crawl'),
      depth: z.number().min(1).max(10).default(5).describe('Max link-follow depth'),
      max_pages: z.number().min(1).max(1500).default(100).describe('Max pages to crawl'),
    },
    (args) => withErrorHandling(() => handleCrawlKnowledge(args, config), 'crawl_knowledge')
  );

  server.tool(
    'export_knowledge',
    'Export the RAG knowledge base (crawled docs + embeddings) as JSON. Optionally save directly to a file path instead of printing the JSON.',
    {
      file_path: z.string().optional().describe('Absolute path to save the JSON file — if omitted, JSON is returned inline'),
    },
    (args) => withErrorHandling(() => handleExportKnowledge(args), 'export_knowledge')
  );

  server.tool(
    'import_knowledge',
    'Import a previously exported RAG knowledge base. Provide file_path (path to JSON file on disk) or knowledge_json (inline JSON string). Replaces current knowledge.',
    {
      file_path: z.string().optional().describe('Absolute path to the exported JSON file on disk — preferred over pasting the full JSON'),
      knowledge_json: z.string().optional().describe('Inline JSON snapshot from export_knowledge — use file_path instead for large exports'),
    },
    (args) => withErrorHandling(() => handleImportKnowledge(args), 'import_knowledge')
  );

  server.tool(
    'clear_knowledge',
    'Clear the RAG knowledge base (all crawled docs and vectors). Use before re-crawling or switching projects.',
    {},
    () => withErrorHandling(() => handleClearKnowledge(), 'clear_knowledge')
  );

  // ─── App Exploration ───────────────────────────────────────────────────

  server.tool(
    'explore_app',
    'Autonomously explore a web app to map pages, forms, navigation, and modals',
    {
      url: z.string().url().describe('Starting URL'),
      depth: z.number().min(1).max(10).default(5).describe('Max exploration depth'),
      max_pages: z.number().min(1).max(1500).default(100).describe('Max pages to visit'),
      headless: z.boolean().default(true),
      storage_state_path: z.string().optional().describe('Path to a Playwright storageState JSON file for exploring authenticated pages'),
      agent_mode: z.boolean().default(true).describe('Enable AI-guided exploration: the AI ranks which elements to click on each page based on the accessibility tree, focusing on high-value targets (modals, forms, navigation) and skipping noise. Produces higher-quality graphs. Uses ~1 extra AI call per page.'),
    },
    (args) => withErrorHandling(() => handleExploreApp(args, config), 'explore_app')
  );

  server.tool(
    'export_explore',
    'Export the exploration data (interaction graph with pages, forms, navigation) as JSON. Optionally save directly to a file path instead of printing the JSON.',
    {
      file_path: z.string().optional().describe('Absolute path to save the JSON file — if omitted, JSON is returned inline'),
    },
    (args) => withErrorHandling(() => handleExportGraph(args), 'export_explore')
  );

  server.tool(
    'import_explore',
    'Import previously exported exploration data. Provide file_path (path to JSON file on disk) or explore_json (inline JSON string). Enables running tests against any environment using exploration from another.',
    {
      file_path: z.string().optional().describe('Absolute path to the exported JSON file on disk — preferred over pasting the full JSON'),
      explore_json: z.string().optional().describe('Inline JSON snapshot from export_explore — use file_path instead for large exports'),
    },
    (args) => withErrorHandling(() => handleImportGraph({ graph_json: args.explore_json, file_path: args.file_path }), 'import_explore')
  );

  server.tool(
    'clear_explore',
    'Clear exploration data (interaction graph). Use before re-exploring or switching apps.',
    {},
    () => withErrorHandling(() => handleClearGraph(), 'clear_explore')
  );

  // ─── Flows & Results ───────────────────────────────────────────────────

  server.tool(
    'learn_flows',
    'Extract user workflows from exploration data using AI',
    {},
    () => withErrorHandling(() => handleLearnFlows(config), 'learn_flows')
  );

  server.tool(
    'get_results',
    'Get test results and HTML report for a specific run',
    { run_id: z.string().describe('Run ID from a previous execution') },
    (args) => withErrorHandling(() => handleGetResults(args), 'get_results')
  );

  server.tool(
    'get_graph',
    'Get the current exploration graph in human-readable format (pages, forms, navigation)',
    {},
    () => withErrorHandling(() => handleGetGraph(), 'get_graph')
  );

  server.tool(
    'get_flows',
    'Get all learned workflows in human-readable format',
    {},
    () => withErrorHandling(() => handleGetFlows(), 'get_flows')
  );

  // ─── Auth ──────────────────────────────────────────────────────────────

  server.tool(
    'capture_auth',
    'Open a real browser window so you can log in manually. Saves the session (cookies + localStorage) to a JSON file for reuse in test runs via storage_state_path.',
    {
      url: z.string().url().describe('Login page URL to open'),
      save_path: z.string().describe('Absolute path to save the session JSON (e.g. /tmp/auth.json)'),
      wait_for_url: z.string().optional().describe('URL substring that indicates successful login (e.g. "/dashboard"). If omitted, waits for any URL change.'),
      timeout_seconds: z.number().min(10).max(600).default(120).describe('Seconds to wait for login before timing out'),
    },
    (args) => withErrorHandling(() => handleCaptureAuth(args), 'capture_auth')
  );

  server.tool(
    'import_chrome_cookies',
    'Read cookies from your existing Chrome/Brave/Arc browser profile and save them as a Playwright session file. No re-login needed — uses your current browser session. Note: encrypted cookies (most session cookies on macOS/Windows) will be skipped; use capture_auth instead if this happens.',
    {
      save_path: z.string().describe('Absolute path to save the session JSON (e.g. /tmp/auth.json)'),
      domain_filter: z.string().optional().describe('Only import cookies for this domain (e.g. "example.com"). Omit to import all cookies.'),
      profile: z.string().default('Default').describe('Chrome profile folder name (default: "Default")'),
    },
    (args) => withErrorHandling(() => handleImportChromeCookies(args), 'import_chrome_cookies')
  );

  // ─── Agent Memory ──────────────────────────────────────────────────────

  server.tool(
    'remember',
    'Store a persistent memory for future test runs (selector fixes, timing, tenant quirks)',
    {
      key: z.string().describe('Memory key'),
      value: z.string().describe('Memory value'),
      category: z.enum(['selector_heal', 'step_pattern', 'tenant_quirk', 'timing_profile', 'test_outcome']),
    },
    (args) => withErrorHandling(() => handleMemory('set', args), 'remember')
  );

  server.tool(
    'recall',
    'Search persistent memories by keyword or category',
    {
      query: z.string().describe('Search query or category name'),
    },
    (args) => withErrorHandling(() => handleMemory('get', args), 'recall')
  );

  // ─── Operation Control ─────────────────────────────────────────────────

  // ─── Introspection ─────────────────────────────────────────────────────

  server.tool(
    'pathfinder_version',
    `Return server, protocol, and per-tool schema versions. Use this to detect ` +
      `version drift between client and server. Tool versions follow semver: ` +
      `additive changes bump minor, breaking changes bump major. Server is at ` +
      `v${TOOL_VERSIONS.pathfinder_version}.`,
    {},
    () => withErrorHandling(() => handleVersion(), 'pathfinder_version'),
  );

  server.tool(
    'cancel_operation',
    'Cancel an ongoing operation (crawl, explore, or test run)',
    {
      operation: z.enum(['crawl', 'explore', 'run', 'all']).default('all').describe('Which operation to cancel: "crawl", "explore", "run", or "all" to cancel everything'),
    },
    (args) => withErrorHandling(() => handleCancelOperation(args), 'cancel_operation')
  );
}
