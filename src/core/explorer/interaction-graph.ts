import type { InteractionGraph, PageNode, PageEdge, FormField, FormSubmissionOutcome } from '../../storage/schemas';
import { graphDB } from '../../storage/indexed-db';
import { generateId } from '../../utils/hash';
import { createLogger } from '../../utils/logger';

const log = createLogger('interaction-graph');

// ── O(1) Lookup Indices ─────────────────────────────────────────────────────
// Maintain URL-keyed maps for fast node/edge lookup instead of O(n) array scans.
// Indices are rebuilt on graph load and kept in sync by add/remove operations.

let nodeIndex = new Map<string, PageNode>();
let edgeIndex = new Set<string>();

function buildIndices(graph: InteractionGraph): void {
  nodeIndex = new Map(graph.nodes.map((n) => [n.url, n]));
  edgeIndex = new Set(graph.edges.map((e) => `${e.from}|${e.to}|${e.selector}`));
}

function edgeKey(from: string, to: string, selector: string): string {
  return `${from}|${to}|${selector}`;
}

export function createGraph(): InteractionGraph {
  const graph: InteractionGraph = {
    nodes: [],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  buildIndices(graph);
  return graph;
}

export function addNode(
  graph: InteractionGraph,
  url: string,
  title: string,
  elementCount: number,
  formFields?: FormField[]
): PageNode {
  // O(1) lookup via index instead of O(n) find
  const existing = nodeIndex.get(url);
  if (existing) {
    if (title && title !== '...') existing.title = title;
    if (elementCount > 0) existing.elementCount = elementCount;
    if (formFields && formFields.length > 0) existing.formFields = formFields;
    existing.visitedAt = new Date().toISOString();
    graph.updatedAt = new Date().toISOString();
    return existing;
  }

  const node: PageNode = {
    id: generateId(),
    url,
    title,
    visitedAt: new Date().toISOString(),
    elementCount,
    formFields: formFields && formFields.length > 0 ? formFields : undefined,
  };

  graph.nodes.push(node);
  nodeIndex.set(url, node);
  graph.updatedAt = new Date().toISOString();
  return node;
}

export function addEdge(
  graph: InteractionGraph,
  fromUrl: string,
  toUrl: string,
  action: string,
  selector: string,
  label: string
): void {
  // O(1) dedup via index instead of O(n) some()
  const key = edgeKey(fromUrl, toUrl, selector);
  if (edgeIndex.has(key)) return;

  const edge: PageEdge = { from: fromUrl, to: toUrl, action, selector, label };
  graph.edges.push(edge);
  edgeIndex.add(key);
  graph.updatedAt = new Date().toISOString();
}

/** Remove a node and all its edges from the graph. Updates indices. */
export function removeNode(graph: InteractionGraph, url: string): void {
  graph.nodes = graph.nodes.filter((n) => n.url !== url);
  nodeIndex.delete(url);

  const removedEdges = graph.edges.filter((e) => e.from === url || e.to === url);
  for (const e of removedEdges) {
    edgeIndex.delete(edgeKey(e.from, e.to, e.selector));
  }
  graph.edges = graph.edges.filter((e) => e.from !== url && e.to !== url);
  graph.updatedAt = new Date().toISOString();
}

/**
 * Remove nodes whose URL is NOT in `keepUrls` (pages not re-seen during a fresh
 * re-scan — i.e. deleted/unreachable). Returns the removed URLs. Edges touching
 * removed nodes are dropped too. Caller should snapshot first for reversibility.
 */
export function pruneStaleNodes(graph: InteractionGraph, keepUrls: Set<string>): string[] {
  const stale = graph.nodes.filter((n) => !keepUrls.has(n.url)).map((n) => n.url);
  for (const url of stale) removeNode(graph, url);
  return stale;
}

/** Get a node by URL in O(1). */
export function getNode(url: string): PageNode | undefined {
  return nodeIndex.get(url);
}

/** Get all edges originating from a URL. */
export function getEdgesFrom(graph: InteractionGraph, url: string): PageEdge[] {
  return graph.edges.filter((e) => e.from === url);
}

export async function saveGraph(graph: InteractionGraph): Promise<void> {
  await graphDB.save(graph);
}

/**
 * Incremental save — only writes if there are actual changes to persist.
 * Merges new nodes/edges into the stored graph without full clear + rewrite.
 */
export async function saveGraphIncremental(graph: InteractionGraph): Promise<void> {
  await graphDB.saveIncremental(graph);
}

/**
 * Save a versioned snapshot of the current graph before destructive operations.
 * Returns the snapshot ID for potential rollback.
 */
export async function saveGraphSnapshot(label?: string): Promise<string | undefined> {
  const snapshot = await graphDB.saveSnapshot(label);
  return snapshot?.id;
}

/** List all graph snapshots (newest first). */
export async function getGraphSnapshots() {
  return graphDB.getSnapshots();
}

/** Restore a previous graph snapshot. Rebuilds indices. */
export async function restoreGraphSnapshot(snapshotId: string): Promise<InteractionGraph | undefined> {
  const graph = await graphDB.restoreSnapshot(snapshotId);
  if (graph) {
    buildIndices(graph);
    log.info(`Graph restored from snapshot ${snapshotId}: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);
  }
  return graph;
}

export async function loadGraph(): Promise<InteractionGraph | undefined> {
  const graph = await graphDB.load();
  if (graph) buildIndices(graph);
  return graph;
}

export function serializeGraphForAI(graph: InteractionGraph): string {
  const lines: string[] = ['## Page Interaction Graph\n'];

  lines.push(`Pages discovered: ${graph.nodes.length}`);
  lines.push(`Interactions recorded: ${graph.edges.length}\n`);

  if (graph.nodes.length > 0) {
    lines.push('### Pages:');
    graph.nodes.forEach((node) => {
      const pageTypeTag = node.pageType ? ` [${node.pageType}]` : '';
      lines.push(`- ${node.title || node.url}${pageTypeTag} [${node.url}]`);
      if (node.urlPattern) {
        lines.push(`  Route template: ${node.urlPattern}`);
      }

      if (node.breadcrumb) {
        lines.push(`  Breadcrumb: ${node.breadcrumb}`);
      }
      if (node.headings && node.headings.length > 0) {
        lines.push(`  Headings: ${node.headings.join(' | ')}`);
      }

      if (node.actions && node.actions.length > 0) {
        lines.push(`  Available actions (${node.actions.length}):`);
        node.actions.forEach((a) => {
          lines.push(`    · "${a.label}" [${a.kind}] selector="${a.selector}"`);
        });
      }

      if (node.dataTables && node.dataTables.length > 0) {
        lines.push(`  Data tables/lists (${node.dataTables.length}):`);
        node.dataTables.forEach((t) => {
          const features: string[] = [];
          if (t.hasPagination) features.push('pagination');
          if (t.hasSorting) features.push('sorting');
          if (t.hasFiltering) features.push('filtering');
          lines.push(`    · ${t.columns ? t.columns.join(', ') : 'list'} (${t.rowCount} rows) selector="${t.selector}"${features.length > 0 ? ' [' + features.join(', ') + ']' : ''}`);
          if (t.rowActions && t.rowActions.length > 0) {
            lines.push(`      Row actions: ${t.rowActions.join(', ')}`);
          }
        });
      }

      if (node.apiEndpoints && node.apiEndpoints.length > 0) {
        lines.push(`  API endpoints (${node.apiEndpoints.length}):`);
        node.apiEndpoints.forEach((api) => {
          lines.push(`    · ${api.method} ${api.endpoint} → ${api.status} [${api.context}]`);
        });
      }

      if (node.modals && node.modals.length > 0) {
        lines.push(`  Modals/Dialogs (${node.modals.length}):`);
        node.modals.forEach((modal) => {
          lines.push(`    · Trigger: "${modal.triggerLabel}" (${modal.triggerSelector})`);
          if (modal.title) lines.push(`      Title: ${modal.title}`);
          if (modal.formFields && modal.formFields.length > 0) {
            lines.push(`      Form fields in modal:`);
            modal.formFields.forEach((f) => {
              const label = f.label || f.name || f.type;
              const req = f.required ? ' REQUIRED' : '';
              lines.push(`        · ${label} [${f.type}]${req} selector="${f.selector}"`);
            });
          }
        });
      }

      if (node.formFields && node.formFields.length > 0) {
        lines.push(`  Form fields (${node.formFields.length}):`);
        node.formFields.forEach((f) => {
          const parts: string[] = [];
          if (f.label) parts.push(`label="${f.label}"`);
          parts.push(`type=${f.type}`);
          if (f.name) parts.push(`name="${f.name}"`);
          if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
          if (f.required) parts.push('REQUIRED');
          if (f.minLength !== undefined) parts.push(`minLength=${f.minLength}`);
          if (f.maxLength !== undefined) parts.push(`maxLength=${f.maxLength}`);
          if (f.min !== undefined) parts.push(`min=${f.min}`);
          if (f.max !== undefined) parts.push(`max=${f.max}`);
          if (f.pattern) parts.push(`pattern="${f.pattern}"`);
          if (f.options && f.options.length > 0) parts.push(`options=[${f.options.join(', ')}]`);
          lines.push(`    · ${parts.join(', ')}`);
        });
      }

      if (node.formOutcomes && node.formOutcomes.length > 0) {
        lines.push(`  Form submission outcomes (${node.formOutcomes.length}):`);
        node.formOutcomes.forEach((outcome) => {
          const fields = outcome.filledFields.length > 0
            ? `fields: [${outcome.filledFields.join(', ')}]`
            : 'no fields filled';
          const msg = outcome.resultMessage ? ` — "${outcome.resultMessage}"` : '';
          const nav = outcome.resultUrl ? ` → navigated to ${outcome.resultUrl}` : '';
          lines.push(`    · Submit via ${outcome.submitSelector}: ${outcome.result}${msg}${nav} (${fields})`);
          if (outcome.fieldErrors && outcome.fieldErrors.length > 0) {
            outcome.fieldErrors.forEach((fe) => {
              lines.push(`      Field error: "${fe.fieldLabel ?? fe.fieldSelector}" → "${fe.errorMessage}"`);
            });
          }
        });
      }
    });
    lines.push('');
  }

  if (graph.edges.length > 0) {
    lines.push('### Navigation Paths:');
    const byFrom = new Map<string, PageEdge[]>();
    graph.edges.forEach((edge) => {
      const list = byFrom.get(edge.from) ?? [];
      list.push(edge);
      byFrom.set(edge.from, list);
    });

    byFrom.forEach((edges, from) => {
      // O(1) node lookup
      const fromNode = nodeIndex.get(from);
      const fromTitle = fromNode?.title ?? from;
      edges.forEach((edge) => {
        const toNode = nodeIndex.get(edge.to);
        const toTitle = toNode?.title ?? edge.to;
        lines.push(`- ${fromTitle} → [${edge.action}: ${edge.label}] → ${toTitle} (selector: ${edge.selector})`);
      });
    });
  }

  return lines.join('\n');
}

/**
 * Flow-learning-optimised serialization for large graphs.
 */
export function serializeGraphForFlowLearning(graph: InteractionGraph): string {
  const lines: string[] = ['## Page Interaction Graph\n'];
  lines.push(`Pages discovered: ${graph.nodes.length}`);
  lines.push(`Interactions recorded: ${graph.edges.length}\n`);

  const isActionable = (n: PageNode) =>
    (n.formFields && n.formFields.length > 0) ||
    (n.modals && n.modals.length > 0) ||
    (n.formOutcomes && n.formOutcomes.length > 0) ||
    (n.dataTables && n.dataTables.length > 0) ||
    (n.tabs && n.tabs.length > 0);

  const actionable = graph.nodes.filter(isActionable);
  const navOnly = graph.nodes.filter((n) => !isActionable(n));

  if (actionable.length > 0) {
    lines.push(`### Actionable Pages (${actionable.length} with forms / modals / data tables):`);
    for (const node of actionable) {
      const pageTypeTag = node.pageType ? ` [${node.pageType}]` : '';
      lines.push(`\n#### ${node.title || node.url}${pageTypeTag} [${node.url}]`);
      if (node.breadcrumb) lines.push(`  Breadcrumb: ${node.breadcrumb}`);
      if (node.headings && node.headings.length > 0) lines.push(`  Headings: ${node.headings.join(' | ')}`);
      if (node.tabs && node.tabs.length > 0) {
        lines.push(`  In-page feature tabs/views (${node.tabs.length} — generate a flow that opens and verifies each):`);
        for (const t of node.tabs) lines.push(`    · "${t.label}" → ${t.url}`);
      }

      if (node.dataTables && node.dataTables.length > 0) {
        lines.push(`  Data tables/lists (${node.dataTables.length}):`);
        for (const t of node.dataTables) {
          const features: string[] = [];
          if (t.hasPagination) features.push('pagination');
          if (t.hasSorting) features.push('sorting');
          if (t.hasFiltering) features.push('filtering');
          lines.push(`    · ${t.columns ? t.columns.join(', ') : 'list'} (${t.rowCount} rows)${features.length > 0 ? ' [' + features.join(', ') + ']' : ''}`);
          if (t.rowActions && t.rowActions.length > 0) {
            lines.push(`      Row actions: ${t.rowActions.join(', ')}`);
          }
        }
      }

      if (node.apiEndpoints && node.apiEndpoints.length > 0) {
        lines.push(`  API endpoints (${node.apiEndpoints.length}):`);
        for (const api of node.apiEndpoints) {
          lines.push(`    · ${api.method} ${api.endpoint} → ${api.status} [${api.context}]`);
        }
      }

      if (node.wizardSteps && node.wizardSteps.length > 0) {
        const ordered = [...node.wizardSteps].sort((a, b) => a.stepNumber - b.stepNumber);
        lines.push(`  Wizard / stepper (${ordered.length} steps — flow MUST traverse each step in order via Next/Continue):`);
        for (const ws of ordered) {
          const active = ws.isActive ? ' [active]' : '';
          const sel = ws.selector ? ` selector="${ws.selector}"` : '';
          lines.push(`    · Step ${ws.stepNumber}/${ws.totalSteps}: "${ws.label}"${active}${sel}`);
        }
      }

      if (node.formFields && node.formFields.length > 0) {
        lines.push(`  Form fields (${node.formFields.length}):`);
        for (const f of node.formFields) {
          const parts: string[] = [];
          if (f.label) parts.push(`label="${f.label}"`);
          parts.push(`type=${f.type}`);
          if (f.name) parts.push(`name="${f.name}"`);
          if (f.placeholder) parts.push(`placeholder="${f.placeholder}"`);
          if (f.required) parts.push('REQUIRED');
          if (f.minLength !== undefined) parts.push(`minLength=${f.minLength}`);
          if (f.maxLength !== undefined) parts.push(`maxLength=${f.maxLength}`);
          if (f.min !== undefined) parts.push(`min=${f.min}`);
          if (f.max !== undefined) parts.push(`max=${f.max}`);
          if (f.pattern) parts.push(`pattern="${f.pattern}"`);
          if (f.options && f.options.length > 0) parts.push(`options=[${f.options.join(', ')}]`);
          lines.push(`    · ${parts.join(', ')}, selector="${f.selector}"`);
        }
      }

      if (node.modals && node.modals.length > 0) {
        lines.push(`  Modals/Dialogs (${node.modals.length}):`);
        for (const modal of node.modals) {
          lines.push(`    · Trigger: "${modal.triggerLabel}" (${modal.triggerSelector})`);
          if (modal.title) lines.push(`      Title: ${modal.title}`);
          if (modal.formFields && modal.formFields.length > 0) {
            for (const f of modal.formFields) {
              const label = f.label || f.name || f.type;
              lines.push(`        · ${label} [${f.type}]${f.required ? ' REQUIRED' : ''} selector="${f.selector}"`);
            }
          }
        }
      }

      if (node.formOutcomes && node.formOutcomes.length > 0) {
        lines.push(`  Form submission outcomes:`);
        for (const outcome of node.formOutcomes) {
          const msg = outcome.resultMessage ? ` — "${outcome.resultMessage}"` : '';
          const nav = outcome.resultUrl ? ` → ${outcome.resultUrl}` : '';
          lines.push(`    · ${outcome.result}${msg}${nav}`);
          if (outcome.fieldErrors && outcome.fieldErrors.length > 0) {
            for (const fe of outcome.fieldErrors) {
              lines.push(`      Field: "${fe.fieldLabel ?? fe.fieldSelector}" → "${fe.errorMessage}"`);
            }
          }
        }
      }
    }
    lines.push('');
  }

  if (navOnly.length > 0) {
    lines.push(`### Navigation Pages (${navOnly.length} pages, no forms):`);
    for (const node of navOnly) {
      const title = node.title && node.title !== '...' ? node.title : '';
      const typeTag = node.pageType && node.pageType !== 'other' ? ` [${node.pageType}]` : '';
      lines.push(`- ${title ? `${title}` : ''}${typeTag} [${node.url}]`);
    }
    lines.push('');
  }

  if (graph.edges.length > 0) {
    lines.push('### Navigation Paths (click-discovered):');
    const byFrom = new Map<string, Map<string, PageEdge>>();
    for (const edge of graph.edges) {
      if (!byFrom.has(edge.from)) byFrom.set(edge.from, new Map());
      const key = `${edge.label}→${edge.to}`;
      byFrom.get(edge.from)!.set(key, edge);
    }

    for (const [from, edgeMap] of byFrom) {
      const fromNode = nodeIndex.get(from);
      const fromTitle = fromNode?.title ?? from;
      for (const edge of edgeMap.values()) {
        const toNode = nodeIndex.get(edge.to);
        const toTitle = toNode?.title ?? edge.to;
        lines.push(`- ${fromTitle} → [${edge.label}] → ${toTitle} (selector: ${edge.selector})`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Serialize the navigation map for AI consumption.
 */
export function serializeNavigationMap(graph: InteractionGraph): string {
  if (graph.edges.length === 0) return 'No navigation paths discovered yet — run Exploration first.';

  const lines: string[] = ['Navigation paths between pages:\n'];

  const byFrom = new Map<string, PageEdge[]>();
  graph.edges.forEach((edge) => {
    const list = byFrom.get(edge.from) ?? [];
    list.push(edge);
    byFrom.set(edge.from, list);
  });

  byFrom.forEach((edges, fromUrl) => {
    const fromNode = nodeIndex.get(fromUrl);
    const fromTitle = fromNode?.title || fromUrl;
    lines.push(`From: ${fromTitle} [${fromUrl}]`);
    edges.forEach((edge) => {
      const toNode = nodeIndex.get(edge.to);
      const toTitle = toNode?.title || edge.to;
      lines.push(`  → Click "${edge.label}" (${edge.selector}) → ${toTitle} [${edge.to}]`);
    });
    lines.push('');
  });

  // Build adjacency list for BFS shortest paths
  const adjacency = new Map<string, Array<{ to: string; label: string; selector: string }>>();
  graph.edges.forEach((edge) => {
    const list = adjacency.get(edge.from) ?? [];
    list.push({ to: edge.to, label: edge.label, selector: edge.selector });
    adjacency.set(edge.from, list);
  });

  const entryUrl = graph.nodes.length > 0 ? graph.nodes[0].url : undefined;
  lines.push('');
  lines.push('Directly navigable pages (use these URLs when the target page is listed):');
  for (const node of graph.nodes) {
    lines.push(`  - ${node.title || '(untitled)'}: ${node.url}`);
  }
  lines.push('');

  if (entryUrl && graph.nodes.length > 1) {
    lines.push('Click-through paths (use ONLY when target has no direct URL above):');
    const entryTitle = graph.nodes[0].title || entryUrl;

    const visited = new Map<string, Array<{ label: string; selector: string; toUrl: string }>>();
    visited.set(entryUrl, []);
    const queue = [entryUrl];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentPath = visited.get(current)!;
      const neighbors = adjacency.get(current) ?? [];

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.to)) {
          const newPath = [...currentPath, { label: neighbor.label, selector: neighbor.selector, toUrl: neighbor.to }];
          visited.set(neighbor.to, newPath);
          queue.push(neighbor.to);
        }
      }
    }

    for (const node of graph.nodes) {
      if (node.url === entryUrl) continue;
      const path = visited.get(node.url);
      if (!path || path.length === 0) continue;
      const pathStr = path
        .map((hop) => {
          const hopNode = nodeIndex.get(hop.toUrl);
          return `Click "${hop.label}" → ${hopNode?.title || hop.toUrl}`;
        })
        .join(' → ');
      lines.push(`  ${entryTitle} → ${pathStr}`);
    }
  }

  const result = lines.join('\n');
  return result.length > 6000 ? result.slice(0, 6000) + '\n... (truncated)' : result;
}

/**
 * Extract form fields as structured JSON for AI prompts.
 */
export function extractFormFieldsStructured(graph: InteractionGraph): string {
  interface FieldSchema {
    selector: string;
    label?: string;
    type: string;
    name?: string;
    placeholder?: string;
    required: boolean;
    constraints: Record<string, unknown>;
    validExample?: string;
    invalidExample?: string;
  }

  interface PageFormSchema {
    page: string;
    url: string;
    pageType?: string;
    fields: FieldSchema[];
    submissionOutcomes?: Array<{
      result: string;
      message?: string;
      navigatedTo?: string;
      fieldErrors?: Array<{ field: string; error: string }>;
      submitSelector: string;
    }>;
    modals?: Array<{
      trigger: string;
      triggerSelector: string;
      title?: string;
      fields: FieldSchema[];
    }>;
  }

  function buildFieldSchema(f: FormField): FieldSchema {
    const constraints: Record<string, unknown> = {};
    if (f.minLength !== undefined) constraints.minLength = f.minLength;
    if (f.maxLength !== undefined) constraints.maxLength = f.maxLength;
    if (f.min !== undefined) constraints.min = f.min;
    if (f.max !== undefined) constraints.max = f.max;
    if (f.pattern) constraints.pattern = f.pattern;
    if (f.options && f.options.length > 0) constraints.options = f.options;

    return {
      selector: f.selector,
      label: f.label,
      type: f.type,
      name: f.name,
      placeholder: f.placeholder,
      required: f.required,
      constraints,
      validExample: generateValidExample(f),
      invalidExample: f.required ? generateInvalidExample(f) : undefined,
    };
  }

  const pages: PageFormSchema[] = [];

  for (const node of graph.nodes) {
    const hasFields = node.formFields && node.formFields.length > 0;
    const hasOutcomes = node.formOutcomes && node.formOutcomes.length > 0;
    const hasModals = node.modals?.some((m) => m.formFields && m.formFields.length > 0);
    if (!hasFields && !hasOutcomes && !hasModals) continue;

    const page: PageFormSchema = {
      page: node.title || node.url,
      url: node.url,
      pageType: node.pageType,
      fields: (node.formFields ?? []).map(buildFieldSchema),
    };

    if (node.formOutcomes && node.formOutcomes.length > 0) {
      page.submissionOutcomes = node.formOutcomes.map((o) => ({
        result: o.result,
        message: o.resultMessage,
        navigatedTo: o.resultUrl,
        fieldErrors: o.fieldErrors?.map((fe) => ({
          field: fe.fieldLabel ?? fe.fieldSelector,
          error: fe.errorMessage,
        })),
        submitSelector: o.submitSelector,
      }));
    }

    if (node.modals) {
      const modalSchemas = node.modals
        .filter((m) => m.formFields && m.formFields.length > 0)
        .map((m) => ({
          trigger: m.triggerLabel,
          triggerSelector: m.triggerSelector,
          title: m.title,
          fields: (m.formFields ?? []).map(buildFieldSchema),
        }));
      if (modalSchemas.length > 0) page.modals = modalSchemas;
    }

    pages.push(page);
  }

  if (pages.length === 0) return 'No form fields captured.';

  return '```json\n' + JSON.stringify(pages, null, 2) + '\n```';
}

function generateValidExample(f: FormField): string {
  switch (f.type) {
    case 'email': return 'user@example.com';
    case 'tel': return '+1234567890';
    case 'url': return 'https://example.com';
    case 'number': return f.min ?? '1';
    case 'date': return '2025-01-15';
    case 'datetime-local': return '2025-01-15T10:30';
    case 'time': return '10:30';
    case 'color': return '#ff0000';
    case 'select': return f.options?.[0] ?? '';
    case 'textarea': return 'Test description text.';
    case 'password': return 'TestPassword123!';
    default: {
      const ctx = [f.name, f.label, f.placeholder].filter(Boolean).join(' ').toLowerCase();
      if (ctx.includes('first') && ctx.includes('name')) return 'Jane';
      if (ctx.includes('last') && ctx.includes('name')) return 'Doe';
      if (ctx.includes('full') && ctx.includes('name')) return 'Jane Doe';
      if (ctx.includes('name')) return 'Test User';
      if (ctx.includes('email')) return 'test@example.com';
      if (ctx.includes('company') || ctx.includes('organization')) return 'Acme Corp';
      if (ctx.includes('title') || ctx.includes('subject')) return 'Test Title';
      if (ctx.includes('description') || ctx.includes('summary') || ctx.includes('note')) return 'Automated test description';
      if (ctx.includes('address') || ctx.includes('street')) return '123 Test Street';
      if (ctx.includes('city')) return 'San Francisco';
      if (ctx.includes('state') || ctx.includes('province')) return 'California';
      if (ctx.includes('zip') || ctx.includes('postal')) return '94102';
      if (ctx.includes('country')) return 'United States';
      if (ctx.includes('phone') || ctx.includes('mobile')) return '+14155551234';
      if (ctx.includes('website') || ctx.includes('homepage')) return 'https://example.com';
      if (ctx.includes('username') || ctx.includes('login')) return 'testuser01';
      if (ctx.includes('tag') || ctx.includes('keyword')) return 'test-tag';
      if (ctx.includes('code') || ctx.includes('sku') || ctx.includes('reference')) return 'TST-001';
      if (ctx.includes('price') || ctx.includes('amount') || ctx.includes('cost')) return '99.99';
      if (ctx.includes('quantity') || ctx.includes('count')) return '5';
      if (ctx.includes('percent') || ctx.includes('rate')) return '15';
      if (ctx.includes('comment') || ctx.includes('feedback') || ctx.includes('message')) return 'Test feedback message';
      if (f.placeholder) return f.placeholder;
      return 'Test input';
    }
  }
}

function generateInvalidExample(f: FormField): string {
  switch (f.type) {
    case 'email': return 'not-an-email';
    case 'tel': return 'abc123';
    case 'url': return 'not-a-url';
    case 'number': {
      const min = f.min ? parseFloat(f.min) : 0;
      return String(min - 1);
    }
    default: return '';
  }
}

/** Extract all form fields across all pages for use in test generation. */
export function extractAllFormFields(graph: InteractionGraph): string {
  const lines: string[] = [];
  graph.nodes.forEach((node) => {
    if ((!node.formFields || node.formFields.length === 0) && (!node.formOutcomes || node.formOutcomes.length === 0)) return;
    lines.push(`Page: ${node.title || node.url}`);
    if (node.formFields && node.formFields.length > 0) {
      node.formFields.forEach((f) => {
        const constraints: string[] = [];
        if (f.required) constraints.push('required');
        if (f.minLength !== undefined) constraints.push(`minLength=${f.minLength}`);
        if (f.maxLength !== undefined) constraints.push(`maxLength=${f.maxLength}`);
        if (f.min !== undefined) constraints.push(`min=${f.min}`);
        if (f.max !== undefined) constraints.push(`max=${f.max}`);
        if (f.pattern) constraints.push(`pattern=${f.pattern}`);
        if (f.options && f.options.length > 0) constraints.push(`options: ${f.options.join(', ')}`);
        const label = f.label || f.name || f.placeholder || f.type;
        lines.push(`  - ${label} [${f.type}] selector="${f.selector}"${constraints.length ? ': ' + constraints.join(', ') : ''}`);
      });
    }
    if (node.formOutcomes && node.formOutcomes.length > 0) {
      lines.push('  Observed submission outcomes:');
      node.formOutcomes.forEach((outcome) => {
        const msg = outcome.resultMessage ? ` — "${outcome.resultMessage}"` : '';
        const nav = outcome.resultUrl ? ` → ${outcome.resultUrl}` : '';
        const fields = outcome.filledFields.length > 0
          ? ` (filled: ${outcome.filledFields.join(', ')})`
          : ' (empty submission)';
        lines.push(`    · ${outcome.result}${msg}${nav}${fields}`);
        if (outcome.errorSelectors && outcome.errorSelectors.length > 0) {
          lines.push(`      Error message selectors: ${outcome.errorSelectors.join(', ')}`);
        }
      });
    }
  });
  return lines.length > 0 ? lines.join('\n') : 'No form fields captured.';
}

export function addFormOutcome(
  graph: InteractionGraph,
  pageUrl: string,
  outcome: FormSubmissionOutcome
): void {
  // O(1) node lookup
  const node = nodeIndex.get(pageUrl);
  if (!node) return;
  if (!node.formOutcomes) node.formOutcomes = [];
  node.formOutcomes.push(outcome);
  graph.updatedAt = new Date().toISOString();
}
