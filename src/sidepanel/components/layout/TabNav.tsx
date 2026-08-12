import { BookOpen, Search, GitBranch, FlaskConical, BarChart2, Shield } from 'lucide-react';
import { SegmentedControl, type SegmentOption } from '../shared/SegmentedControl';

export type Tab = 'knowledge' | 'explore' | 'flows' | 'tests' | 'results' | 'analysis';

interface TabNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const tabs: ReadonlyArray<SegmentOption<Tab>> = [
  { id: 'knowledge', icon: BookOpen, label: 'Knowledge' },
  { id: 'explore', icon: Search, label: 'Explore' },
  { id: 'flows', icon: GitBranch, label: 'Flows' },
  { id: 'tests', icon: FlaskConical, label: 'Tests' },
  { id: 'results', icon: BarChart2, label: 'Results' },
  { id: 'analysis', icon: Shield, label: 'Analysis' },
];

/**
 * The app's primary navigation, now one `SegmentedControl` rather than its own
 * hand-rolled copy — which had no `role`, no `aria-selected` and no keyboard
 * support, making the panel's main navigation mouse-only.
 */
export function TabNav({ active, onChange }: TabNavProps) {
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
