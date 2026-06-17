import type {
  Flow,
  FlowStep,
  InteractionGraph,
  PageNode,
  PageEdge,
  FormField,
  FormSubmissionOutcome,
} from '../../storage/schemas';
import { simpleHash } from '../../utils/hash';

/**
 * Phase 1 of the graph-first flow design (see ADR/discussion): the interaction
 * graph IS the universe of possible flows. Every path through it and every
 * actionable element on a page is a candidate flow. This module enumerates that
 * universe **deterministically** — no LLM — so completeness is a property of the
 * graph traversal, not of a non-deterministic single-shot extraction.
 *
 * The LLM layer (existing `extractFlows*`) still runs on top to narrate richer,
 * cross-feature journeys; these skeletons guarantee the floor of coverage that
 * the LLM used to silently drop (the "click Learn Flows multiple times" symptom).
 *
 * Output is `FlowDraft` (= a Flow minus persistence fields). Each draft carries a
 * deterministic `signature` derived purely from its steps, so identical drafts
 * from any source collapse to one (structural dedup) and re-runs are stable.
 */

export type FlowDraft = Omit<Flow, 'flowId' | 'createdAt' | 'updatedAt'>;

// ── Bounds: prevent path explosion on dense graphs ──────────────────────────
const MAX_PATH_DEPTH = 4;
const MAX_NAV_PATHS = 150;
const MAX_SKELETONS = 600;
/** When a form has no REQUIRED fields, fill at most this many fields for the happy path. */
const MAX_OPTIONAL_FIELDS_TO_FILL = 4;

/**
 * Deterministic identity of a single step: its action + the most stable target
 * key available (selector > full URL > target text > value). Used to compute a
 * flow signature so two flows that do the same thing collapse, regardless of
 * prose differences in their name/description.
 */
/** Data-entry actions whose entered VALUE is part of the step's identity. */
const FILL_ACTIONS = new Set(['type', 'fill', 'select', 'check', 'uncheck', 'clear']);

function stepSignature(step: FlowStep): string {
  const action = (step.action || '').toLowerCase().trim();
  const sel = step.selector?.trim();
  const urlVal = step.value && /^https?:\/\//i.test(step.value) ? normalizeFullUrl(step.value) : '';
  const key = sel || urlVal || step.target?.toLowerCase().trim() || step.value?.toLowerCase().trim() || '';
  // For data-entry steps the entered value distinguishes coverage variants that
  // target the SAME field (happy "Jane" vs boundary "xxxxxxxxxxx") — otherwise
  // they'd collapse to one signature and the negative/edge variant would vanish.
  const valuePart = FILL_ACTIONS.has(action) && step.value ? `=${step.value.toLowerCase().trim()}` : '';
  return `${action}:${key}${valuePart}`;
}

/**
 * Stable, content-derived signature for a flow. Two flows with the same sequence
 * of (action, target) are the same flow. Exported for structural dedup and for
 * the Phase-3 reconcile-by-stable-id work.
 */
export function flowSignature(steps: FlowStep[]): string {
  return steps.map(stepSignature).join(' > ');
}

/** Short stable id derived from the signature (e.g. for logging / future keys). */
export function flowSignatureId(steps: FlowStep[]): string {
  return `sk_${simpleHash(flowSignature(steps))}`;
}

/**
 * Full-URL normalization that PRESERVES the query/hash (unlike the page-level
 * normalizeUrl which strips them). Feature tabs differ only by query param
 * (?aiFeatureTab=overview), so we must keep it to tell them apart. Sorts query
 * params and drops a trailing slash so trivially-different URLs still collapse.
 */
function normalizeFullUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.sort();
    let path = u.pathname.replace(/\/+$/, '') || '/';
    const q = u.searchParams.toString();
    return `${u.origin}${path}${q ? `?${q}` : ''}${u.hash}`;
  } catch {
    return url.trim();
  }
}

function pageLabel(node: PageNode): string {
  if (node.title && node.title !== '...') return node.title;
  try {
    const segs = new URL(node.url).pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    return last.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || node.url;
  } catch {
    return node.url;
  }
}

