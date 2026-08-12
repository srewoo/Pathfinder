/**
 * Accessibility Audit via CDP Accessibility Tree.
 *
 * Runs basic a11y checks during exploration using the accessibility tree
 * captured via Chrome DevTools Protocol. Checks for:
 * - Missing alt text on images
 * - Missing labels on form inputs
 * - Low contrast (via computed style sampling)
 * - Keyboard accessibility (focusable interactive elements)
 * - ARIA role misuse
 *
 * Results are surfaced as a separate accessibility report alongside test results.
 */

import type { AXNode } from '../cdp/cdp-client';
import { getAccessibilityTree, isAttached, evaluate } from '../cdp/cdp-client';
import { assessContrast, type ContrastSample } from './contrast';
import { createLogger } from '../../utils/logger';

const log = createLogger('a11y-audit');

// ── Types ──────────────────────────────────────────────────────────────────

export type A11ySeverity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface A11yIssue {
  /** WCAG-inspired rule identifier */
  ruleId: string;
  /** Human-readable description of the issue */
  message: string;
  /** Severity level */
  severity: A11ySeverity;
  /** CSS selector of the offending element (if determinable) */
  selector?: string;
  /** AX node role */
  role?: string;
  /** AX node name (accessible name) */
  name?: string;
  /** WCAG guideline reference */
  wcag?: string;
  /** Suggested fix */
  suggestion: string;
}

export interface A11yAuditResult {
  /** Page URL audited */
  url: string;
  /** Page title */
  title: string;
  /** All issues found */
  issues: A11yIssue[];
  /** Summary counts by severity */
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  /** Timestamp */
  auditedAt: string;
}

// ── Roles that should have accessible names ────────────────────────────────

const ROLES_NEEDING_NAME = new Set([
  'button', 'link', 'textbox', 'combobox', 'listbox', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'checkbox',
  'radio', 'img', 'heading',
]);

/** Roles that represent interactive controls — must be keyboard-focusable */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'listbox', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'checkbox',
  'radio', 'menuitemcheckbox', 'menuitemradio', 'option',
]);

/** Roles where children are expected to be specific types */
const ROLE_CHILDREN_MAP: Record<string, string[]> = {
  list: ['listitem'],
  tablist: ['tab'],
  menu: ['menuitem', 'menuitemcheckbox', 'menuitemradio'],
  radiogroup: ['radio'],
  table: ['row', 'rowgroup'],
  row: ['cell', 'columnheader', 'rowheader', 'gridcell'],
  tree: ['treeitem'],
};

// ── Main Audit ─────────────────────────────────────────────────────────────

/**
 * Run an accessibility audit on the current page using the CDP accessibility tree.
 * Returns a structured report with all issues found.
 */
export async function runAccessibilityAudit(
  tabId: number,
  pageUrl: string,
  pageTitle: string
): Promise<A11yAuditResult> {
  const issues: A11yIssue[] = [];

  if (!isAttached(tabId)) {
    log.debug('CDP not attached — skipping a11y audit');
    return buildResult(pageUrl, pageTitle, issues);
  }

  let axTree: AXNode[];
  try {
    axTree = await getAccessibilityTree(tabId);
  } catch (err) {
    log.warn('Failed to get accessibility tree', err);
    return buildResult(pageUrl, pageTitle, issues);
  }

  if (axTree.length === 0) {
    return buildResult(pageUrl, pageTitle, issues);
  }

  // Walk the tree and check each node
  walkTree(axTree, issues);

  // DOM-based checks that supplement the AX tree
  await checkImagesInDOM(tabId, issues);
  await checkFormLabels(tabId, issues);
  await checkContrastSample(tabId, issues);

  log.info(`A11y audit for ${pageUrl}: ${issues.length} issues found`);
  return buildResult(pageUrl, pageTitle, issues);
}

// ── Tree Walking Checks ────────────────────────────────────────────────────

