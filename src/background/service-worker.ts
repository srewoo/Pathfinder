import { crawlSite } from '../core/knowledge/crawler';
import { exploreApp } from '../core/explorer/explorer-agent';
import { learnFlows } from '../core/flow/flow-learner';
import { generateTestsForFlow } from '../core/test-gen/test-generator';
import { expandAndSaveTestCase, expandImportedTests, importAndExpandTests, validateImportFile, regenerateTestCaseSteps } from '../core/test-gen/test-importer';
import { executeTest, executeAllTests } from '../core/executor/test-executor';
import { summarizePreflightIssues, validateExecutionPreflight } from '../core/executor/preflight';
import { getAllFlows } from '../core/flow/flow-store';
import { testCaseDB, planDB, clearAllData } from '../storage/indexed-db';
import { settingsStorage, executionPresetStorage } from '../storage/chrome-storage';
import { createAIClient } from '../core/ai/ai-client';
import { broadcastToSidebar, sendToContentScript } from '../messaging/messenger';
import type { BackgroundMessage } from '../messaging/messages';
import type { TestCase } from '../storage/schemas';
import { captureActiveTab } from '../utils/screenshot';
import { createLogger } from '../utils/logger';
import { recordedActionsToSteps, inferTestTitle } from '../core/recorder/recorder';
import type { RecordedAction } from '../core/recorder/recorder';
import { parseOpenAPISpec, extractValidationRules } from '../core/openapi/openapi-parser';
import { compareScreenshots } from '../utils/visual-diff';
import { captureAuthCookies, saveCookiesToPreset, verifyAuthState } from '../core/executor/auth-manager';
import { generateHtmlReport, generateJUnitXml } from '../utils/html-reporter';
import { generateJsonReport, computeTestTrends, getRunResults } from '../utils/report-exporter';
import { notifyTestComplete, notifySuiteComplete, testWebhook } from '../core/executor/webhook-notifier';
import { startScreencast, stopScreencast } from '../core/cdp/screencast';
import { analyzeHARImpact, formatHARImpactReport } from '../core/analysis/har-impact';
import { runAccessibilityAudit, formatA11yReport } from '../core/analysis/accessibility-audit';
import { validateAgainstSpec, formatContractReport } from '../core/analysis/api-contract-validator';
import type { ParsedAPISpec } from '../core/openapi/openapi-parser';

const log = createLogger('service-worker');

// ── MV3 Service Worker keepalive ─────────────────────────────────────────────
// Chrome MV3 service workers are terminated after ~30s of inactivity.
// Extension page ports (sidepanel) do NOT extend SW lifetime — only content
// script ports do. We use chrome.alarms (already in manifest permissions) to
// fire a periodic event that keeps the SW alive during long operations.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sw-keepalive') {
    log.debug('SW keepalive ping');
  }
});

function startSWKeepalive(): void {
  // periodInMinutes: 0.5 = every 30 seconds — well within Chrome's 30s idle timeout
  chrome.alarms.create('sw-keepalive', { periodInMinutes: 0.5 });
}

function stopSWKeepalive(): void {
  chrome.alarms.clear('sw-keepalive');
}

let crawlController: AbortController | null = null;
let exploreController: AbortController | null = null;
let testController: AbortController | null = null;
let isRecording = false;
let recordingTabId: number | undefined;

/** Stored OpenAPI spec context for enriching test planning. Exported for planner access. */
export let apiSpecContext: string | undefined;
export let apiValidationRules: string | undefined;
/** Full parsed spec object for contract validation. */
let parsedApiSpec: ParsedAPISpec | undefined;

// ── Per-tab panel tracking ────────────────────────────────────────────────────
// Maps windowId → tabId for every tab that has the side panel enabled.
// This lets us disable the panel for the exact tab when the user closes it.
const panelTabByWindow = new Map<number, number>();

chrome.runtime.onInstalled.addListener(() => {
  log.info('pathfinder installed');
  // Disable the panel globally by default — it will only be enabled for the
  // specific tab the user clicks the extension icon on.
  // This prevents the panel from appearing on every tab in the same window.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
});

