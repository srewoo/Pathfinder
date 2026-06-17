import { create } from 'zustand';
import type { CrawledDocument, CrawlProgress } from '../../storage/schemas';
import { documentDB, vectorDB } from '../../storage/indexed-db';
import { sendToBackground } from '../../messaging/messenger';
import { exportKnowledge, importKnowledge } from '../../storage/knowledge-export';

interface KnowledgeState {
  documents: CrawledDocument[];
  vectorCount: number;
  crawlUrl: string;
  isCrawling: boolean;
  isExporting: boolean;
  isImporting: boolean;
  progress: CrawlProgress | null;
  error: string | null;
  exportImportError: string | null;
  /** Set when a crawl just finished — drives the "Continue → Explore" hand-off banner. */
  justCompleted: { docCount: number; vectorCount: number } | null;

  setCrawlUrl: (url: string) => void;
  startCrawl: () => Promise<void>;
  loadDocuments: () => Promise<void>;
  clearKnowledge: () => Promise<void>;
  setProgress: (progress: CrawlProgress) => void;
  setCrawlComplete: (docCount: number, vectorCount: number, skippedCount: number) => void;
  setCrawlError: (error: string) => void;
  dismissCompletion: () => void;
  exportKnowledgeBase: () => Promise<void>;
  importKnowledgeBase: (file: File) => Promise<void>;
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  documents: [],
  vectorCount: 0,
  crawlUrl: '',
  isCrawling: false,
  isExporting: false,
  isImporting: false,
  progress: null,
  error: null,
  exportImportError: null,
  justCompleted: null,

  setCrawlUrl: (url) => set({ crawlUrl: url }),

  startCrawl: async () => {
    const { crawlUrl } = get();
    if (!crawlUrl) return;
    set({ isCrawling: true, error: null, progress: null, justCompleted: null });
    const resp = await sendToBackground<{ success: boolean; error?: string }>({
      type: 'START_CRAWL',
      payload: { url: crawlUrl },
    });
    if (!resp?.success) {
      set({ isCrawling: false, error: resp?.error ?? 'Failed to start crawl' });
    }
  },

  loadDocuments: async () => {
    const [documents, vectorCount] = await Promise.all([
      documentDB.getAll(),
      vectorDB.count(),
    ]);
    set({ documents, vectorCount });
  },

  clearKnowledge: async () => {
    await sendToBackground({ type: 'CLEAR_ALL_DATA' });
    set({ documents: [], vectorCount: 0, progress: null, error: null });
  },

  setProgress: (progress) => set({ progress }),

  setCrawlComplete: (docCount, vectorCount, _skippedCount) => {
    set({ isCrawling: false, vectorCount, justCompleted: { docCount, vectorCount } });
    get().loadDocuments();
  },

  setCrawlError: (error) => set({ isCrawling: false, error }),

  dismissCompletion: () => set({ justCompleted: null }),

  exportKnowledgeBase: async () => {
    set({ isExporting: true, exportImportError: null });
    try {
      await exportKnowledge(get().crawlUrl);
    } catch (err) {
      set({ exportImportError: err instanceof Error ? err.message : 'Export failed' });
    } finally {
      set({ isExporting: false });
    }
  },

  importKnowledgeBase: async (file: File) => {
    set({ isImporting: true, exportImportError: null });
    try {
      const { docCount, vectorCount } = await importKnowledge(file);
      set({ isImporting: false, vectorCount });
      await get().loadDocuments();
      // Clear any stale crawl error since we now have fresh data
      set({ error: null });
      // Brief confirmation — store last import stats in the error field won't work,
      // so we just reload and let the list update speak for itself.
      void docCount;
    } catch (err) {
      set({
        isImporting: false,
        exportImportError: err instanceof Error ? err.message : 'Import failed',
      });
    }
  },
}));
