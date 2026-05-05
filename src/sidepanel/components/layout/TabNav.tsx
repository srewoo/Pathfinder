import React from 'react';
import { BookOpen, Search, GitBranch, FlaskConical, BarChart2, Shield } from 'lucide-react';

export type Tab = 'knowledge' | 'explore' | 'flows' | 'tests' | 'results' | 'analysis';

interface TabNavProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const tabs: { id: Tab; icon: React.ElementType; label: string }[] = [
  { id: 'knowledge', icon: BookOpen, label: 'Knowledge' },
  { id: 'explore', icon: Search, label: 'Explore' },
  { id: 'flows', icon: GitBranch, label: 'Flows' },
  { id: 'tests', icon: FlaskConical, label: 'Tests' },
  { id: 'results', icon: BarChart2, label: 'Results' },
  { id: 'analysis', icon: Shield, label: 'Analysis' },
];

export function TabNav({ active, onChange }: TabNavProps) {
  return (
    <div className="flex border-b border-border flex-shrink-0 bg-surface-1">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={[
              'flex-1 flex flex-col items-center gap-1 py-2 text-2xs font-medium transition-colors',
              'border-b-2 -mb-px focus:outline-none',
              isActive
                ? 'border-primary text-primary-light bg-primary/5'
                : 'border-transparent text-text-muted hover:text-text-secondary hover:bg-surface-2',
            ].join(' ')}
            title={tab.label}
          >
            <Icon size={14} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}
