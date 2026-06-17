import { describe, it, expect, beforeEach } from 'vitest';
import { useOnboardingStore, TOUR_STEP_COUNT } from '../../../src/sidepanel/stores/onboarding-store';

const reset = () => {
  localStorage.clear();
  useOnboardingStore.setState({ active: false, step: 0 });
};

describe('onboarding-store', () => {
  beforeEach(reset);

  it('given a new user when start is called then the tour is active at step 0', () => {
    useOnboardingStore.getState().start();
    expect(useOnboardingStore.getState().active).toBe(true);
    expect(useOnboardingStore.getState().step).toBe(0);
    expect(useOnboardingStore.getState().isDone()).toBe(false);
  });

  it('given an active tour when next is called then it advances one step', () => {
    const s = useOnboardingStore.getState();
    s.start();
    s.next();
    expect(useOnboardingStore.getState().step).toBe(1);
  });

  it('given the last step when next is called then the tour finishes and is marked done', () => {
    const s = useOnboardingStore.getState();
    s.start();
    for (let i = 0; i < TOUR_STEP_COUNT; i++) useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(useOnboardingStore.getState().isDone()).toBe(true);
  });

  it('given step 0 when back is called then it stays at step 0', () => {
    const s = useOnboardingStore.getState();
    s.start();
    s.back();
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it('given an active tour when skip is called then it closes and marks done', () => {
    const s = useOnboardingStore.getState();
    s.start();
    s.next();
    useOnboardingStore.getState().skip();
    expect(useOnboardingStore.getState().active).toBe(false);
    expect(useOnboardingStore.getState().isDone()).toBe(true);
  });

  it('given the tour was completed before then isDone reflects persisted state', () => {
    useOnboardingStore.getState().skip();
    // Simulate a fresh store instance reading persisted localStorage.
    useOnboardingStore.setState({ active: false, step: 0 });
    expect(useOnboardingStore.getState().isDone()).toBe(true);
  });
});
