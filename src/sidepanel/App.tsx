import { useEffect, useState } from "react";
import { Header } from './components/layout/Header';
import { Footer } from './components/layout/Footer';
import { TabNav } from './components/layout/TabNav';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import { ExplorerPanel } from './components/explorer/ExplorerPanel';
import { FlowsPanel } from './components/flows/FlowsPanel';
import { TestPanel } from './components/tests/TestPanel';
import { ResultsPanel } from './components/results/ResultsPanel';
import { AnalysisPanel } from './components/analysis/AnalysisPanel';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { Modal } from './components/shared/Modal';
import { OnboardingTour, TOUR_STEPS } from './components/onboarding/OnboardingTour';
import { useOnboardingStore } from './stores/onboarding-store';
import { useNavigationStore } from './stores/navigation-store';
import { useSettingsStore } from './stores/settings-store';
import { useKnowledgeStore } from './stores/knowledge-store';
import { useExplorerStore } from './stores/explorer-store';
import { useTestStore } from './stores/test-store';
import { useAnalysisStore } from './stores/analysis-store';
import type { SidebarMessage } from '../messaging/messages';
import { summarizeVerdicts } from '../core/report/result-adapter';

export function App() {
  const { activeTab, setActiveTab } = useNavigationStore();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settings = useSettingsStore();
  const knowledge = useKnowledgeStore();
  const explorer = useExplorerStore();
  const tests = useTestStore();
  const analysis = useAnalysisStore();
  const onboarding = useOnboardingStore();

  useEffect(() => {
    settings.load();
    // Reports outlive the panel, and the panel is unmounted most of the time.
    analysis.load();
  }, []);

  // Auto-start the first-run tour for new users (once settings load, and not
  // while the settings modal is forced open for the API key). isDone() reads
  // localStorage so the tour shows only once; the Help button replays it.
  useEffect(() => {
    if (settings.loaded && !settingsOpen && !onboarding.active && !onboarding.isDone()) {
      onboarding.start();
    }
  }, [settings.loaded, settingsOpen]);

  // Drive the active tab to match the current tour step.
  useEffect(() => {
    if (!onboarding.active) return;
    const tab = TOUR_STEPS[onboarding.step]?.tab;
    if (tab) setActiveTab(tab);
  }, [onboarding.active, onboarding.step]);

  // Sync theme class to <html> so body background and scrollbars follow the CSS variables
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'light') {
      root.classList.add('light');
    } else {
      root.classList.remove('light');
    }
  }, [settings.theme]);

  useEffect(() => {
    if (!settings.loaded) return;
    if (!settings.apiKey) {
      setSettingsOpen(true);
    }
  }, [settings.loaded, settings.apiKey]);

  useEffect(() => {
    const listener = (message: SidebarMessage) => {
      switch (message.type) {
        case 'CRAWL_PROGRESS':
          knowledge.setProgress(message.payload);
          break;
        case 'CRAWL_COMPLETE':
          knowledge.setCrawlComplete(message.payload.docCount, message.payload.vectorCount, message.payload.skippedCount);
          break;
        case 'CRAWL_ERROR':
          knowledge.setCrawlError(message.payload.error);
          break;
        case 'EXPLORATION_PROGRESS':
          explorer.setProgress(message.payload);
          break;
        case 'EXPLORATION_COMPLETE':
          explorer.setExplorationComplete(message.payload?.coverage);
          break;
        case 'EXPLORATION_ERROR':
          explorer.setExplorationError(message.payload.error);
          break;
        case 'REEXPLORE_COMPLETE':
          explorer.setReexploreComplete(message.payload.url);
          break;
        case 'REEXPLORE_ERROR':
          explorer.setReexploreError(message.payload.url, message.payload.error);
          break;
        case 'FLOWS_LEARNED':
          explorer.setFlowsLearned(message.payload.count);
          tests.loadAll();
          break;
        case 'TESTS_GENERATED':
          tests.loadAll();
          setActiveTab('tests');
          break;
        case 'TEST_STARTED':
          tests.setTestStarted(message.payload.testCaseId);
          break;
        case 'TEST_STEP_RESULT':
          tests.setStepResult(message.payload);
          break;
        case 'TEST_COMPLETE':
          tests.setTestComplete(message.payload.testCaseId, message.payload.status);
          if (useTestStore.getState().runMode === 'single') {
            setActiveTab('results');
          }
          break;
        case 'ALL_TESTS_COMPLETE':
          tests.setAllTestsComplete();
          setActiveTab('results');
          break;
        // Handled here, not in AnalysisPanel. App is always mounted; the panel
        // is not, so a completion that arrived while another tab was open used
        // to reach nobody at all.
        case 'HAR_IMPACT_COMPLETE':
          analysis.acceptReport('coverage', message.payload.report, message.payload.scope);
          break;
        case 'A11Y_AUDIT_COMPLETE':
          analysis.acceptReport('a11y', message.payload.report, message.payload.scope);
          break;
        case 'CONTRACT_VALIDATION_COMPLETE':
          analysis.acceptReport('contracts', message.payload.report, message.payload.scope);
          break;
        case 'COST_REPORT_COMPLETE':
          analysis.acceptReport('cost', message.payload.report, message.payload.scope);
          break;
        case 'IMPORT_PROGRESS':
          tests.setImportProgress(message.payload);
          break;
        case 'IMPORT_COMPLETE':
          tests.setImportComplete();
          setActiveTab('tests');
          break;
        case 'IMPORT_ERROR':
          tests.setImportError(message.payload.error);
          break;
        case 'EXPAND_COMPLETE':
        case 'EXPAND_ERROR':
          // isExpanding is cleared by the addUserTest() finally block in the store;
          // these broadcasts are informational — a loadAll() is already triggered.
          break;
      }
    };

    chrome.runtime.onMessage.addListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
    return () => chrome.runtime.onMessage.removeListener(listener as Parameters<typeof chrome.runtime.onMessage.addListener>[0]);
  }, []);

  // Scoped to what is loaded in this panel, and left as `undefined` — not 0 —
  // when nothing has been loaded yet, so "none exist" and "not loaded" do not
  // render identically.
  const verdicts = tests.results.length > 0 ? summarizeVerdicts(tests.results) : undefined;
  const tabCounts = {
    flows: tests.flows?.length,
    tests: tests.testCases?.length,
    // Failures plus passes that carry a serious finding: the results a person
    // has to make a decision about, rather than the total, which is noise.
    resultsNeedingReview: verdicts ? verdicts.fail + verdicts.needsReview : undefined,
  };

  // The most specific thing in flight. Ordered by how much it constrains what
  // the user can do next.
  const runState = explorer.isExploring
    ? 'Exploring…'
    : knowledge.isCrawling
      ? 'Crawling docs…'
      : explorer.isLearningFlows
        ? 'Learning flows…'
        : tests.isRunning
          ? `Running ${tests.runningTestIds.length} test${tests.runningTestIds.length === 1 ? '' : 's'}…`
          : undefined;

  const renderPanel = () => {
    switch (activeTab) {
      case 'knowledge': return <KnowledgePanel />;
      case 'explore': return <ExplorerPanel />;
      case 'flows': return <FlowsPanel />;
      case 'tests': return <TestPanel />;
      case 'results': return <ResultsPanel />;
      case 'analysis': return <AnalysisPanel />;
    }
  };

  return (
    <div className={[
      'flex flex-col h-screen bg-surface text-text-primary overflow-hidden',
      'transition-colors duration-200',
      settings.theme === 'light' ? 'light' : '',
    ].join(' ')}>
      <Header
        onSettingsClick={() => setSettingsOpen(true)}
        onHelpClick={() => onboarding.start()}
        runState={runState}
      />
      <TabNav active={activeTab} onChange={setActiveTab} counts={tabCounts} />
      <div className="flex-1 overflow-y-auto">
        {renderPanel()}
      </div>
      <Footer />

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Settings"
        width="max-w-3xl"
      >
        <SettingsPanel />
      </Modal>

      {onboarding.active && !settingsOpen && (
        <OnboardingTour
          step={onboarding.step}
          onNext={onboarding.next}
          onBack={onboarding.back}
          onSkip={onboarding.skip}
        />
      )}
    </div>
  );
}
