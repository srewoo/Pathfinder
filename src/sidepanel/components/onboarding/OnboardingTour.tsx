import React from 'react';
import { Sparkles, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Tab } from '../layout/TabNav';
import { TOUR_STEP_COUNT } from '../../stores/onboarding-store';

export interface TourStep {
  title: string;
  body: string;
  /** Tab to switch to when this step shows; undefined for the intro step. */
  tab?: Tab;
}

/** The 6-step first-run tour. Keep length in sync with TOUR_STEP_COUNT. */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: 'Welcome to Pathfinder',
    body: 'Your AI QA engineer in the browser. It explores your app, learns its flows, then generates and runs end-to-end tests. This quick tour walks through each tab in order.',
  },
  {
    title: 'Knowledge — index your docs',
    body: 'Optional but recommended: paste your product docs URL and crawl. Pathfinder indexes the content so flows and tests are grounded in how your product actually works. No docs? Skip straight to Explore.',
    tab: 'knowledge',
  },
  {
    title: 'Explore — map your app',
    body: 'Open your app in the active tab, then click “Start Exploration”. Pathfinder maps pages, forms, and navigation into an interaction graph that grounds everything downstream.',
    tab: 'explore',
  },
  {
    title: 'Flows — learn workflows',
    body: 'Click “Learn Flows from Exploration” to turn the map into real user workflows (sign-in, create project, …), grounded in your docs. Then generate test cases from them — right here.',
    tab: 'flows',
  },
  {
    title: 'Tests — generate & run',
    body: 'Tests generated from flows land here. You can also type one-line checks in plain English or import JSON. Run them with self-healing selectors and retries.',
    tab: 'tests',
  },
  {
    title: 'Results — review & export',
    body: 'See pass/fail, step-by-step timelines, screenshots, and healing metrics. Export to JUnit XML or HTML for CI.',
    tab: 'results',
  },
  {
    title: 'Analysis — coverage & quality',
    body: 'After running tests, dig deeper: which API endpoints are covered, WCAG accessibility issues, and contract validation against your OpenAPI spec. That’s the full loop!',
    tab: 'analysis',
  },
];

interface OnboardingTourProps {
  step: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function OnboardingTour({ step, onNext, onBack, onSkip }: OnboardingTourProps) {
  const current = TOUR_STEPS[step];
  if (!current) return null;

  const isFirst = step === 0;
  const isLast = step === TOUR_STEP_COUNT - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Getting started tour"
    >
      {/* Dimmed backdrop — clicking it skips the tour. */}
      <button
        type="button"
        aria-label="Dismiss tour"
        onClick={onSkip}
        className="absolute inset-0 bg-black/50 cursor-default"
      />

      {/* Coach-mark card anchored at the BOTTOM so the highlighted tab at the
          top of the panel stays fully visible while the tour describes it. */}
      <div className="relative mt-auto mb-4 mx-3 bg-surface-1 border border-border rounded-xl shadow-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-primary to-indigo-600 flex items-center justify-center flex-shrink-0">
            <Sparkles size={13} className="text-white" />
          </div>
          <span className="text-2xs font-medium text-text-muted">Step {step + 1} of {TOUR_STEP_COUNT}</span>
        </div>

        <h2 className="text-sm font-bold text-text-primary mb-1">{current.title}</h2>
        <p className="text-xs text-text-secondary leading-relaxed">{current.body}</p>

        {/* Progress dots */}
        <div className="flex items-center gap-1 mt-3" aria-hidden>
          {Array.from({ length: TOUR_STEP_COUNT }).map((_, i) => (
            <span
              key={i}
              className={[
                'h-1 rounded-full transition-all',
                i === step ? 'w-4 bg-primary' : 'w-1 bg-surface-3',
              ].join(' ')}
            />
          ))}
        </div>

        <div className="flex items-center justify-between mt-3">
          <button
            type="button"
            onClick={onSkip}
            className="text-2xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Skip tour
          </button>

          <div className="flex items-center gap-2">
            {!isFirst && (
              <button
                type="button"
                onClick={onBack}
                className="flex items-center gap-1 px-2.5 py-1 text-2xs rounded-md border border-border text-text-secondary hover:bg-surface-2 transition-colors"
              >
                <ChevronLeft size={12} /> Back
              </button>
            )}
            <button
              type="button"
              onClick={onNext}
              className="flex items-center gap-1 px-3 py-1 text-2xs font-medium rounded-md bg-primary text-white hover:bg-primary-light transition-colors"
            >
              {isLast ? 'Finish' : 'Next'} {!isLast && <ChevronRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