/** A realistic example value for a form field, derived deterministically from its type/label. */
function exampleValue(f: FormField): string {
  const t = (f.type || 'text').toLowerCase();
  switch (t) {
    case 'email': return 'test@example.com';
    case 'tel': return '+14155551234';
    case 'url': return 'https://example.com';
    case 'number': return f.min ?? '1';
    case 'date': return '2025-01-15';
    case 'datetime-local': return '2025-01-15T10:30';
    case 'time': return '10:30';
    case 'password': return 'TestPassword123!';
    case 'select': return f.options?.[0] ?? '';
    case 'textarea': return 'Automated test input.';
    default: {
      const ctx = [f.name, f.label, f.placeholder].filter(Boolean).join(' ').toLowerCase();
      if (ctx.includes('email')) return 'test@example.com';
      if (ctx.includes('first') && ctx.includes('name')) return 'Jane';
      if (ctx.includes('last') && ctx.includes('name')) return 'Doe';
      if (ctx.includes('name')) return 'Test User';
      if (ctx.includes('phone') || ctx.includes('mobile')) return '+14155551234';
      if (ctx.includes('company') || ctx.includes('organization')) return 'Acme Corp';
      if (ctx.includes('title') || ctx.includes('subject')) return 'Test Title';
      if (ctx.includes('description') || ctx.includes('note') || ctx.includes('comment')) return 'Automated test input.';
      return 'Test input';
    }
  }
}

/** Map an input field to the appropriate fill action. */
function fillActionFor(f: FormField): string {
  const t = (f.type || 'text').toLowerCase();
  if (t === 'select') return 'select';
  if (t === 'checkbox' || t === 'radio') return 'check';
  return 'type';
}

function fieldLabel(f: FormField): string {
  return f.label || f.name || f.placeholder || f.type || 'field';
}

// ── Enumerators (one per evidence type in the graph) ─────────────────────────

/** Multi-hop navigation journeys: bounded DFS over edges from entry pages. */
function enumerateNavigationPaths(graph: InteractionGraph): FlowDraft[] {
  if (graph.edges.length === 0) return [];

  const adjacency = new Map<string, PageEdge[]>();
  const inDegree = new Map<string, number>();
  for (const node of graph.nodes) inDegree.set(node.url, 0);
  for (const edge of graph.edges) {
    (adjacency.get(edge.from) ?? adjacency.set(edge.from, []).get(edge.from)!).push(edge);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Entry points = pages nothing links INTO (true sources). Fall back to all
  // pages with outgoing edges if the graph is fully cyclic (no sources).
  let entries = graph.nodes.filter((n) => (inDegree.get(n.url) ?? 0) === 0 && adjacency.has(n.url));
  if (entries.length === 0) entries = graph.nodes.filter((n) => adjacency.has(n.url));

  const nodeByUrl = new Map(graph.nodes.map((n) => [n.url, n]));
  const drafts: FlowDraft[] = [];
  const seenPaths = new Set<string>();

  const dfs = (current: string, visited: Set<string>, hops: PageEdge[]): void => {
    if (drafts.length >= MAX_NAV_PATHS) return;
    if (hops.length >= 1) {
      const pathSig = hops.map((h) => h.selector).join('|');
      if (!seenPaths.has(pathSig)) {
        seenPaths.add(pathSig);
        const draft = navPathToDraft(hops, nodeByUrl);
        if (draft) drafts.push(draft);
      }
    }
    if (hops.length >= MAX_PATH_DEPTH) return;
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.to)) continue; // no cycles
      visited.add(edge.to);
      dfs(edge.to, visited, [...hops, edge]);
      visited.delete(edge.to);
      if (drafts.length >= MAX_NAV_PATHS) return;
    }
  };

  for (const entry of entries) {
    if (drafts.length >= MAX_NAV_PATHS) break;
    dfs(entry.url, new Set([entry.url]), []);
  }

  return drafts;
}

