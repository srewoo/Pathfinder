import { BookOpen, Search, GitBranch, FlaskConical, BarChart2, Shield } from 'lucide-react';
import { SegmentedControl, type SegmentOption } from '../shared/SegmentedControl';

export type Tab = 'knowledge' | 'explore' | 'flows' | 'tests' | 'results' | 'analysis';

/**
 * Counts shown on the tabs.
 *
 * Every field is optional and `undefined` means NOT COUNTED — rendered as
 * nothing rather than as a zero. The distinction matters: "no flows yet" and
 * "flows not loaded" look identical as a `0`, and only one of them is a reason
 * to go and do something.
 */
export interface TabCounts {
  flows?: number;
  tests?: number;
  /**
   * Results that need a human decision — NEEDS_REVIEW and failures.
   *
   * Deliberately not the total result count: a tab badge reading 412 on a
   * healthy run is noise, and the number worth putting in front of someone is
   * the one they have to act on.
   */
  resultsNeedingReview?: number;
}

interface TabNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
  counts?: TabCounts;
}

/**
 * The app's primary navigation, one `SegmentedControl` rather than its own
 * hand-rolled copy — which had no `role`, no `aria-selected` and no keyboard
 * support, making the panel's main navigation mouse-only.
 */
export function TabNav({ active, onChange, counts }: TabNavProps) {
  const tabs: ReadonlyArray<SegmentOption<Tab>> = [
    { id: 'knowledge', icon: BookOpen, label: 'Knowledge' },
    { id: 'explore', icon: Search, label: 'Explore' },
    {
      id: 'flows',
      icon: GitBranch,
      label: 'Flows',
      badge: counts?.flows === undefined ? undefined : { count: counts.flows, title: `${counts.flows} flow(s) learned` },
    },
    {
      id: 'tests',
      icon: FlaskConical,
      label: 'Tests',
      badge: counts?.tests === undefined ? undefined : { count: counts.tests, title: `${counts.tests} test case(s)` },
    },
    {
      id: 'results',
      icon: BarChart2,
      label: 'Results',
      badge:
        counts?.resultsNeedingReview === undefined
          ? undefined
          : {
              count: counts.resultsNeedingReview,
              emphasis: true,
              title: `${counts.resultsNeedingReview} result(s) need review — failures and passes with findings`,
            },
    },
    { id: 'analysis', icon: Shield, label: 'Analysis' },
  ];

  return (
    <SegmentedControl
      options={tabs}
      value={active}
      onChange={onChange}
      variant="underline"
      size="md"
      label="Main navigation"
    />
  );
}