function walkTree(nodes: AXNode[], issues: A11yIssue[], depth = 0): void {
  for (const node of nodes) {
    const role = node.role?.value;
    const name = node.name?.value;

    if (!role || role === 'none' || role === 'presentation') continue;

    // Check 1: Interactive elements must have an accessible name
    if (ROLES_NEEDING_NAME.has(role) && (!name || name.trim().length === 0)) {
      issues.push({
        ruleId: 'missing-accessible-name',
        message: `${role} element has no accessible name (aria-label, aria-labelledby, or visible text).`,
        severity: role === 'img' ? 'critical' : 'serious',
        role,
        wcag: '4.1.2 Name, Role, Value',
        suggestion: `Add aria-label, aria-labelledby, or visible text content to the ${role} element.`,
      });
    }

    // Check 2: Images must have alt text
    if (role === 'img' && (!name || name.trim().length === 0)) {
      issues.push({
        ruleId: 'image-missing-alt',
        message: 'Image element has no alternative text.',
        severity: 'critical',
        role,
        wcag: '1.1.1 Non-text Content',
        suggestion: 'Add an alt attribute describing the image content, or alt="" if decorative.',
      });
    }

    // Check 3: Headings should not be empty
    if (role === 'heading' && (!name || name.trim().length === 0)) {
      issues.push({
        ruleId: 'empty-heading',
        message: 'Heading element has no text content.',
        severity: 'moderate',
        role,
        wcag: '1.3.1 Info and Relationships',
        suggestion: 'Add text content to the heading or remove the empty heading element.',
      });
    }

    // Check 4: Role-specific child requirements
    if (ROLE_CHILDREN_MAP[role] && node.children && node.children.length > 0) {
      const expectedChildren = ROLE_CHILDREN_MAP[role];
      const hasCorrectChild = node.children.some((child) =>
        expectedChildren.includes(child.role?.value ?? '')
      );
      if (!hasCorrectChild) {
        issues.push({
          ruleId: 'invalid-role-children',
          message: `${role} element should contain ${expectedChildren.join(' or ')} children.`,
          severity: 'moderate',
          role,
          name,
          wcag: '1.3.1 Info and Relationships',
          suggestion: `Ensure ${role} contains proper child roles: ${expectedChildren.join(', ')}.`,
        });
      }
    }

    // Check 5: Disabled state should not be on non-interactive elements
    const props = node.properties ?? [];
    const isDisabled = props.some((p) => p.name === 'disabled' && p.value.value === true);
    if (isDisabled && !INTERACTIVE_ROLES.has(role)) {
      issues.push({
        ruleId: 'disabled-non-interactive',
        message: `Non-interactive ${role} element has disabled state — this is meaningless to assistive technology.`,
        severity: 'minor',
        role,
        name,
        wcag: '4.1.2 Name, Role, Value',
        suggestion: 'Remove aria-disabled from non-interactive elements.',
      });
    }

    // Recurse into children
    if (node.children) {
      walkTree(node.children, issues, depth + 1);
    }
  }
}

// ── DOM-Based Supplement Checks ────────────────────────────────────────────

async function checkImagesInDOM(tabId: number, issues: A11yIssue[]): Promise<void> {
  try {
    const result = await evaluate(tabId, `
      (() => {
        const imgs = document.querySelectorAll('img');
        const problems = [];
        imgs.forEach(img => {
          const alt = img.getAttribute('alt');
          if (alt === null) {
            const selector = img.id ? '#' + img.id : img.className ? 'img.' + img.className.split(' ')[0] : 'img';
            problems.push({ selector, src: img.src?.slice(0, 100) });
          }
        });
        return JSON.stringify(problems.slice(0, 20));
      })()
    `);
    const problems = JSON.parse(String((result as { result?: { value?: string } })?.result?.value ?? '[]'));
    for (const p of problems) {
      // Only add if not already caught by AX tree check
      if (!issues.some((i) => i.ruleId === 'image-missing-alt' && i.selector === p.selector)) {
        issues.push({
          ruleId: 'image-missing-alt-dom',
          message: `<img> tag has no alt attribute: ${p.src}`,
          severity: 'critical',
          selector: p.selector,
          wcag: '1.1.1 Non-text Content',
          suggestion: 'Add alt="description" or alt="" for decorative images.',
        });
      }
    }
  } catch { /* non-fatal */ }
}

