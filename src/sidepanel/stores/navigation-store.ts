import { create } from 'zustand';
import type { Tab } from '../components/layout/TabNav';

/**
 * Single source of truth for the active side-panel tab. Lives in a store (not
 * App-local state) so any panel can drive the linear journey forward — e.g. a
 * "Continue → Explore" hand-off banner after a crawl completes, or "Analyze
 * coverage →" from Results. This is what makes the 7-stage pipeline feel guided
 * instead of stranding the user at each transition.
 */
interface NavigationState {
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  activeTab: 'knowledge',
  setActiveTab: (activeTab) => set({ activeTab }),
}));
