/**
 * One page of exploration, as a standalone step (fix.md §4, §13).
 *
 * The extraction that makes exploration durable. Previously the per-page work —
 * scan, discover links, capture form constraints, record APIs, judge risk — lived
 * inside a closure in the 1372-line `explorer-agent.ts`, so it could only run as
 * part of an in-memory loop that eviction destroyed.
 *
 * Pulled out here, the same work becomes a job step: the pump can run it, commit
 * the result, and survive being killed between pages. It is also the first real
 * slice off the god object, and it is testable on its own — which the closure
 * never was.
 *
 * Deliberately does NOT include click/modal interaction. That part mutates page
 * state and needs the richer machinery still in the explorer; claiming it here
 * would be a false decomposition. What this covers is the read-only mapping work,
 * which is the majority of a crawl and all of what a durable resume needs.
 */
import type { Driver } from '../driver';
import type {
  FormField,
  InteractionGraph,
  ObservedAPI,
  PageNode,
} from '../../storage/schemas';
import { riskOf, type PageRisk } from './risk-coverage';
import { normalizeUrl } from '../jobs/job-model';
import { createLogger } from '../../utils/logger';

const log = createLogger('explore-page-step');

export interface ExplorePageInput {
  url: string;
  depth: number;
  /** Origin the crawl is scoped to. Off-origin links are recorded, not followed. */
  origin: string;
  maxDepth: number;
}

export interface DiscoveredLink {
  url: string;
  text: string;
  /** False when the link leaves the crawl's origin. */
  sameOrigin: boolean;
}

export interface ExplorePageResult {
  url: string;
  title: string;
  /** Interactive element count — the breadth signal for risk weighting. */
  elementCount: number;
  formFields: FormField[];
  apiEndpoints: ObservedAPI[];
  links: DiscoveredLink[];
  /** Same-origin links within depth — what the frontier should grow by. */
  nextTargets: Array<{ url: string; depth: number; via: string }>;
  risk: PageRisk;
  /** True when the page resolved to an error page rather than content. */
  brokenLink: boolean;
  /** True when the crawl was bounced to an auth wall. */
  authWall: boolean;
}

