import { create } from 'zustand';

/**
 * First-run guided tour state. The "done" flag is persisted to localStorage so
 * the tour is shown once; users can replay it via the Help button.
 */
const STORAGE_KEY = 'pathfinder.onboarding.v1';

/** Total number of steps in the tour (keep in sync with TOUR_STEPS). */
export const TOUR_STEP_COUNT = 7;

function markDone(): void {
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* storage unavailable */ }
}

function readDone(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

interface OnboardingState {
  /** Whether the tour overlay is currently showing. */
  active: boolean;
  /** Current 0-based step index. */
  step: number;
  /** Begin the tour from step 0. */
  start: () => void;
  /** Advance; finishes (and marks done) past the last step. */
  next: () => void;
  /** Go back one step (no-op at step 0). */
  back: () => void;
  /** Dismiss the tour and mark it done. */
  skip: () => void;
  /** True once the user has completed or skipped the tour. */
  isDone: () => boolean;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  active: false,
  step: 0,
  start: () => set({ active: true, step: 0 }),
  next: () => {
    const nextStep = get().step + 1;
    if (nextStep >= TOUR_STEP_COUNT) {
      markDone();
      set({ active: false, step: 0 });
    } else {
      set({ step: nextStep });
    }
  },
  back: () => set((s) => ({ step: Math.max(0, s.step - 1) })),
  skip: () => {
    markDone();
    set({ active: false, step: 0 });
  },
  isDone: () => readDone(),
}));
