import type { InteractionGraph, PageNode, PageEdge, FormField, FormSubmissionOutcome } from '../../storage/schemas.js';
import { graphRepo } from '../../storage/repositories/graph-repo.js';
import { generateId } from '../../utils/hash.js';

export function createGraph(): InteractionGraph {
  return {
    nodes: [],
    edges: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function addNode(
  graph: InteractionGraph,
  url: string,
  title: string,
  elementCount: number,
  formFields?: FormField[]
): PageNode {
  const existing = graph.nodes.find((n) => n.url === url);
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
  const exists = graph.edges.some(
    (e) => e.from === fromUrl && e.to === toUrl && e.selector === selector
  );
  if (exists) return;

  const edge: PageEdge = { from: fromUrl, to: toUrl, action, selector, label };
  graph.edges.push(edge);
  graph.updatedAt = new Date().toISOString();
}

export function addFormOutcome(
  graph: InteractionGraph,
  pageUrl: string,
  outcome: FormSubmissionOutcome
): void {
  const node = graph.nodes.find((n) => n.url === pageUrl);
  if (!node) return;
  if (!node.formOutcomes) node.formOutcomes = [];
  node.formOutcomes.push(outcome);
  graph.updatedAt = new Date().toISOString();
}

export async function saveGraph(graph: InteractionGraph): Promise<void> {
  await graphRepo.save(graph);
}

export async function loadGraph(): Promise<InteractionGraph | undefined> {
  return graphRepo.load();
}

export function serializeGraphForAI(graph: InteractionGraph): string {
  const lines: string[] = ['## Page Interaction Graph\n'];

  lines.push(`Pages discovered: ${graph.nodes.length}`);
  lines.push(`Interactions recorded: ${graph.edges.length}\n`);

  if (graph.nodes.length > 0) {
    lines.push('### Pages:');
    graph.nodes.forEach((node) => {
      lines.push(`- ${node.title || node.url} [${node.url}]`);

      if (node.breadcrumb) {
        lines.push(`  Breadcrumb: ${node.breadcrumb}`);
      }
      if (node.headings && node.headings.length > 0) {
        lines.push(`  Headings: ${node.headings.join(' | ')}`);
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
      const fromNode = graph.nodes.find((n) => n.url === from);
      const fromTitle = fromNode?.title ?? from;
      edges.forEach((edge) => {
        const toNode = graph.nodes.find((n) => n.url === edge.to);
        const toTitle = toNode?.title ?? edge.to;
        lines.push(`- ${fromTitle} → [${edge.action}: ${edge.label}] → ${toTitle} (selector: ${edge.selector})`);
      });
    });
  }

  return lines.join('\n');
}

/**
 * Flow-learning-optimised serialization for large graphs.
 * Actionable pages (forms/modals/outcomes) are fully expanded.
 * Navigation-only pages are listed as a compact single line.
 * Edges are deduplicated to unique label+destination pairs per source.
 * Typically 60-70% smaller than serializeGraphForAI on real-world sites.
 */
export function serializeGraphForFlowLearning(graph: InteractionGraph): string {
  const lines: string[] = ['## Page Interaction Graph\n'];
  lines.push(`Pages discovered: ${graph.nodes.length}`);
  lines.push(`Interactions recorded: ${graph.edges.length}\n`);

  const isActionable = (n: PageNode) =>
    (n.formFields && n.formFields.length > 0) ||
    (n.modals && n.modals.length > 0) ||
    (n.formOutcomes && n.formOutcomes.length > 0);

  const actionable = graph.nodes.filter(isActionable);
  const navOnly = graph.nodes.filter((n) => !isActionable(n));

  if (actionable.length > 0) {
    lines.push(`### Actionable Pages (${actionable.length} with forms / modals / outcomes):`);
    for (const node of actionable) {
      lines.push(`\n#### ${node.title || node.url} [${node.url}]`);
      if (node.breadcrumb) lines.push(`  Breadcrumb: ${node.breadcrumb}`);
      if (node.headings && node.headings.length > 0) lines.push(`  Headings: ${node.headings.join(' | ')}`);

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
        }
      }
    }
    lines.push('');
  }

  if (navOnly.length > 0) {
    lines.push(`### Navigation Pages (${navOnly.length} pages, no forms):`);
    for (const node of navOnly) {
      const title = node.title && node.title !== '...' ? node.title : '';
      lines.push(`- ${title ? `${title} ` : ''}[${node.url}]`);
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
      const fromNode = graph.nodes.find((n) => n.url === from);
      const fromTitle = fromNode?.title ?? from;
      for (const edge of edgeMap.values()) {
        const toNode = graph.nodes.find((n) => n.url === edge.to);
        const toTitle = toNode?.title ?? edge.to;
        lines.push(`- ${fromTitle} → [${edge.label}] → ${toTitle} (selector: ${edge.selector})`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Serialize the navigation map (edges) into a clear, AI-friendly format.
 * Shows how to reach each page from other pages via click/link actions.
 * Includes shortest-path summaries for key pages.
 */
export function serializeNavigationMap(graph: InteractionGraph): string {
  if (graph.edges.length === 0) return 'No navigation paths discovered yet — run Exploration first.';

  const lines: string[] = ['Navigation paths between pages:\n'];

  // Group edges by source page
  const byFrom = new Map<string, PageEdge[]>();
  graph.edges.forEach((edge) => {
    const list = byFrom.get(edge.from) ?? [];
    list.push(edge);
    byFrom.set(edge.from, list);
  });

  // Show outgoing links per page
  byFrom.forEach((edges, fromUrl) => {
    const fromNode = graph.nodes.find((n) => n.url === fromUrl);
    const fromTitle = fromNode?.title || fromUrl;
    lines.push(`From: ${fromTitle} [${fromUrl}]`);
    edges.forEach((edge) => {
      const toNode = graph.nodes.find((n) => n.url === edge.to);
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

  // Find likely entry point (first node, or node with most outgoing edges)
  const entryUrl = graph.nodes.length > 0 ? graph.nodes[0].url : undefined;
  // List all pages with direct URLs so the AI can navigate directly
  lines.push('');
  lines.push('Directly navigable pages (use these URLs when the target page is listed):');
  for (const node of graph.nodes) {
    lines.push(`  - ${node.title || '(untitled)'}: ${node.url}`);
  }
  lines.push('');

  if (entryUrl && graph.nodes.length > 1) {
    lines.push('Click-through paths (use ONLY when target has no direct URL above):');
    const entryTitle = graph.nodes[0].title || entryUrl;

    // BFS from entry
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

    // Show paths to each reachable page
    for (const node of graph.nodes) {
      if (node.url === entryUrl) continue;
      const path = visited.get(node.url);
      if (!path || path.length === 0) continue;
      const pathStr = path
        .map((hop) => {
          const hopNode = graph.nodes.find((n) => n.url === hop.toUrl);
          return `Click "${hop.label}" → ${hopNode?.title || hop.toUrl}`;
        })
        .join(' → ');
      lines.push(`  ${entryTitle} → ${pathStr}`);
    }
  }

  const result = lines.join('\n');
  // Cap at 6000 chars to stay within token budget
  return result.length > 6000 ? result.slice(0, 6000) + '\n... (truncated)' : result;
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
