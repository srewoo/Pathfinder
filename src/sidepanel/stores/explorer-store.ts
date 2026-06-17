import { create } from 'zustand';
import type { InteractionGraph, ExplorationProgress, Flow } from '../../storage/schemas';
import { loadGraph } from '../../core/explorer/interaction-graph';
import { getAllFlows } from '../../core/flow/flow-store';
import { sendToBackground } from '../../messaging/messenger';
import {
  exportExploration,
  importExploration,
  clearExplorationArtifacts,
} from '../../storage/exploration-export';

interface ExplorerState {
  graph: InteractionGraph | null;
  flows: Flow[];
  explorationDepth: number;
  /** "Start from this page" — begin at the current tab and crawl outward to depth. */
  singlePageOnly: boolean;
  /**
   * Strict single page — scan ONLY the current tab URL and its components
   * (tabs/modals), with no link following at all (depth 0, 1 page).
   */
  singlePageStrict: boolean;
  /**
   * When true, the explorer SUBMITS forms with test data (mutates the live app).
   * Default false — read-only exploration. Opt in only for sandbox accounts.
   */
  submitForms: boolean;
  /**
   * When true, re-visit pages already in the map (refreshing changed ones) and
   * prune pages no longer reachable. Default false — incremental (only add new).
   */
  freshRescan: boolean;
  isExploring: boolean;
  /** URL of the page currently being re-explored, or null. */
  reexploringUrl: string | null;
  isLearningFlows: boolean;
  isExporting: boolean;
  isImporting: boolean;
  isDeleting: boolean;
  progress: ExplorationProgress | null;
  error: string | null;
  exportImportError: string | null;

  setDepth: (depth: number) => void;
  setSinglePageOnly: (value: boolean) => void;
  setSinglePageStrict: (value: boolean) => void;
  setSubmitForms: (value: boolean) => void;
  setFreshRescan: (value: boolean) => void;
  startExploration: () => Promise<void>;
  stopExploration: () => Promise<void>;
  reexplorePage: (url: string) => Promise<void>;
  learnFlows: () => Promise<void>;
  exportExplorationData: () => Promise<void>;
  importExplorationData: (file: File) => Promise<void>;
  clearExplorationData: () => Promise<void>;
  loadData: () => Promise<void>;
  setProgress: (progress: ExplorationProgress) => void;
  setExplorationComplete: () => void;
  setExplorationError: (error: string) => void;
  setReexploreComplete: (url: string) => void;
  setReexploreError: (url: string, error: string) => void;
  setFlowsLearned: (count: number) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  graph: null,
  flows: [],
  explorationDepth: 5,
  singlePageOnly: false,
  singlePageStrict: false,
  submitForms: false,
  freshRescan: false,
  isExploring: false,
  reexploringUrl: null,
  isLearningFlows: false,
  isExporting: false,
  isImporting: false,
  isDeleting: false,
  progress: null,
  error: null,
  exportImportError: null,

  setDepth: (explorationDepth) => set({ explorationDepth }),

  // The two scoping modes are mutually exclusive.
  setSinglePageOnly: (singlePageOnly) => set({ singlePageOnly, singlePageStrict: singlePageOnly ? false : get().singlePageStrict }),

  setSinglePageStrict: (singlePageStrict) => set({ singlePageStrict, singlePageOnly: singlePageStrict ? false : get().singlePageOnly }),

  setSubmitForms: (submitForms) => set({ submitForms }),

  setFreshRescan: (freshRescan) => set({ freshRescan }),

  startExploration: async () => {
    const { explorationDepth, singlePageOnly, singlePageStrict, submitForms, freshRescan } = get();
    set({ isExploring: true, error: null, progress: null });
    const resp = await sendToBackground({
      type: 'START_EXPLORATION',
      payload: { depth: explorationDepth, singlePageOnly, singlePageStrict, submitForms, freshRescan },
    }) as { success: boolean; error?: string } | null;
    if (!resp?.success) {
      set({ isExploring: false, error: resp?.error ?? 'Failed to start exploration' });
    }
  },

  stopExploration: async () => {
    await sendToBackground({ type: 'STOP_EXPLORATION' });
    set({ isExploring: false, reexploringUrl: null, progress: null });
  },

  reexplorePage: async (url: string) => {
    set({ isExploring: true, reexploringUrl: url, error: null, progress: null });
    const resp = await sendToBackground({
      type: 'REEXPLORE_PAGE',
      payload: { url },
    }) as { success: boolean; error?: string } | null;
    if (!resp?.success) {
      set({ isExploring: false, reexploringUrl: null, error: resp?.error ?? 'Re-explore failed' });
    }
  },

  learnFlows: async () => {
    set({ isLearningFlows: true, error: null });

    // Race the background call against a hard timeout.
    // Without this, a killed service worker leaves isLearningFlows stuck at true forever.
    const TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — generous for any LLM + large site
    const timeoutResult = { success: false as const, error: 'Flow learning timed out. The site may be too large — try exploring fewer pages first.' };
    const backgroundCall = sendToBackground({ type: 'LEARN_FLOWS' }) as Promise<{ success: boolean; error?: string } | null>;
    const resp = await Promise.race([
      backgroundCall,
      new Promise<typeof timeoutResult>((resolve) => setTimeout(() => resolve(timeoutResult), TIMEOUT_MS)),
    ]);

    if (!resp?.success) {
      const msg = resp?.error ?? 'Flow learning failed';
      const isAuthError = msg.includes('401') || msg.includes('invalid_api_key') || msg.includes('Incorrect API key');
      set({
        isLearningFlows: false,
        error: isAuthError ? 'Invalid API key — please update it in Settings.' : msg,
      });
    }
    // On success, isLearningFlows is cleared by setFlowsLearned when FLOWS_LEARNED broadcast arrives.
  },

  exportExplorationData: async () => {
    set({ isExporting: true, exportImportError: null });
    try {
      const graph = get().graph;
      await exportExploration(graph?.nodes[0]?.url);
    } catch (err) {
      set({ exportImportError: err instanceof Error ? err.message : 'Exploration export failed' });
    } finally {
      set({ isExporting: false });
    }
  },

  importExplorationData: async (file) => {
    set({ isImporting: true, exportImportError: null, error: null });
    try {
      await importExploration(file);
      await get().loadData();
    } catch (err) {
      set({ exportImportError: err instanceof Error ? err.message : 'Exploration import failed' });
    } finally {
      set({ isImporting: false });
    }
  },

  clearExplorationData: async () => {
    set({ isDeleting: true, exportImportError: null, error: null });
    try {
      await clearExplorationArtifacts();
      set({ graph: null, flows: [], progress: null });
    } catch (err) {
      set({ exportImportError: err instanceof Error ? err.message : 'Failed to delete exploration data' });
    } finally {
      set({ isDeleting: false });
    }
  },

  loadData: async () => {
    const [graph, flows] = await Promise.all([loadGraph(), getAllFlows()]);
    set({ graph: graph ?? null, flows });
  },

  setProgress: (progress) => set({ progress }),

  setExplorationComplete: () => {
    set({ isExploring: false, reexploringUrl: null, progress: null });
    get().loadData();
  },

  setExplorationError: (error) => set({ isExploring: false, reexploringUrl: null, error }),

  setReexploreComplete: (_url: string) => {
    set({ isExploring: false, reexploringUrl: null, progress: null });
    get().loadData();
  },

  setReexploreError: (_url: string, error: string) => {
    set({ isExploring: false, reexploringUrl: null, error });
  },

  setFlowsLearned: (_count) => {
    set({ isLearningFlows: false });
    get().loadData();
  },
}));