async function checkFormLabels(tabId: number, issues: A11yIssue[]): Promise<void> {
  try {
    const result = await evaluate(tabId, `
      (() => {
        const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
        const problems = [];
        inputs.forEach(input => {
          const hasLabel = input.id && document.querySelector('label[for="' + CSS.escape(input.id) + '"]');
          const hasAriaLabel = input.getAttribute('aria-label');
          const hasAriaLabelledBy = input.getAttribute('aria-labelledby');
          const hasTitle = input.getAttribute('title');
          const hasPlaceholder = input.getAttribute('placeholder');
          const wrappedInLabel = input.closest('label');
          if (!hasLabel && !hasAriaLabel && !hasAriaLabelledBy && !hasTitle && !wrappedInLabel) {
            const selector = input.name ? input.tagName.toLowerCase() + '[name="' + input.name + '"]'
              : input.id ? '#' + input.id
              : input.tagName.toLowerCase();
            problems.push({ selector, type: input.type || input.tagName.toLowerCase(), hasPlaceholder: !!hasPlaceholder });
          }
        });
        return JSON.stringify(problems.slice(0, 20));
      })()
    `);
    const problems = JSON.parse(String((result as { result?: { value?: string } })?.result?.value ?? '[]'));
    for (const p of problems) {
      issues.push({
        ruleId: 'form-input-missing-label',
        message: `Form ${p.type} input has no associated label${p.hasPlaceholder ? ' (placeholder is not a substitute for label)' : ''}.`,
        severity: 'serious',
        selector: p.selector,
        wcag: '1.3.1 Info and Relationships',
        suggestion: 'Add a <label for="..."> element or aria-label attribute.',
      });
    }
  } catch { /* non-fatal */ }
}

/**
 * Real contrast checking (SC 1.4.3).
 *
 * Replaces a rule that only fired when foreground and background were IDENTICAL —
 * a condition that essentially never occurs in shipped CSS, while it cited
 * "1.4.3 Contrast (Minimum)" in the report. Grey-on-grey at 1.2:1 passed.
 *
 * The page script's only job is to report colours; the ratio and the threshold are
 * computed in `contrast.ts`, where they are unit-tested against the WCAG formula.
 */
