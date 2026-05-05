import React, { useState } from 'react';
import { Plus, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { Button } from '../shared/Button';
import { useTestStore } from '../../stores/test-store';
import { useSettingsStore } from '../../stores/settings-store';

type TestType = 'positive' | 'negative' | 'edge';

const TYPE_CONFIG: Record<TestType, { label: string; color: string; hint: string }> = {
  positive: {
    label: 'Positive',
    color: 'bg-success text-white',
    hint: 'Happy path — valid inputs, expected success',
  },
  negative: {
    label: 'Negative',
    color: 'bg-error text-white',
    hint: 'Invalid inputs, missing data, expected errors',
  },
  edge: {
    label: 'Edge',
    color: 'bg-warning text-white',
    hint: 'Boundary values, special characters, limits',
  },
};

const STEP_PLACEHOLDER = `Write numbered steps, one per line:
1. Navigate to /login
2. Enter email: test@example.com
3. Enter password: Test@123
4. Click the Login button
5. Verify the dashboard heading is visible`;

export function TestCaseInput() {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [stepsText, setStepsText] = useState('');
  const [testType, setTestType] = useState<TestType>('positive');
  const [startUrl, setStartUrl] = useState('');
  const [executionPresetId, setExecutionPresetId] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { addUserTest, isExpanding } = useTestStore();
  const { executionPresets } = useSettingsStore();

  const reset = () => {
    setTitle('');
    setDescription('');
    setStepsText('');
    setTestType('positive');
    setStartUrl('');
    setExecutionPresetId('');
    setShowAdvanced(false);
    setExpanded(false);
  };

  const handleAdd = async () => {
    if (!title.trim() || isExpanding) return;

    // Parse numbered steps: "1. Step text" or "- Step text" or plain lines
    const steps = stepsText
      .split('\n')
      .map((line) => line.replace(/^[\d]+[.)]\s*/, '').replace(/^[-•]\s*/, '').trim())
      .filter(Boolean);

    await addUserTest(title.trim(), description.trim() || title.trim(), {
      type: testType,
      steps: steps.length > 0 ? steps : undefined,
      startUrl: startUrl.trim() || undefined,
      executionPresetId: executionPresetId || undefined,
    });

    reset();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAdd();
    if (e.key === 'Escape') reset();
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-2 p-2.5 bg-surface-2 border border-dashed border-border hover:border-primary/50 rounded-lg text-xs text-text-muted hover:text-text-secondary transition-colors"
      >
        <Plus size={12} />
        Build detailed manual test...
      </button>
    );
  }

  return (
    <div className="p-3 bg-surface-2 border border-border rounded-lg space-y-3" onKeyDown={handleKeyDown}>
      <div>
        <h3 className="text-xs font-medium text-text-primary">Detailed Test Builder</h3>
        <p className="text-2xs text-text-muted mt-0.5">
          Use this when you want to specify exact steps instead of starting from a one-line QA check.
        </p>
      </div>

      {/* Title */}
      <div className="space-y-1">
        <label className="block text-2xs font-medium text-text-secondary">Test Title *</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. User can log in with valid credentials"
          autoFocus
          className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
        />
      </div>

      {/* Test Type */}
      <div className="space-y-1">
        <label className="block text-2xs font-medium text-text-secondary">Test Type</label>
        <div className="flex gap-1.5">
          {(Object.keys(TYPE_CONFIG) as TestType[]).map((t) => (
            <button
              key={t}
              onClick={() => setTestType(t)}
              title={TYPE_CONFIG[t].hint}
              className={[
                'flex-1 h-7 rounded-md text-2xs font-medium transition-colors border',
                testType === t
                  ? TYPE_CONFIG[t].color + ' border-transparent'
                  : 'bg-surface-3 text-text-muted border-border hover:border-border-light',
              ].join(' ')}
            >
              {TYPE_CONFIG[t].label}
            </button>
          ))}
        </div>
        <p className="text-2xs text-text-muted">{TYPE_CONFIG[testType].hint}</p>
      </div>

      {executionPresets.length > 0 && (
        <div className="space-y-1">
          <label className="block text-2xs font-medium text-text-secondary">
            Execution preset
            <span className="ml-1 text-text-muted font-normal">(optional)</span>
          </label>
          <select
            value={executionPresetId}
            onChange={(e) => setExecutionPresetId(e.target.value)}
            className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors"
          >
            <option value="">No preset</option>
            {executionPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          <p className="text-2xs text-text-muted">
            Use a saved persona/setup block. Any explicit start URL below overrides the preset default.
          </p>
        </div>
      )}

      {/* Steps */}
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <label className="block text-2xs font-medium text-text-secondary">Test Steps</label>
          <div className="group relative">
            <Info size={10} className="text-text-muted cursor-help" />
            <div className="absolute left-0 bottom-5 z-10 w-56 p-2 bg-surface-3 border border-border rounded-lg text-2xs text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none shadow-lg">
              Write each step on its own line. You can use numbered steps (1. Click...) or plain sentences. Be specific — include exact values to type, button names, and what to verify.
            </div>
          </div>
        </div>
        <textarea
          value={stepsText}
          onChange={(e) => setStepsText(e.target.value)}
          placeholder={STEP_PLACEHOLDER}
          rows={6}
          className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none font-mono leading-relaxed"
        />
      </div>

      {/* Advanced: description + start URL */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1 text-2xs text-text-muted hover:text-text-secondary transition-colors"
      >
        {showAdvanced ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        Advanced options
      </button>

      {showAdvanced && (
        <div className="space-y-2 pl-2 border-l-2 border-border">
          <div className="space-y-1">
            <label className="block text-2xs font-medium text-text-secondary">
              Starting URL
              <span className="ml-1 text-text-muted font-normal">(optional — navigate here before running)</span>
            </label>
            <input
              type="url"
              value={startUrl}
              onChange={(e) => setStartUrl(e.target.value)}
              placeholder="https://app.example.com/login"
              className="w-full h-8 bg-surface-3 border border-border rounded-lg px-3 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-2xs font-medium text-text-secondary">
              Additional context
              <span className="ml-1 text-text-muted font-normal">(optional — anything the AI should know)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. This tests the admin role. The form has client-side validation for email format."
              rows={2}
              className="w-full bg-surface-3 border border-border rounded-lg px-3 py-2 text-xs text-text-primary placeholder-text-muted outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-colors resize-none"
            />
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" size="xs" onClick={handleAdd} disabled={!title.trim() || isExpanding}>
          {isExpanding ? 'Expanding…' : 'Save Detailed Test'}
        </Button>
        <Button variant="ghost" size="xs" onClick={reset} disabled={isExpanding}>
          Cancel
        </Button>
        {isExpanding ? (
          <span className="text-2xs text-text-muted ml-auto">AI is expanding your test…</span>
        ) : (
          <span className="text-2xs text-text-muted ml-auto">⌘↵ to save</span>
        )}
      </div>
    </div>
  );
}