function navPathToDraft(hops: PageEdge[], nodeByUrl: Map<string, PageNode>): FlowDraft | undefined {
  const startUrl = hops[0].from;
  const startNode = nodeByUrl.get(startUrl);
  const startLabel = startNode ? pageLabel(startNode) : startUrl;
  const destNode = nodeByUrl.get(hops[hops.length - 1].to);
  const destLabel = destNode ? pageLabel(destNode) : hops[hops.length - 1].to;

  const steps: FlowStep[] = [
    { order: 1, action: 'navigate', value: startUrl, target: startUrl, description: `Open ${startLabel}` },
  ];
  let order = 2;
  const labels: string[] = [startLabel];
  for (const hop of hops) {
    const toNode = nodeByUrl.get(hop.to);
    const toLabel = toNode ? pageLabel(toNode) : hop.to;
    labels.push(toLabel);
    steps.push({
      order: order++,
      action: 'click',
      target: hop.label,
      selector: hop.selector,
      description: `Click "${hop.label}" to go to ${toLabel}`,
    });
  }
  const verifyTarget = (destNode?.headings && destNode.headings[0]) || destLabel;
  steps.push({
    order: order++,
    action: 'verify',
    target: verifyTarget,
    description: `Verify ${destLabel} loaded`,
    expectedOutcome: `"${verifyTarget}" is visible`,
  });

  return {
    name: `Navigate: ${labels.join(' → ')}`,
    description: `Walk the path ${labels.join(' → ')} and verify the destination loads. Auto-generated from the exploration graph.`,
    source: 'exploration',
    coverageType: 'navigation',
    steps,
  };
}

/** Pick the first field carrying a boundary constraint we can violate. */
function findConstrainedField(fields: FormField[]): FormField | undefined {
  return fields.find((f) => f.maxLength !== undefined || f.max !== undefined || (f.pattern && f.pattern.length > 0));
}

/** A value that deliberately violates a field's boundary constraint. */
function boundaryViolation(f: FormField): { value: string; why: string } | undefined {
  if (f.maxLength !== undefined) {
    return { value: 'x'.repeat(f.maxLength + 1), why: `exceeds the ${f.maxLength}-character maximum` };
  }
  if (f.max !== undefined) {
    const max = parseFloat(f.max);
    if (!Number.isNaN(max)) return { value: String(max + 1), why: `is above the maximum of ${f.max}` };
  }
  if (f.pattern && f.pattern.length > 0) {
    return { value: '!!!invalid!!!', why: `does not match the required format (${f.pattern})` };
  }
  return undefined;
}

