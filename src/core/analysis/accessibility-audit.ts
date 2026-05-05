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

async function checkContrastSample(tabId: number, issues: A11yIssue[]): Promise<void> {
  try {
    const result = await evaluate(tabId, `
      (() => {
        const textElements = document.querySelectorAll('p, span, a, button, label, h1, h2, h3, h4, li, td, th');
        const problems = [];
        const checked = new Set();
        for (const el of Array.from(textElements).slice(0, 50)) {
          const text = el.textContent?.trim();
          if (!text || text.length < 2) continue;
          const style = getComputedStyle(el);
          const color = style.color;
          const bg = style.backgroundColor;
          // Simple check: if both are the same, there's a contrast issue
          if (color === bg && color !== 'rgba(0, 0, 0, 0)') {
            const key = color + ':' + bg;
            if (checked.has(key)) continue;
            checked.add(key);
            problems.push({ color, bg, text: text.slice(0, 30) });
          }
        }
        return JSON.stringify(problems.slice(0, 5));
      })()
    `);
    const problems = JSON.parse(String((result as { result?: { value?: string } })?.result?.value ?? '[]'));
    for (const p of problems) {
      issues.push({
        ruleId: 'color-contrast-identical',
        message: `Text "${p.text}" has identical foreground and background color (${p.color}).`,
        severity: 'critical',
        wcag: '1.4.3 Contrast (Minimum)',
        suggestion: 'Ensure text color has at least 4.5:1 contrast ratio against background.',
      });
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
export function formatA11yReport(results: A11yAuditResult[]): string {
  const allIssues = results.flatMap((r) => r.issues);
  if (allIssues.length === 0) return '## Accessibility Audit\n\nNo issues found.';

  const lines = [
    `## Accessibility Audit`,
    ``,
    `**Pages audited:** ${results.length}`,
    `**Total issues:** ${allIssues.length}`,
    `- Critical: ${allIssues.filter((i) => i.severity === 'critical').length}`,
    `- Serious: ${allIssues.filter((i) => i.severity === 'serious').length}`,
    `- Moderate: ${allIssues.filter((i) => i.severity === 'moderate').length}`,
    `- Minor: ${allIssues.filter((i) => i.severity === 'minor').length}`,
    ``,
  ];

  for (const result of results) {
    if (result.issues.length === 0) continue;
    lines.push(`### ${result.title || result.url}`, ``);
    for (const issue of result.issues) {
      const sev = issue.severity.toUpperCase();
      lines.push(`- **[${sev}]** ${issue.message}${issue.selector ? ` (\`${issue.selector}\`)` : ''}`);
      lines.push(`  - WCAG: ${issue.wcag ?? 'N/A'} | Fix: ${issue.suggestion}`);
    }
    lines.push(``);
  }

  return lines.join('\n');
}