// Open / re-open the panel for the tab the user clicked the extension icon on.
// IMPORTANT: sidePanel.open() must be called synchronously within the user-gesture
// handler — any `await` before it breaks the gesture chain and Chrome rejects the call.
// We fire both setOptions and open without awaiting; the browser IPC queue ensures
// setOptions is applied before open is processed.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id || !tab.windowId) return;
  const { id: tabId, windowId } = tab;

  chrome.sidePanel
    .setOptions({ tabId, enabled: true, path: 'src/sidepanel/index.html' })
    .catch((err) => log.warn('setOptions failed', err));

  chrome.sidePanel
    .open({ tabId })
    .then(() => {
      panelTabByWindow.set(windowId, tabId);
      log.info(`Opened panel for tab ${tabId} (window ${windowId})`);
    })
    .catch((err) => log.warn('Failed to open side panel', err));
});

// When the side panel loads it connects with name "sidepanel" and reports its
// windowId. We use the disconnect event to detect when the user closes the panel,
// then disable it for that tab so it doesn't reappear on the next tab switch.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;

  let assignedTabId: number | undefined;

  port.onMessage.addListener((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && 'windowId' in msg) {
      const windowId = (msg as { windowId: number }).windowId;
      assignedTabId = panelTabByWindow.get(windowId);
    }
  });

  port.onDisconnect.addListener(() => {
    if (assignedTabId !== undefined) {
      chrome.sidePanel.setOptions({ tabId: assignedTabId, enabled: false }).catch(() => {});
      // Clean up the map entry
      for (const [wid, tid] of panelTabByWindow.entries()) {
        if (tid === assignedTabId) { panelTabByWindow.delete(wid); break; }
      }
      log.info(`Panel closed — disabled for tab ${assignedTabId}`);
    }
  });
});

// Remove tab from tracking when the tab itself is closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [windowId, tid] of panelTabByWindow.entries()) {
    if (tid === tabId) { panelTabByWindow.delete(windowId); break; }
  }
});

chrome.runtime.onMessage.addListener(
  (message: BackgroundMessage, sender, sendResponse) => {
    handleMessage(message, sender)
      .then(sendResponse)
      .catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log.error('Message handler error', err);
        sendResponse({ success: false, error });
      });
    return true;
  }
);