/** Form happy-path + (evidence-based) validation-error skeletons. */
function enumerateFormFlows(node: PageNode): FlowDraft[] {
  const fields = node.formFields ?? [];
  if (fields.length === 0) return [];

  const label = pageLabel(node);
  const outcome = (node.formOutcomes ?? [])[0];
  const submitSelector = outcome?.submitSelector;
  const required = fields.filter((f) => f.required);
  const toFill = required.length > 0 ? required : fields.slice(0, MAX_OPTIONAL_FIELDS_TO_FILL);
  const drafts: FlowDraft[] = [];

  // Happy path — fill (required or first few) fields validly, submit, verify outcome.
  const happySteps: FlowStep[] = [
    { order: 1, action: 'navigate', value: node.url, target: node.url, description: `Open ${label}` },
  ];
  let order = 2;
  for (const f of toFill) {
    happySteps.push({
      order: order++,
      action: fillActionFor(f),
      target: fieldLabel(f),
      selector: f.selector,
      value: exampleValue(f),
      description: `Enter ${fieldLabel(f)}`,
    });
  }
  happySteps.push({
    order: order++,
    action: 'click',
    target: 'Submit',
    selector: submitSelector,
    description: 'Submit the form',
    expectedOutcome: outcomeExpectation(outcome, 'success'),
  });
  drafts.push({
    name: `Submit form: ${label}`,
    description: `Fill ${label} with valid data and submit. Auto-generated from captured form fields.`,
    source: 'exploration',
    coverageType: 'happy',
    steps: happySteps,
  });

  // Negative path — only when there's a required field to omit (graph evidence
  // that validation exists). Submit empty and expect a validation error.
  if (required.length > 0) {
    drafts.push({
      name: `Validation: ${label} rejects empty submit`,
      description: `Submit ${label} without filling required fields and verify a validation error appears. Auto-generated negative path.`,
      source: 'exploration',
      coverageType: 'validation',
      steps: [
        { order: 1, action: 'navigate', value: node.url, target: node.url, description: `Open ${label}` },
        {
          order: 2,
          action: 'click',
          target: 'Submit',
          selector: submitSelector,
          description: 'Submit the form without entering required fields',
          expectedOutcome: 'A validation error is shown and the form is not submitted',
        },
      ],
    });
  }

  // Boundary path — only when a field carries a violable constraint
  // (maxLength / max / pattern). Enter an out-of-bounds value and expect rejection.
  const constrained = findConstrainedField(fields);
  const violation = constrained ? boundaryViolation(constrained) : undefined;
  if (constrained && violation) {
    drafts.push({
      name: `Boundary: ${fieldLabel(constrained)} on ${label}`,
      description: `Enter a value that ${violation.why} into "${fieldLabel(constrained)}" on ${label} and verify it is rejected. Auto-generated boundary path.`,
      source: 'exploration',
      coverageType: 'boundary',
      steps: [
        { order: 1, action: 'navigate', value: node.url, target: node.url, description: `Open ${label}` },
        {
          order: 2,
          action: fillActionFor(constrained),
          target: fieldLabel(constrained),
          selector: constrained.selector,
          value: violation.value,
          description: `Enter a value that ${violation.why}`,
        },
        {
          order: 3,
          action: 'click',
          target: 'Submit',
          selector: submitSelector,
          description: 'Submit the form',
          expectedOutcome: 'The out-of-bounds value is rejected with a validation error',
        },
      ],
    });
  }

  return drafts;
}

function outcomeExpectation(
  outcome: FormSubmissionOutcome | undefined,
  intent: 'success'
): string {
  if (!outcome) return intent === 'success' ? 'The form submits successfully' : 'A validation error is shown';
  if (outcome.result === 'navigation' && outcome.resultUrl) return `The app navigates to ${outcome.resultUrl}`;
  if (outcome.result === 'success') return outcome.resultMessage ? `"${outcome.resultMessage}" is shown` : 'A success message is shown';
  if (outcome.result === 'validation_error') return outcome.resultMessage ? `"${outcome.resultMessage}" is shown` : 'A validation error is shown';
  return 'The form submits successfully';
}

/** Modal skeletons: open a dialog and (if it has a form) fill + submit. */
function enumerateModalFlows(node: PageNode): FlowDraft[] {
  const modals = node.modals ?? [];
  if (modals.length === 0) return [];
  const label = pageLabel(node);

  return modals.map((modal): FlowDraft => {
    const steps: FlowStep[] = [
      { order: 1, action: 'navigate', value: node.url, target: node.url, description: `Open ${label}` },
      {
        order: 2,
        action: 'click',
        target: modal.triggerLabel,
        selector: modal.triggerSelector,
        description: `Click "${modal.triggerLabel}" to open the dialog`,
        expectedOutcome: modal.title ? `The "${modal.title}" dialog opens` : 'A dialog opens',
      },
    ];
    let order = 3;
    for (const f of (modal.formFields ?? []).filter((x) => x.required).slice(0, MAX_OPTIONAL_FIELDS_TO_FILL)) {
      steps.push({
        order: order++,
        action: fillActionFor(f),
        target: fieldLabel(f),
        selector: f.selector,
        value: exampleValue(f),
        description: `Enter ${fieldLabel(f)} in the dialog`,
      });
    }
    return {
      name: `Open dialog: ${modal.triggerLabel} (${label})`,
      description: `Open the "${modal.triggerLabel}" dialog on ${label}${modal.title ? ` ("${modal.title}")` : ''} and verify it appears. Auto-generated from captured modals.`,
      source: 'exploration',
      coverageType: 'exploratory',
      steps,
    };
  });
}