/** URLs that indicate the crawler hit a login gate rather than the app. */
const AUTH_WALL_RX = /\/(login|signin|sign-in|auth|sso|oauth|session)(?:[/?#]|$)/i;

const PAGE_FACTS_EXPR = `(() => {
  const cap = (s, n) => String(s == null ? '' : s).slice(0, n);

  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      links.push({
        url: new URL(href, location.href).toString(),
        text: cap((a.textContent || '').replace(/\\s+/g, ' ').trim(), 120),
      });
    } catch (e) { /* unparseable href */ }
  }

  const formFields = [];
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const type = (el.getAttribute('type') || el.tagName).toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') continue;

    let label = (el.getAttribute('aria-label') || '').trim();
    if (!label && el.id) {
      const lab = document.querySelector('label[for="' + el.id + '"]');
      label = (lab && lab.textContent || '').trim();
    }
    if (!label) label = (el.getAttribute('placeholder') || '').trim();

    const opts = [];
    if (el.tagName.toLowerCase() === 'select') {
      for (const o of el.options) opts.push(cap((o.textContent || '').trim(), 60));
    }

    formFields.push({
      selector: el.id ? '#' + el.id : (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : type),
      label: label || undefined,
      type: type,
      name: el.getAttribute('name') || undefined,
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      minLength: el.getAttribute('minlength') ? Number(el.getAttribute('minlength')) : undefined,
      maxLength: el.getAttribute('maxlength') ? Number(el.getAttribute('maxlength')) : undefined,
      pattern: el.getAttribute('pattern') || undefined,
      options: opts.length ? opts : undefined,
    });
  }

  // An error page is content-poor and says so. Checking the heading and title
  // avoids treating a legitimately short page as broken.
  const heading = (document.querySelector('h1, h2') || {}).textContent || '';
  const errorish = /\\b(404|not found|page not found|500|server error|forbidden|403)\\b/i;
  const brokenLink = errorish.test(heading) || errorish.test(document.title || '');

  return {
    title: cap(document.title || '', 200),
    elementCount: document.querySelectorAll('a, button, input, select, textarea, [role="button"]').length,
    links: links,
    formFields: formFields,
    brokenLink: brokenLink,
  };
})()`;

interface PageFacts {
  title: string;
  elementCount: number;
  links: Array<{ url: string; text: string }>;
  formFields: FormField[];
  brokenLink: boolean;
}

/**
 * Explore one page.
 *
 * Read-only: it navigates, observes, and reports. Nothing here submits a form or
 * clicks a mutating control, so it is safe to run against any origin the §7 policy
 * allows and safe to REPLAY — which is what makes it a valid job step (§4).
 */
export async function explorePage(
  driver: Driver,
  input: ExplorePageInput
): Promise<ExplorePageResult> {
  await driver.navigate(input.url);

  const landedUrl = await driver.currentUrl().catch(() => input.url);
  const authWall = AUTH_WALL_RX.test(landedUrl) && !AUTH_WALL_RX.test(input.url);
  if (authWall) {
    log.warn(`Auth wall: ${input.url} redirected to ${landedUrl}`);
  }

  const facts = await driver.evaluate<PageFacts>(PAGE_FACTS_EXPR);

  // Network traffic this page produced. `page_load` context because no
  // interaction happened — labelling it `form_submit` would let the assertion
  // enricher assert a write that was never triggered by a submit.
  const apiEndpoints: ObservedAPI[] = driver
    .networkLog()
    .filter((r) => /\/api\/|\/graphql/i.test(r.url))
    .map((r) => ({
      endpoint: stripQuery(r.url),
      method: r.method,
      status: r.status,
      context: 'page_load' as const,
    }));

  const links: DiscoveredLink[] = (facts?.links ?? []).map((l) => ({
    url: l.url,
    text: l.text,
    sameOrigin: originOf(l.url) === input.origin,
  }));

  const nextTargets =
    input.depth >= input.maxDepth
      ? []
      : dedupe(
          links
            .filter((l) => l.sameOrigin)
            .map((l) => normalizeUrl(l.url))
            .filter((u) => u !== normalizeUrl(landedUrl))
        ).map((url) => ({ url, depth: input.depth + 1, via: landedUrl }));

  const node = {
    url: landedUrl,
    title: facts?.title ?? '',
    elementCount: facts?.elementCount ?? 0,
    formFields: facts?.formFields ?? [],
    apiEndpoints,
  } as PageNode;

  return {
    url: landedUrl,
    title: node.title,
    elementCount: node.elementCount,
    formFields: node.formFields ?? [],
    apiEndpoints,
    links,
    nextTargets,
    risk: riskOf(node, { authGated: authWall }),
    brokenLink: facts?.brokenLink ?? false,
    authWall,
  };
}

/** Fold a page result into the graph. Upsert semantics keep replay harmless. */
export function applyPageResult(
  graph: InteractionGraph,
  result: ExplorePageResult,
  via?: string
): void {
  const existing = graph.nodes.find((n) => n.url === result.url);
  if (existing) {
    if (result.title) existing.title = result.title;
    if (result.elementCount > 0) existing.elementCount = result.elementCount;
    if (result.formFields.length > 0) existing.formFields = result.formFields;
    if (result.apiEndpoints.length > 0) {
      existing.apiEndpoints = dedupeApis([...(existing.apiEndpoints ?? []), ...result.apiEndpoints]);
    }
  } else {
    graph.nodes.push({
      url: result.url,
      title: result.title,
      elementCount: result.elementCount,
      formFields: result.formFields,
      apiEndpoints: result.apiEndpoints,
    } as PageNode);
  }

  if (via && via !== result.url) {
    const already = graph.edges.some((e) => e.from === via && e.to === result.url);
    if (!already) {
      graph.edges.push({ from: via, to: result.url, action: 'link', selector: '', label: '' } as never);
    }
  }
}

function dedupeApis(apis: ObservedAPI[]): ObservedAPI[] {
  const seen = new Set<string>();
  const out: ObservedAPI[] = [];
  for (const a of apis) {
    const key = `${a.method} ${a.endpoint} ${a.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split('?')[0];
  }
}