async function handleMessage(
  message: BackgroundMessage,
  _sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case 'OPEN_SIDE_PANEL': {
      // sidePanel.open() requires a direct user gesture — it cannot be called from
      // a message handler. We just ensure the panel is enabled for the active tab;
      // the user can open it via the extension icon.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id && tab.windowId) {
        await chrome.sidePanel.setOptions({ tabId: tab.id, enabled: true, path: 'src/sidepanel/index.html' });
        panelTabByWindow.set(tab.windowId, tab.id);
      }
      return { success: true };
    }

    case 'START_CRAWL': {
      if (crawlController) return { success: false, error: 'Crawl already in progress' };

      const settings = await settingsStorage.get();
      // API key is required when using API embeddings or image descriptions.
      if (!settings.apiKey && (!settings.useLocalEmbeddings || settings.describeImages)) {
        const reason = settings.describeImages
          ? 'Image description requires an API key.'
          : 'Enable Local Embeddings in Settings to crawl without an API key.';
        return { success: false, error: `API key not configured. ${reason}` };
      }

      crawlController = new AbortController();
      const crawlSignal = crawlController.signal;
      startSWKeepalive();

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      crawlSite(message.payload.url, aiClient, {
        maxDepth: 3,
        maxPages: settings.maxCrawlPages,
        skipEmbedRateLimit: settings.useLocalEmbeddings,
        describeImages: settings.describeImages,
        signal: crawlSignal,
        onProgress: (progress) => {
          broadcastToSidebar({ type: 'CRAWL_PROGRESS', payload: progress });
        },
      })
        .then((result) => {
          if (crawlSignal.aborted) {
            broadcastToSidebar({ type: 'CRAWL_STOPPED' });
          } else {
            broadcastToSidebar({
              type: 'CRAWL_COMPLETE',
              payload: { docCount: result.docCount, vectorCount: result.vectorCount, skippedCount: result.skippedCount },
            });
          }
        })
        .catch((err) => {
          if (crawlSignal.aborted) {
            broadcastToSidebar({ type: 'CRAWL_STOPPED' });
          } else {
            broadcastToSidebar({ type: 'CRAWL_ERROR', payload: { error: String(err) } });
          }
        })
        .finally(() => { crawlController = null; stopSWKeepalive(); });

      return { success: true };
    }

    case 'STOP_CRAWL': {
      crawlController?.abort();
      crawlController = null;
      broadcastToSidebar({ type: 'CRAWL_STOPPED' });
      return { success: true };
    }

    case 'START_EXPLORATION': {
      if (exploreController) return { success: false, error: 'Exploration already running' };

      exploreController = new AbortController();
      const exploreSignal = exploreController.signal;
      startSWKeepalive();

      const exploreSettings = await settingsStorage.get();
      const exploreAiClient = exploreSettings.apiKey ? createAIClient({
        provider: exploreSettings.provider,
        apiKey: exploreSettings.apiKey,
        model: exploreSettings.model,
        embeddingModel: exploreSettings.embeddingModel,
        useLocalEmbeddings: exploreSettings.useLocalEmbeddings,
      }) : undefined;

      const singlePageOnly = message.payload.singlePageOnly === true;
      let singlePageStartUrl: string | undefined;
      if (singlePageOnly) {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab?.url) {
          exploreController = null;
          stopSWKeepalive();
          return { success: false, error: 'No active tab URL — open the page you want to explore first.' };
        }
        singlePageStartUrl = activeTab.url;
      }

      exploreApp({
        maxDepth: singlePageOnly ? 0 : (message.payload.depth ?? exploreSettings.maxExplorationDepth),
        maxPages: singlePageOnly ? 1 : exploreSettings.maxCrawlPages,
        startUrl: singlePageStartUrl,
        reexplorePage: singlePageOnly,
        agentMode: exploreSettings.agentMode ?? true,
        aiClient: exploreAiClient,
        includeDangerous: message.payload.includeDangerous === true,
        signal: exploreSignal,
        onProgress: (progress) => {
          broadcastToSidebar({ type: 'EXPLORATION_PROGRESS', payload: progress });
        },
      })
        .then((result) => {
          if (exploreSignal.aborted) {
            broadcastToSidebar({ type: 'EXPLORATION_STOPPED' });
          } else {
            broadcastToSidebar({ type: 'EXPLORATION_COMPLETE' });
            // Broadcast a11y results if any were collected during exploration
            if (result.a11yResults.length > 0) {
              const totalIssues = result.a11yResults.reduce((sum: number, r: { summary: { total: number } }) => sum + r.summary.total, 0);
              const totalCritical = result.a11yResults.reduce((sum: number, r: { summary: { critical: number } }) => sum + r.summary.critical, 0);
              const totalSerious = result.a11yResults.reduce((sum: number, r: { summary: { serious: number } }) => sum + r.summary.serious, 0);
              broadcastToSidebar({
                type: 'A11Y_AUDIT_COMPLETE',
                payload: {
                  totalIssues,
                  critical: totalCritical,
                  serious: totalSerious,
                  report: formatA11yReport(result.a11yResults),
                },
              });
            }
          }
        })
        .catch((err) => {
          if (exploreSignal.aborted) {
            broadcastToSidebar({ type: 'EXPLORATION_STOPPED' });
          } else {
            broadcastToSidebar({ type: 'EXPLORATION_ERROR', payload: { error: String(err) } });
          }
        })
        .finally(() => { exploreController = null; stopSWKeepalive(); });

      return { success: true };
    }

    case 'STOP_EXPLORATION': {
      exploreController?.abort();
      exploreController = null;
      broadcastToSidebar({ type: 'EXPLORATION_STOPPED' });
      return { success: true };
    }

    case 'STOP_TESTS': {
      testController?.abort();
      testController = null;
      broadcastToSidebar({ type: 'TESTS_STOPPED' });
      return { success: true };
    }

    case 'REEXPLORE_PAGE': {
      if (exploreController) return { success: false, error: 'Exploration already running' };

      exploreController = new AbortController();
      const reexploreSignal = exploreController.signal;
      startSWKeepalive();

      const reexploreSettings = await settingsStorage.get();
      const targetUrl = message.payload.url;

      exploreApp({
        maxDepth: 2,
        maxPages: reexploreSettings.maxCrawlPages,
        startUrl: targetUrl,
        reexplorePage: true,
        signal: reexploreSignal,
        onProgress: (progress) => {
          broadcastToSidebar({ type: 'EXPLORATION_PROGRESS', payload: progress });
        },
      })
        .then(() => {
          if (reexploreSignal.aborted) {
            broadcastToSidebar({ type: 'EXPLORATION_STOPPED' });
          } else {
            broadcastToSidebar({ type: 'REEXPLORE_COMPLETE', payload: { url: targetUrl } });
          }
        })
        .catch((err) => {
          if (reexploreSignal.aborted) {
            broadcastToSidebar({ type: 'EXPLORATION_STOPPED' });
          } else {
            broadcastToSidebar({ type: 'REEXPLORE_ERROR', payload: { url: targetUrl, error: String(err) } });
          }
        })
        .finally(() => { exploreController = null; stopSWKeepalive(); });

      return { success: true };
    }

    case 'LEARN_FLOWS': {
      const settings = await settingsStorage.get();
      if (!settings.apiKey) return { success: false, error: 'API key not configured' };

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      try {
        const flows = await learnFlows(aiClient);
        broadcastToSidebar({ type: 'FLOWS_LEARNED', payload: { count: flows.length } });
        return { success: true, count: flows.length };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'GENERATE_TESTS': {
      const settings = await settingsStorage.get();
      if (!settings.apiKey) return { success: false, error: 'API key not configured' };

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      const flows = await getAllFlows();
      const flow = flows.find((f) => f.flowId === message.payload.flowId);
      if (!flow) return { success: false, error: 'Flow not found' };

      try {
        const tests = await generateTestsForFlow(flow, aiClient, {
          personalityId: settings.testPersonality,
          customPersonalityPrompt: settings.customPersonalityPrompt,
        });
        broadcastToSidebar({
          type: 'TESTS_GENERATED',
          payload: { count: tests.length, flowId: flow.flowId },
        });
        return { success: true, count: tests.length };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'RUN_TEST': {
      if (testController) return { success: false, error: 'Tests already running' };

      const settings = await settingsStorage.get();
      if (!settings.apiKey) {
        return { success: false, error: 'API key not configured' };
      }

      const testCase = await testCaseDB.get(message.payload.testCaseId);
      if (!testCase) {
        return { success: false, error: 'Test case not found' };
      }

      const preflight = await validateExecutionPreflight([testCase]);
      if (!preflight.ok) {
        return {
          success: false,
          error: summarizePreflightIssues(preflight.blockers).join(' '),
          warnings: summarizePreflightIssues(preflight.warnings),
        };
      }

      const tabId = preflight.activeTabId;
      if (!tabId) {
        return { success: false, error: 'No active tab found' };
      }

      testController = new AbortController();
      const testSignal = testController.signal;

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      broadcastToSidebar({ type: 'TEST_STARTED', payload: { testCaseId: testCase.id } });

      // Start screencast recording for this test
      startScreencast(tabId).catch(() => {});

      executeTest(testCase, aiClient, tabId, {
        planningMode: settings.planningMode ?? 'auto',
        signal: testSignal,
        targetOrigin: message.payload.targetOrigin,
        onStepResult: (testCaseId, stepOrder, result) => {
          broadcastToSidebar({
            type: 'TEST_STEP_RESULT',
            payload: {
              testCaseId,
              stepOrder,
              status: result.status,
              action: result.step.action,
              description: result.step.description,
              error: result.error,
            },
          });
        },
        onTestComplete: async (result) => {
          // Stop screencast and attach frames to result
          const frames = await stopScreencast(tabId).catch(() => []);
          if (frames.length > 0) {
            (result as any).screencastFrames = frames;
          }
          broadcastToSidebar({
            type: 'TEST_COMPLETE',
            payload: { testCaseId: testCase.id, status: result.status },
          });
          notifyTestComplete(result).catch(() => {});
        },
      })
        .finally(() => {
          testController = null;
          stopScreencast(tabId).catch(() => {});
        });

      return { success: true, warnings: summarizePreflightIssues(preflight.warnings) };
    }

    case 'RUN_SELECTED_TESTS': {
      if (testController) return { success: false, error: 'Tests already running' };

      const settings = await settingsStorage.get();
      if (!settings.apiKey) {
        return { success: false, error: 'API key not configured' };
      }

      if (message.payload.testCaseIds.length === 0) {
        return { success: false, error: 'No test cases selected' };
      }

      const selectedTests = await getSelectedTests(message.payload.testCaseIds);
      if (selectedTests.length === 0) {
        return { success: false, error: 'No matching test cases found' };
      }

      const preflight = await validateExecutionPreflight(selectedTests);
      if (!preflight.ok) {
        return {
          success: false,
          error: summarizePreflightIssues(preflight.blockers).join(' '),
          warnings: summarizePreflightIssues(preflight.warnings),
        };
      }

      testController = new AbortController();
      const selectedTestSignal = testController.signal;

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      const concurrency = message.payload.concurrency ?? settings.testConcurrency ?? 1;

      executeAllTests(aiClient, {
        concurrency,
        planningMode: settings.planningMode ?? 'auto',
        testCaseIds: message.payload.testCaseIds,
        signal: selectedTestSignal,
        targetOrigin: message.payload.targetOrigin,
        onTestStart: (tc) => {
          broadcastToSidebar({ type: 'TEST_STARTED', payload: { testCaseId: tc.id } });
        },
        onStepResult: (testCaseId, stepOrder, result) => {
          broadcastToSidebar({
            type: 'TEST_STEP_RESULT',
            payload: {
              testCaseId,
              stepOrder,
              status: result.status,
              action: result.step.action,
              description: result.step.description,
              error: result.error,
            },
          });
        },
        onTestComplete: (result) => {
          broadcastToSidebar({
            type: 'TEST_COMPLETE',
            payload: { testCaseId: result.testCaseId, status: result.status },
          });
          notifyTestComplete(result).catch(() => {});
        },
      })
        .then((results) => {
          const passed = results.filter((r) => r.status === 'passed').length;
          const failed = results.filter((r) => r.status !== 'passed').length;
          broadcastToSidebar({
            type: 'ALL_TESTS_COMPLETE',
            payload: { passed, failed, total: results.length },
          });
          notifySuiteComplete(results, results[0]?.runId ?? 'unknown').catch(() => {});
      })
        .finally(() => { testController = null; });

      return { success: true, warnings: summarizePreflightIssues(preflight.warnings) };
    }

    case 'RUN_ALL_TESTS': {
      if (testController) return { success: false, error: 'Tests already running' };

      const settings = await settingsStorage.get();
      if (!settings.apiKey) {
        return { success: false, error: 'API key not configured' };
      }

      const rerunAll = message.payload?.rerunAll ?? false;
      const targetTests = await getRunnableTests(rerunAll);
      const preflightWarnings: string[] = [];
      if (targetTests.length > 0) {
        const preflight = await validateExecutionPreflight(targetTests);
        if (!preflight.ok) {
          return {
            success: false,
            error: summarizePreflightIssues(preflight.blockers).join(' '),
            warnings: summarizePreflightIssues(preflight.warnings),
          };
        }

        preflightWarnings.push(...summarizePreflightIssues(preflight.warnings));
      }

      testController = new AbortController();
      const allTestSignal = testController.signal;

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      const concurrency = message.payload?.concurrency ?? settings.testConcurrency ?? 1;

      executeAllTests(aiClient, {
        rerunAll,
        concurrency,
        signal: allTestSignal,
        targetOrigin: message.payload?.targetOrigin,
        onTestStart: (tc) => {
          broadcastToSidebar({ type: 'TEST_STARTED', payload: { testCaseId: tc.id } });
        },
        onStepResult: (testCaseId, stepOrder, result) => {
          broadcastToSidebar({
            type: 'TEST_STEP_RESULT',
            payload: {
              testCaseId,
              stepOrder,
              status: result.status,
              action: result.step.action,
              description: result.step.description,
              error: result.error,
            },
          });
        },
        onTestComplete: (result) => {
          broadcastToSidebar({
            type: 'TEST_COMPLETE',
            payload: { testCaseId: result.testCaseId, status: result.status },
          });
          notifyTestComplete(result).catch(() => {});
        },
      })
        .then(async (results) => {
          const passed = results.filter((r) => r.status === 'passed').length;
          const failed = results.filter((r) => r.status !== 'passed').length;
          broadcastToSidebar({
            type: 'ALL_TESTS_COMPLETE',
            payload: { passed, failed, total: results.length },
          });
          notifySuiteComplete(results, results[0]?.runId ?? 'unknown').catch(() => {});
          // Auto-run HAR impact analysis after suite completes
          try {
            const harReport = await analyzeHARImpact(results);
            broadcastToSidebar({
              type: 'HAR_IMPACT_COMPLETE',
              payload: {
                coveragePercent: harReport.summary.coveragePercent,
                totalEndpoints: harReport.summary.totalEndpoints,
                gaps: harReport.summary.uncoveredEndpoints,
                report: formatHARImpactReport(harReport),
              },
            });
            // Auto-run contract validation if spec is loaded
            if (parsedApiSpec) {
              const allHar = results.flatMap((r) => r.harEntries ?? []);
              if (allHar.length > 0) {
                const contractReport = validateAgainstSpec(allHar, parsedApiSpec);
                broadcastToSidebar({
                  type: 'CONTRACT_VALIDATION_COMPLETE',
                  payload: {
                    violations: contractReport.violations.length,
                    errors: contractReport.summary.errors,
                    warnings: contractReport.summary.warnings,
                    report: formatContractReport(contractReport),
                  },
                });
              }
            }
          } catch { /* non-fatal — analysis failure shouldn't block test completion */ }
      })
        .finally(() => { testController = null; });

      return { success: true, warnings: preflightWarnings };
    }

    case 'EXPAND_TEST_CASE': {
      const settings = await settingsStorage.get();
      if (!settings.apiKey) return { success: false, error: 'API key not configured' };

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      try {
        const testCase = await expandAndSaveTestCase(message.payload, aiClient);
        broadcastToSidebar({ type: 'EXPAND_COMPLETE', payload: { testCaseId: testCase.id } });
        return { success: true, testCaseId: testCase.id };
      } catch (err) {
        const error = String(err);
        broadcastToSidebar({ type: 'EXPAND_ERROR', payload: { error } });
        return { success: false, error };
      }
    }

    case 'REGENERATE_TEST_CASE': {
      const settings = await settingsStorage.get();
      if (!settings.apiKey) return { success: false, error: 'API key not configured' };

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      try {
        const testCase = await regenerateTestCaseSteps(message.payload.testCaseId, message.payload.additionalContext, aiClient);
        broadcastToSidebar({ type: 'REGENERATE_COMPLETE', payload: { testCaseId: testCase.id } });
        return { success: true, testCaseId: testCase.id };
      } catch (err) {
        const error = String(err);
        broadcastToSidebar({ type: 'REGENERATE_ERROR', payload: { error } });
        return { success: false, error };
      }
    }

    case 'PREVIEW_TESTS': {
      const settings = await settingsStorage.get();
      if (!settings.apiKey) return { success: false, error: 'API key not configured' };

      const validation = validateImportFile({ tests: message.payload.tests });
      if (!validation.valid) return { success: false, error: validation.error };

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      try {
        const tests = await expandImportedTests(validation.file.tests, aiClient);
        return { success: true, tests };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'IMPORT_TESTS': {
      const settings = await settingsStorage.get();
      if (!settings.apiKey) return { success: false, error: 'API key not configured' };

      const validation = validateImportFile({ tests: message.payload.tests });
      if (!validation.valid) return { success: false, error: validation.error };

      const aiClient = createAIClient({
        provider: settings.provider,
        apiKey: settings.apiKey,
        model: settings.model,
        embeddingModel: settings.embeddingModel,
        useLocalEmbeddings: settings.useLocalEmbeddings,
      });

      try {
        const imported = await importAndExpandTests(validation.file.tests, aiClient, (progress) => {
          broadcastToSidebar({ type: 'IMPORT_PROGRESS', payload: progress });
        });

        broadcastToSidebar({ type: 'IMPORT_COMPLETE', payload: { count: imported.length } });
        return { success: true, importedIds: imported.map((testCase) => testCase.id) };
      } catch (err) {
        const error = String(err);
        broadcastToSidebar({ type: 'IMPORT_ERROR', payload: { error } });
        return { success: false, error };
      }
    }

    case 'EXPORT_PLANS': {
      const testCases = await testCaseDB.getAll();
      const allPlans = await planDB.getAll();

      const plansMap: Record<string, unknown[]> = {};
      for (const plan of allPlans) {
        plansMap[plan.testCaseId] = plan.steps;
      }

      return {
        success: true,
        data: {
          version: '1',
          exportedAt: new Date().toISOString(),
          testCases,
          plans: plansMap,
        },
      };
    }

    case 'TAKE_SCREENSHOT': {
      const screenshot = await captureActiveTab();
      return { success: true, screenshot };
    }

    case 'CLEAR_ALL_DATA': {
      await clearAllData();
      return { success: true };
    }

    // ── Record-and-Replay ───────────────────────────────────────────────
    case 'START_RECORDING': {
      if (isRecording) return { success: false, error: 'Already recording' };

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) return { success: false, error: 'No active tab' };

      try {
        await sendToContentScript(activeTab.id, { type: 'START_RECORDING' } as any);
        isRecording = true;
        recordingTabId = activeTab.id;
        broadcastToSidebar({ type: 'RECORDING_STARTED' });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'STOP_RECORDING': {
      if (!isRecording || !recordingTabId) return { success: false, error: 'Not recording' };

      try {
        const response = await sendToContentScript<{ success: boolean; actions: RecordedAction[] }>(
          recordingTabId,
          { type: 'STOP_RECORDING' } as any
        );

        isRecording = false;
        const actions = response?.actions ?? [];
        const steps = recordedActionsToSteps(actions);
        const title = inferTestTitle(actions);

        broadcastToSidebar({
          type: 'RECORDING_STOPPED',
          payload: { actionCount: actions.length },
        });

        recordingTabId = undefined;
        return { success: true, actions, steps, title };
      } catch (err) {
        isRecording = false;
        recordingTabId = undefined;
        return { success: false, error: String(err) };
      }
    }

    case 'GET_RECORDED_ACTIONS': {
      if (!isRecording || !recordingTabId) return { success: false, error: 'Not recording', actions: [] };

      try {
        const response = await sendToContentScript<{ success: boolean; actions: RecordedAction[] }>(
          recordingTabId,
          { type: 'GET_RECORDED_ACTIONS' } as any
        );
        return { success: true, actions: response?.actions ?? [] };
      } catch {
        return { success: true, actions: [] };
      }
    }

    // ── OpenAPI Spec Parsing ────────────────────────────────────────────
    case 'PARSE_OPENAPI_SPEC': {
      try {
        const spec = parseOpenAPISpec(message.payload.specJson);
        apiSpecContext = spec.summary;
        apiValidationRules = extractValidationRules(spec);
        parsedApiSpec = spec;

        return {
          success: true,
          title: spec.title,
          version: spec.version,
          endpointCount: spec.endpoints.length,
          summary: spec.summary.slice(0, 500),
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Visual Screenshot Comparison ────────────────────────────────────
    case 'COMPARE_SCREENSHOTS': {
      try {
        const result = await compareScreenshots(
          message.payload.baseline,
          message.payload.current,
          { threshold: message.payload.threshold }
        );
        return { success: true, ...result };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Auth Session Management ──────────────────────────────────────────
    case 'CAPTURE_AUTH_COOKIES': {
      try {
        const cookies = await captureAuthCookies(message.payload.url);
        await saveCookiesToPreset(message.payload.presetId, cookies);
        return { success: true, cookieCount: cookies.length };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'VERIFY_AUTH': {
      try {
        const preset = await executionPresetStorage.getById(message.payload.presetId);
        if (!preset) return { success: false, error: 'Preset not found' };

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return { success: false, error: 'No active tab' };

        const status = await verifyAuthState(tab.id, preset);
        return { success: true, authStatus: status };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Report Export ────────────────────────────────────────────────────
    case 'EXPORT_HTML_REPORT': {
      try {
        const results = await getRunResults(message.payload.runId);
        if (results.length === 0) return { success: false, error: 'No results found' };
        const html = generateHtmlReport(results);
        return { success: true, html };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'EXPORT_JUNIT_XML': {
      try {
        const results = await getRunResults(message.payload.runId);
        if (results.length === 0) return { success: false, error: 'No results found' };
        const xml = generateJUnitXml(results);
        return { success: true, xml };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'EXPORT_JSON_REPORT': {
      try {
        const results = await getRunResults(message.payload.runId);
        if (results.length === 0) return { success: false, error: 'No results found' };
        const report = generateJsonReport(results);
        return { success: true, report };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'GET_TEST_TRENDS': {
      try {
        const trends = await computeTestTrends();
        return { success: true, trends };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Video Recording ──────────────────────────────────────────────────
    case 'START_SCREENCAST': {
      try {
        await startScreencast(message.payload.tabId);
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    case 'STOP_SCREENCAST': {
      try {
        const frames = await stopScreencast(message.payload.tabId);
        return { success: true, frameCount: frames.length, frames };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Webhook ──────────────────────────────────────────────────────────
    case 'TEST_WEBHOOK': {
      return await testWebhook(message.payload.url, message.payload.headers);
    }

    // ── Analysis: HAR Impact ────────────────────────────────────────────
    case 'GET_HAR_IMPACT': {
      try {
        const results = await getRunResults(message.payload?.runId);
        const report = await analyzeHARImpact(results);
        const formatted = formatHARImpactReport(report);
        broadcastToSidebar({
          type: 'HAR_IMPACT_COMPLETE',
          payload: {
            coveragePercent: report.summary.coveragePercent,
            totalEndpoints: report.summary.totalEndpoints,
            gaps: report.summary.uncoveredEndpoints,
            report: formatted,
          },
        });
        return { success: true, summary: report.summary };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Analysis: Accessibility Audit ────────────────────────────────────
    case 'RUN_A11Y_AUDIT': {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url) return { success: false, error: 'No active tab' };
        const result = await runAccessibilityAudit(tab.id, tab.url, tab.title ?? '');
        const formatted = formatA11yReport([result]);
        broadcastToSidebar({
          type: 'A11Y_AUDIT_COMPLETE',
          payload: {
            totalIssues: result.summary.total,
            critical: result.summary.critical,
            serious: result.summary.serious,
            report: formatted,
          },
        });
        return { success: true, summary: result.summary };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    // ── Analysis: API Contract Validation ────────────────────────────────
    case 'VALIDATE_API_CONTRACTS': {
      if (!parsedApiSpec) {
        return { success: false, error: 'No OpenAPI spec loaded. Upload a spec first via Settings.' };
      }
      try {
        const results = await getRunResults(message.payload?.runId);
        const allHar = results.flatMap((r) => (r.harEntries ?? []) as import('../storage/schemas').CapturedNetworkEntry[]);
        if (allHar.length === 0) {
          return { success: false, error: 'No HAR entries captured. Run tests with CDP enabled first.' };
        }
        const report = validateAgainstSpec(allHar, parsedApiSpec);
        const formatted = formatContractReport(report);
        broadcastToSidebar({
          type: 'CONTRACT_VALIDATION_COMPLETE',
          payload: {
            violations: report.violations.length,
            errors: report.summary.errors,
            warnings: report.summary.warnings,
            report: formatted,
          },
        });
        return { success: true, summary: report.summary };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

async function getSelectedTests(testCaseIds: string[]) {
  const allTests = await testCaseDB.getAll();
  const byId = new Map(allTests.map((testCase) => [testCase.id, testCase]));
  return testCaseIds
    .map((testCaseId) => byId.get(testCaseId))
    .filter((testCase): testCase is TestCase => Boolean(testCase));
}

async function getRunnableTests(rerunAll: boolean) {
  const allTests = await testCaseDB.getAll();
  return rerunAll
    ? allTests
    : allTests.filter((testCase) => testCase.status === 'pending' || testCase.status === 'error');
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    log.debug('Service worker keepalive');
  }
});