/** Feature-tab skeletons: open each in-page view and verify it renders. */
function enumerateTabFlows(node: PageNode): FlowDraft[] {
  const tabs = node.tabs ?? [];
  if (tabs.length === 0) return [];
  const label = pageLabel(node);
  return tabs.map((tab): FlowDraft => ({
    name: `Open ${tab.label} (${label})`,
    description: `Open the "${tab.label}" view and verify it loads. Auto-generated feature-tab coverage.`,
    source: 'exploration',
    coverageType: 'exploratory',
    steps: [
      { order: 1, action: 'navigate', value: tab.url, target: tab.url, description: `Open ${tab.label}` },
      { order: 2, action: 'verify', target: tab.label, description: `Verify the "${tab.label}" view is shown`, expectedOutcome: `The "${tab.label}" view is displayed` },
    ],
  }));
}

/** Data-table row-action skeletons: exercise a captured row action (Edit/View/…). */
function enumerateTableFlows(node: PageNode): FlowDraft[] {
  const tables = node.dataTables ?? [];
  if (tables.length === 0) return [];
  const label = pageLabel(node);
  const drafts: FlowDraft[] = [];
  for (const table of tables) {
    for (const rowAction of table.rowActions ?? []) {
      drafts.push({
        name: `${rowAction} row in ${label}`,
        description: `On ${label}, exercise the "${rowAction}" action on a list row. Auto-generated from a captured data table.`,
        source: 'exploration',
        coverageType: 'exploratory',
        steps: [
          { order: 1, action: 'navigate', value: node.url, target: node.url, description: `Open ${label}` },
          { order: 2, action: 'click', target: rowAction, description: `Click "${rowAction}" on the first row`, expectedOutcome: 'The row action opens a view, dialog, or result' },
        ],
      });
    }

    // Empty-state coverage — only when a table was captured with zero rows
    // (graph evidence of a no-data state worth asserting).
    if (table.rowCount === 0) {
      drafts.push({
        name: `Empty state: ${label}`,
        description: `Open ${label} when it has no data and verify the empty state renders correctly. Auto-generated empty-state coverage.`,
        source: 'exploration',
        coverageType: 'empty',
        steps: [
          { order: 1, action: 'navigate', value: node.url, target: node.url, description: `Open ${label}` },
          { order: 2, action: 'verify', target: 'empty-state', description: 'Verify an empty / no-data state is shown', expectedOutcome: 'A "no data" / empty placeholder is visible instead of rows' },
        ],
      });
    }
  }
  return drafts;
}

/**
 * Enumerate the complete deterministic set of candidate flows from the graph.
 * Output is structurally de-duplicated (by step signature). Bounded by
 * MAX_SKELETONS to stay safe on very large graphs.
 */
export function enumerateSkeletons(graph: InteractionGraph | undefined): FlowDraft[] {
  if (!graph || graph.nodes.length === 0) return [];

  const all: FlowDraft[] = [];
  all.push(...enumerateNavigationPaths(graph));
  for (const node of graph.nodes) {
    if (node.isErrorPage) continue;
    all.push(...enumerateFormFlows(node));
    all.push(...enumerateModalFlows(node));
    all.push(...enumerateTabFlows(node));
    all.push(...enumerateTableFlows(node));
  }

  const deduped = dedupeBySignature(all);
  return deduped.slice(0, MAX_SKELETONS);
}

/**
 * Structural de-duplication: collapse flows whose step signatures are identical.
 * The FIRST occurrence wins, so callers should order richer sources (LLM flows)
 * before generated skeletons to keep the most descriptive version.
 */
export function dedupeBySignature(flows: FlowDraft[]): FlowDraft[] {
  const seen = new Set<string>();
  const result: FlowDraft[] = [];
  for (const flow of flows) {
    if (!flow.steps || flow.steps.length === 0) continue;
    const sig = flowSignature(flow.steps);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(flow);
  }
  return result;
}