async function checkContrastSample(tabId: number, issues: A11yIssue[]): Promise<void> {
  try {
    const result = await evaluate(tabId, `
      (() => {
        const els = document.querySelectorAll('p, span, a, button, label, h1, h2, h3, h4, h5, h6, li, td, th, div');
        const out = [];
        const seen = new Set();
        for (const el of Array.from(els)) {
          if (out.length >= 60) break;
          // Only elements with their OWN text: a wrapper inherits colour from a
          // child and would be reported twice.
          const own = Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent || '')
            .join('')
            .trim();
          if (own.length < 2) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          const st = getComputedStyle(el);
          if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;

          // Walk up for the first opaque background — an element's own background
          // is usually transparent.
          let bg = 'rgba(0, 0, 0, 0)';
          let node = el;
          while (node) {
            const nbg = getComputedStyle(node).backgroundColor;
            if (nbg && nbg !== 'rgba(0, 0, 0, 0)' && nbg !== 'transparent') { bg = nbg; break; }
            const bgImage = getComputedStyle(node).backgroundImage;
            if (bgImage && bgImage !== 'none') { bg = 'IMAGE'; break; }
            node = node.parentElement;
          }

          const key = st.color + '|' + bg + '|' + st.fontSize + '|' + st.fontWeight;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            color: st.color,
            backgroundColor: bg,
            fontSizePx: parseFloat(st.fontSize) || 16,
            fontWeight: parseInt(st.fontWeight, 10) || 400,
            text: own.slice(0, 40),
            selector: el.id ? '#' + el.id : el.tagName.toLowerCase(),
          });
        }
        return JSON.stringify(out);
      })()
    `);
    const samples = JSON.parse(
      String((result as { result?: { value?: string } })?.result?.value ?? '[]')
    ) as Array<ContrastSample & { text: string; selector: string }>;

    let unassessable = 0;
    for (const sample of samples) {
      const verdict = assessContrast(sample);
      if (!verdict.assessable) { unassessable++; continue; }
      if (verdict.passes) continue;
      issues.push({
        ruleId: 'color-contrast',
        message:
          `Text "${sample.text}" has a contrast ratio of ${verdict.ratio}:1 against its ` +
          `background (${sample.color} on ${sample.backgroundColor}); ` +
          `${verdict.required}:1 is required for ${verdict.isLargeText ? 'large' : 'normal'} text ` +
          `at ${sample.fontSizePx}px/${sample.fontWeight}.`,
        severity: verdict.ratio < verdict.required / 2 ? 'critical' : 'serious',
        selector: sample.selector,
        wcag: '1.4.3 Contrast (Minimum)',
        suggestion:
          `Raise the ratio to at least ${verdict.required}:1 — darken the text, lighten the ` +
          `background, or increase the font size to qualify as large text.`,
      });
    }
    if (unassessable > 0) {
      // Said out loud: a background image has no single colour, and silently
      // skipping those samples would let the report imply they were checked.
      log.info(`Contrast: ${unassessable} sample(s) could not be assessed (background image/gradient or transparent colour).`);
    }
  } catch { /* non-fatal */ }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function buildResult(url: string, title: string, issues: A11yIssue[]): A11yAuditResult {
  const summary = {
    critical: issues.filter((i) => i.severity === 'critical').length,
    serious: issues.filter((i) => i.severity === 'serious').length,
    moderate: issues.filter((i) => i.severity === 'moderate').length,
    minor: issues.filter((i) => i.severity === 'minor').length,
    total: issues.length,
  };
  return { url, title, issues, summary, auditedAt: new Date().toISOString() };
}

/**
 * Format audit result as human-readable markdown.
 */

/**
 * What this audit does and does not cover.
 *
 * WCAG 2.1 AA has 50 success criteria. This checks 7 rules across 4 of them, so a
 * clean result means "none of these 7 rules fired" — not "the page is accessible".
 * Stating that is the difference between a useful signal and a false assurance
 * someone ships on.
 */
const AUDIT_SCOPE = [
  '### Scope of this audit',
  '',
  'Checked (7 rules, 4 WCAG 2.1 success criteria):',
  '',
  '| Rule | WCAG |',
  '|---|---|',
  '| Missing accessible name on a control | 4.1.2 Name, Role, Value |',
  '| `aria-disabled` on a non-interactive element | 4.1.2 Name, Role, Value |',
  '| Image without alt text (a11y tree + DOM) | 1.1.1 Non-text Content |',
  '| Empty heading | 1.3.1 Info and Relationships |',
  '| Invalid children for an ARIA role | 1.3.1 Info and Relationships |',
  '| Form input without a label | 1.3.1 Info and Relationships |',
  '| Text contrast below the required ratio | 1.4.3 Contrast (Minimum) |',
  '',
  '**Not checked** — a pass here says nothing about these:',
  '',
  '- Keyboard operability and focus order (2.1.1, 2.4.3, 2.4.7)',
  '- Page title and page language (2.4.2, 3.1.1)',
  '- Landmarks and bypass blocks (2.4.1)',
  '- Link purpose from context (2.4.4)',
  '- Error identification, labels and instructions (3.3.1, 3.3.2)',
  '- Reflow, zoom and text spacing (1.4.10, 1.4.12)',
  '- Status messages announced to assistive tech (4.1.3)',
  '- Heading order, table header association, autocomplete (1.3.1, 1.3.5)',
  '',
  'Contrast is sampled (up to 60 distinct colour/size combinations per page) and',
  'skips text over background images or gradients, which have no single colour.',
].join('\n');

/** Pipes and newlines would break the table row they sit in. */
function escapeCell(text: string): string {
  return (text ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

export function formatA11yReport(results: A11yAuditResult[]): string {
  const allIssues = results.flatMap((r) => r.issues);
  if (allIssues.length === 0) {
    return [
      '## Accessibility Audit',
      '',
      `No issues found across ${results.length} page(s) — for the rules listed below.`,
      '',
      AUDIT_SCOPE,
    ].join('\n');
  }

  const count = (sev: string): number => allIssues.filter((i) => i.severity === sev).length;
  const lines = [
    `# Accessibility Audit`,
    ``,
    `**${allIssues.length} issue(s)** across ${results.length} page(s).`,
    ``,
    `| Critical | Serious | Moderate | Minor |`,
    `|---:|---:|---:|---:|`,
    `| ${count('critical')} | ${count('serious')} | ${count('moderate')} | ${count('minor')} |`,
    ``,
  ];

  for (const result of results) {
    if (result.issues.length === 0) continue;
    lines.push(`## ${result.title || result.url}`, ``);
    // A table so severity, criterion and fix line up down the page instead of
    // running together in prose — these reports are scanned, not read.
    lines.push(`| Severity | Issue | Element | WCAG | Fix |`);
    lines.push(`|---|---|---|---|---|`);
    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 } as Record<string, number>;
    const sorted = [...result.issues].sort(
      (a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
    );
    for (const issue of sorted) {
      const sev = issue.severity === 'critical' || issue.severity === 'serious'
        ? `**${issue.severity.toUpperCase()}**`
        : issue.severity;
      const el = issue.selector ? `\`${issue.selector}\`` : '—';
      lines.push(
        `| ${sev} | ${escapeCell(issue.message)} | ${el} | ${issue.wcag ?? 'N/A'} | ${escapeCell(issue.suggestion)} |`
      );
    }
    lines.push(``);
  }

  lines.push('', AUDIT_SCOPE);
  return lines.join('\n');
}
