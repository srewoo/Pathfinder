import { executeAction } from './dom-actions';
import { detectInteractiveElements, detectFormFields, extractSameOriginLinks, revealPageContent } from './element-detector';
import type { FormField, PageAction, DataTable, PageType, FieldError } from '../storage/schemas';
import { compressDOM, serializeCompressedDOM } from '../utils/dom-compress';
import { waitForDOMIdle, installNetworkTracker } from './dom-observer';
import type { ContentScriptMessage, ContentScriptResponse } from '../messaging/messages';
import type { PageSnapshot } from '../storage/schemas';

// Install network tracking early so all fetch/XHR calls are intercepted
installNetworkTracker();

function detectFormMessageElements(): {
  hasError: boolean;
  hasSuccess: boolean;
  message?: string;
  selectors?: string[];
} {
  const errorSelectors = [
    // ARIA roles
    '[role="alert"]',
    // Common class-based error patterns
    '.error', '.error-message', '.field-error', '.form-error',
    '.invalid-feedback', '.validation-error', '.has-error',
    '.form-error-message', '.input-error', '.help-block.error',
    // Framework-specific
    '.ant-form-item-explain-error',              // Ant Design
    '.MuiFormHelperText-root.Mui-error',         // MUI
    '.chakra-form__error-message',               // Chakra UI
    '.invalid-tooltip',                          // Bootstrap 5
    // Tailwind / utility patterns
    '.text-red-500', '.text-red-600', '.text-danger', '.text-error',
    // HTML5 validation state
    '[aria-invalid="true"]',
    // Toast / notification error patterns
    '.toast-error', '.notification-error', '.Toastify__toast--error',
    '.notistack-MuiContent-error',
    '[data-testid*="error"]',
  ];
  const successSelectors = [
    // Common class-based success patterns
    '.success', '.success-message', '.alert-success',
    '.form-success', '.form-success-message',
    // Framework-specific
    '.ant-message-success', '.ant-notification-notice-success',
    '.MuiAlert-standardSuccess',
    '.chakra-alert[data-status="success"]',
    // Tailwind / utility patterns
    '.text-green-500', '.text-green-600', '.text-success',
    // ARIA roles (status is often used for non-error feedback)
    '[role="status"]',
    // Toast / notification success patterns
    '.toast-success', '.notification-success', '.Toastify__toast--success',
    '.notistack-MuiContent-success',
    '[data-testid*="success"]',
  ];

  // Helper: check if an element is visible (handles fixed/absolute positioned toasts
  // which don't have offsetParent but are still visible)
  function isVisible(el: HTMLElement): boolean {
    if (el.offsetParent !== null) return true;
    // Fixed/sticky positioned elements have offsetParent === null but are still visible
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.position === 'fixed' || style.position === 'sticky') return true;
    // Check parent for fixed positioning (e.g., toast inside a fixed container)
    const parent = el.parentElement;
    if (parent) {
      const parentStyle = getComputedStyle(parent);
      if (parentStyle.position === 'fixed' || parentStyle.position === 'sticky') return true;
    }
    return false;
  }

  const errorElements: Element[] = [];
  const errorSelectorHits: string[] = [];
  for (const sel of errorSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      els.forEach((el) => {
        if (el instanceof HTMLElement && isVisible(el) && el.textContent?.trim()) {
          errorElements.push(el);
          errorSelectorHits.push(sel);
        }
      });
    } catch { /* skip invalid selectors */ }
  }

  // Also check for HTML5 native validation — :invalid pseudo-class on required fields
  if (errorElements.length === 0) {
    try {
      const invalidFields = document.querySelectorAll('input:invalid, select:invalid, textarea:invalid');
      invalidFields.forEach((el) => {
        const input = el as HTMLInputElement;
        if (input.validationMessage && input.validity && !input.validity.valid) {
          errorElements.push(el);
          errorSelectorHits.push(':invalid');
        }
      });
    } catch { /* skip */ }
  }

  const successElements: Element[] = [];
  for (const sel of successSelectors) {
    try {
      const els = document.querySelectorAll(sel);
      els.forEach((el) => {
        if (el instanceof HTMLElement && isVisible(el) && el.textContent?.trim()) {
          successElements.push(el);
        }
      });
    } catch { /* skip invalid selectors */ }
  }

  const hasError = errorElements.length > 0;
  const hasSuccess = !hasError && successElements.length > 0;

  // Extract the most relevant message text
  let message: string | undefined;
  if (hasError) {
    // For HTML5 validation, use the validationMessage
    const firstError = errorElements[0];
    if (firstError instanceof HTMLInputElement && firstError.validationMessage) {
      message = firstError.validationMessage.slice(0, 200);
    } else {
      message = (firstError as HTMLElement).textContent?.trim().slice(0, 200);
    }
  } else if (hasSuccess) {
    message = (successElements[0] as HTMLElement).textContent?.trim().slice(0, 200);
  }

  return {
    hasError,
    hasSuccess,
    message,
    selectors: hasError ? [...new Set(errorSelectorHits)] : undefined,
  };
}

function detectPageMetadata(): { breadcrumb?: string; headings: string[] } {
  // Breadcrumbs
  const breadcrumbSelectors = [
    '[aria-label="breadcrumb"]', '[aria-label="Breadcrumb"]',
    'nav.breadcrumb', '.breadcrumb', '.breadcrumbs',
    '[data-testid*="breadcrumb"]', 'ol.breadcrumb',
  ];
  let breadcrumb: string | undefined;
  for (const sel of breadcrumbSelectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent?.trim()) {
      // Clean up breadcrumb text: normalize whitespace and common separators
      breadcrumb = el.textContent.trim()
        .replace(/\s*[›»>\/]\s*/g, ' > ')
        .replace(/\s+/g, ' ')
        .slice(0, 200);
      break;
    }
  }

  // Key headings (h1, h2) for page structure context
  const headings: string[] = [];
  document.querySelectorAll('h1, h2').forEach((h) => {
    const text = h.textContent?.trim();
    if (text && text.length > 1 && text.length < 150) {
      headings.push(text);
    }
  });

  return { breadcrumb, headings: headings.slice(0, 10) };
}

function detectOpenModal(): { found: boolean; title?: string; content?: string; formFields?: FormField[] } {
  const modalSelectors = [
    '[role="dialog"]', '[role="alertdialog"]',
    '[aria-modal="true"]',
    '.modal.show', '.modal.open', '.modal.active',
    '.MuiDialog-root', '.MuiModal-root',     // MUI
    '.ant-modal-wrap',                         // Ant Design
    '[data-testid*="modal"]', '[data-testid*="dialog"]',
    '.ReactModal__Content',                    // react-modal
    'dialog[open]',                            // native HTML dialog
  ];

  for (const sel of modalSelectors) {
    try {
      const el = document.querySelector(sel);
      if (!el || !(el instanceof HTMLElement)) continue;
      if (el.offsetParent === null && !el.matches('dialog[open]')) continue;

      // Extract modal title
      const titleEl = el.querySelector('h1, h2, h3, [class*="title"], [class*="header"] h1, [class*="header"] h2, [class*="header"] h3');
      const title = titleEl?.textContent?.trim().slice(0, 100);

      // Extract text content (truncated)
      const content = el.textContent?.trim().slice(0, 500);

      // Detect form fields inside the modal
      const formFields: FormField[] = [];
      const fieldSelector = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea';
      el.querySelectorAll(fieldSelector).forEach((fieldEl) => {
        try {
          const input = fieldEl as HTMLInputElement;
          const tag = fieldEl.tagName.toLowerCase();
          let label = '';
          if (input.id) {
            const forLabel = el.querySelector(`label[for="${CSS.escape(input.id)}"]`);
            if (forLabel) label = forLabel.textContent?.trim() ?? '';
          }
          if (!label) {
            const parentLabel = fieldEl.closest('label');
            if (parentLabel) label = parentLabel.textContent?.trim() ?? '';
          }
          if (!label) label = fieldEl.getAttribute('aria-label') ?? '';
          if (!label) label = fieldEl.getAttribute('placeholder') ?? '';

          const field: FormField = {
            selector: fieldEl.id ? `#${CSS.escape(fieldEl.id)}` : `${tag}[name="${CSS.escape(input.name || '')}"]`,
            label: label.slice(0, 100) || undefined,
            type: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : input.type || 'text',
            name: input.name || undefined,
            placeholder: (input as HTMLInputElement).placeholder || undefined,
            required: input.required,
          };
          if (tag === 'input') {
            if (input.maxLength > 0 && input.maxLength < 524288) field.maxLength = input.maxLength;
            if (input.minLength > 0) field.minLength = input.minLength;
          }
          if (tag === 'select') {
            field.options = Array.from((fieldEl as HTMLSelectElement).options)
              .filter((o) => o.value !== '').map((o) => o.text.trim()).slice(0, 20);
          }
          formFields.push(field);
        } catch { /* skip */ }
      });

      return { found: true, title, content, formFields: formFields.length > 0 ? formFields : undefined };
    } catch { /* skip selector */ }
  }

  return { found: false };
}

// ── Page Actions Inventory ──────────────────────────────────────────────────
// Capture all meaningful clickable elements (buttons, links) as a page-level
// action inventory. Downstream consumers use this to know what's available
// on each page without re-scanning.

function detectPageActions(): PageAction[] {
  const actions: PageAction[] = [];
  const seen = new Set<string>();

  const elements = document.querySelectorAll(
    'button:not([disabled]), a[href], [role="button"]:not([disabled]), [role="tab"], [role="menuitem"]'
  );

  elements.forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return;

    const tag = el.tagName.toLowerCase();
    const text = el.innerText?.trim().replace(/\s+/g, ' ').slice(0, 80);
    const ariaLabel = el.getAttribute('aria-label')?.trim();
    const label = text || ariaLabel;
    if (!label || label.length < 2) return;

    // Deduplicate by label+tag
    const dedup = `${tag}:${label.toLowerCase()}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);

    const role = el.getAttribute('role') ?? undefined;
    const href = (el as HTMLAnchorElement).href;

    // Classify the action kind
    let kind: PageAction['kind'] = 'action';
    if (tag === 'a') {
      try {
        const url = new URL(href);
        if (url.origin !== window.location.origin) kind = 'external';
        else kind = 'navigation';
      } catch {
        kind = 'navigation';
      }
    } else if (role === 'tab' || role === 'menuitem') {
      kind = 'menu';
    } else if (el.getAttribute('aria-expanded') !== null || el.getAttribute('aria-pressed') !== null) {
      kind = 'toggle';
    }

    // Build a simple selector for the action
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    let selector = '';
    if (testId) selector = `[data-testid="${testId}"]`;
    else if (el.id) selector = `#${el.id}`;
    else if (ariaLabel) selector = `${tag}[aria-label="${ariaLabel}"]`;
    else selector = `${tag}`;

    actions.push({ selector, label, tag, role, kind });
  });

  return actions.slice(0, 50); // Cap to prevent bloat
}

// ── Data Table / List Detection ─────────────────────────────────────────────

function detectDataTables(): DataTable[] {
  const tables: DataTable[] = [];

  // 1. Detect <table> elements with data rows
  document.querySelectorAll('table').forEach((table) => {
    if (!(table instanceof HTMLTableElement)) return;
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) return;

    const headers: string[] = [];
    table.querySelectorAll('thead th, thead td').forEach((th) => {
      const text = th.textContent?.trim();
      if (text) headers.push(text);
    });

    // Detect row-level action buttons
    const rowActions = new Set<string>();
    const firstRow = rows[0];
    if (firstRow) {
      firstRow.querySelectorAll('button, a').forEach((btn) => {
        const text = (btn as HTMLElement).innerText?.trim();
        if (text && text.length < 30) rowActions.add(text);
      });
    }

    // Detect pagination, sorting, filtering near the table
    const container = table.closest('div, section, main') ?? document.body;
    const hasPagination = !!(
      container.querySelector('[aria-label*="pagination" i], [class*="pagination"], [class*="pager"], nav[aria-label*="page" i], button[aria-label*="next page" i]')
    );
    const hasSorting = !!(
      table.querySelector('th[aria-sort], th button, th [class*="sort"], [data-testid*="sort"]')
    );
    const hasFiltering = !!(
      container.querySelector('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i], [class*="filter"], [data-testid*="filter"], [data-testid*="search"]')
    );

    const selector = table.id ? `#${table.id}` :
      table.getAttribute('data-testid') ? `[data-testid="${table.getAttribute('data-testid')}"]` :
      'table';

    tables.push({
      selector,
      columns: headers.length > 0 ? headers : undefined,
      rowCount: rows.length,
      rowActions: rowActions.size > 0 ? [...rowActions] : undefined,
      hasPagination,
      hasSorting,
      hasFiltering,
    });
  });

  // 2. Detect role="grid" or role="table" (e.g. AG Grid, MUI DataGrid)
  document.querySelectorAll('[role="grid"], [role="table"]').forEach((grid) => {
    if (grid.tagName.toLowerCase() === 'table') return; // Already handled
    if (!(grid instanceof HTMLElement)) return;

    const headers: string[] = [];
    grid.querySelectorAll('[role="columnheader"]').forEach((h) => {
      const text = h.textContent?.trim();
      if (text) headers.push(text);
    });

    const rows = grid.querySelectorAll('[role="row"]');
    const dataRowCount = Math.max(0, rows.length - 1); // Subtract header row

    const container = grid.closest('div, section, main') ?? document.body;
    const hasPagination = !!container.querySelector('[aria-label*="pagination" i], [class*="pagination"]');

    const selector = grid.id ? `#${grid.id}` :
      grid.getAttribute('data-testid') ? `[data-testid="${grid.getAttribute('data-testid')}"]` :
      '[role="grid"]';

    tables.push({
      selector,
      columns: headers.length > 0 ? headers : undefined,
      rowCount: dataRowCount,
      hasPagination,
      hasSorting: !!grid.querySelector('[aria-sort]'),
      hasFiltering: !!container.querySelector('input[type="search"], input[placeholder*="search" i]'),
    });
  });

  // 3. Detect card grids / repeated list items (common in modern UIs)
  document.querySelectorAll('[role="list"], ul, ol').forEach((list) => {
    if (!(list instanceof HTMLElement)) return;
    const items = list.querySelectorAll(':scope > [role="listitem"], :scope > li');
    if (items.length < 3) return; // Need at least 3 items to be a meaningful list

    // Check if items have interactive elements (buttons, links) — signals a data list
    const firstItem = items[0] as HTMLElement;
    const hasActions = !!firstItem?.querySelector('button, a[href]');
    if (!hasActions && items.length < 5) return; // Plain text lists are uninteresting

    const rowActions = new Set<string>();
    if (firstItem) {
      firstItem.querySelectorAll('button, a').forEach((btn) => {
        const text = (btn as HTMLElement).innerText?.trim();
        if (text && text.length < 30) rowActions.add(text);
      });
    }

    const container = list.closest('div, section, main') ?? document.body;
    const selector = list.id ? `#${list.id}` :
      list.getAttribute('data-testid') ? `[data-testid="${list.getAttribute('data-testid')}"]` :
      list.getAttribute('role') === 'list' ? '[role="list"]' : list.tagName.toLowerCase();

    tables.push({
      selector,
      rowCount: items.length,
      rowActions: rowActions.size > 0 ? [...rowActions] : undefined,
      hasPagination: !!container.querySelector('[aria-label*="pagination" i], [class*="pagination"]'),
      hasSorting: false,
      hasFiltering: !!container.querySelector('input[type="search"], input[placeholder*="search" i]'),
    });
  });

  return tables.slice(0, 10); // Cap
}

// ── Page Type Classification ────────────────────────────────────────────────

function classifyPageType(): PageType {
  const url = window.location.pathname.toLowerCase();
  const title = document.title.toLowerCase();
  const bodyText = document.body?.innerText?.slice(0, 2000).toLowerCase() ?? '';

  // Error pages — check first to bail early
  if (isErrorPage()) return 'error';

  // Auth pages
  const authSelectors = 'input[type="password"], form[action*="login"], form[action*="signin"], form[action*="register"], form[action*="signup"]';
  const authKeywords = /\b(login|log in|sign in|sign up|register|forgot password|reset password)\b/i;
  if (document.querySelector(authSelectors) || authKeywords.test(title) || /\/(login|signin|signup|register|auth)\b/.test(url)) {
    return 'auth';
  }

  // Count signals
  const formCount = document.querySelectorAll('form, input:not([type="hidden"]):not([type="search"]), textarea, select').length;
  const tableCount = document.querySelectorAll('table tbody tr, [role="grid"] [role="row"], [role="list"] > [role="listitem"]').length;
  const chartCount = document.querySelectorAll('canvas, svg.chart, [class*="chart"], [class*="graph"], [class*="widget"], [class*="stat"], [class*="metric"], [class*="kpi"]').length;
  const detailSelectors = document.querySelectorAll('dl, [class*="detail"], [class*="profile"], [class*="info-card"], [class*="summary"]').length;

  // Settings
  if (/\/(settings|preferences|config|account|admin\/config)\b/.test(url) || /\b(settings|preferences|configuration)\b/.test(title)) {
    return 'settings';
  }

  // Dashboard — lots of widgets/charts/stats
  if (chartCount >= 2 || (/(dashboard|overview|analytics|home)\b/.test(url) && chartCount >= 1)) {
    return 'dashboard';
  }

  // Empty state
  const emptyPatterns = document.querySelectorAll('[class*="empty"], [class*="no-data"], [class*="no-results"], [class*="zero-state"]');
  const emptyText = /\b(no (data|results|items|records) found|nothing (here|to show)|get started|empty)\b/i;
  if (emptyPatterns.length > 0 || (emptyText.test(bodyText) && tableCount === 0 && formCount < 3)) {
    return 'empty';
  }

  // List — data tables, grids, card lists
  if (tableCount >= 3) return 'list';

  // Form — page dominated by form inputs
  if (formCount >= 4 && tableCount < 3) return 'form';

  // Detail — single record view
  if (detailSelectors >= 2 && formCount < 4 && tableCount < 3) return 'detail';

  // URL-based heuristics as fallback
  if (/\/(list|index|all|browse|search|catalog)\b/.test(url)) return 'list';
  if (/\/(detail|view|show|profile|info)\b/.test(url) || /\/\d+\/?$/.test(url)) return 'detail';
  if (/\/(new|create|edit|add|form)\b/.test(url)) return 'form';

  return 'other';
}

// ── Error Page Detection ────────────────────────────────────────────────────

function isErrorPage(): boolean {
  const title = document.title.toLowerCase();
  const bodyText = document.body?.innerText?.slice(0, 1000).toLowerCase() ?? '';

  // Check meta status code
  const statusMeta = document.querySelector('meta[name="status-code"], meta[http-equiv="status"]');
  if (statusMeta) {
    const code = parseInt(statusMeta.getAttribute('content') ?? '', 10);
    if (code >= 400) return true;
  }

  // Common error page patterns
  const errorPatterns = /\b(404|not found|page not found|500|internal server error|403|forbidden|401|unauthorized|502|bad gateway|503|service unavailable)\b/i;
  if (errorPatterns.test(title)) return true;

  // Check for common error page DOM structures
  const errorSelectors = [
    '[class*="error-page"]', '[class*="not-found"]', '[class*="404"]', '[class*="500"]',
    '[data-testid*="error-page"]', '[data-testid*="not-found"]',
  ];
  for (const sel of errorSelectors) {
    if (document.querySelector(sel)) return true;
  }

  // Very short body text with error keywords — likely an error page
  const visibleText = document.body?.innerText?.trim() ?? '';
  if (visibleText.length < 200 && errorPatterns.test(bodyText)) return true;

  return false;
}

function detectHttpStatus(): number | undefined {
  // Try meta tag
  const statusMeta = document.querySelector('meta[name="status-code"], meta[http-equiv="status"]');
  if (statusMeta) {
    const code = parseInt(statusMeta.getAttribute('content') ?? '', 10);
    if (code >= 100 && code < 600) return code;
  }

  // Infer from error page text
  const text = document.title + ' ' + (document.body?.innerText?.slice(0, 500) ?? '');
  if (/\b404\b/.test(text)) return 404;
  if (/\b500\b/.test(text)) return 500;
  if (/\b403\b/.test(text)) return 403;
  if (/\b401\b/.test(text)) return 401;
  if (/\b502\b/.test(text)) return 502;
  if (/\b503\b/.test(text)) return 503;

  return undefined;
}

// ── Field-Level Error Mapping ───────────────────────────────────────────────
// After form submission, try to link visible error messages to specific fields.

function detectFieldErrors(): FieldError[] {
  const errors: FieldError[] = [];
  const fields = document.querySelectorAll(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
  );

  fields.forEach((field) => {
    if (!(field instanceof HTMLElement)) return;
    const input = field as HTMLInputElement;

    // Strategy 1: HTML5 native validation
    if (input.validationMessage && input.validity && !input.validity.valid) {
      let label = '';
      if (input.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (forLabel) label = forLabel.textContent?.trim() ?? '';
      }
      if (!label) label = input.getAttribute('aria-label') ?? input.name ?? '';

      errors.push({
        fieldSelector: buildFieldSelector(field),
        fieldLabel: label || undefined,
        errorSelector: buildFieldSelector(field), // The field itself has the message
        errorMessage: input.validationMessage,
      });
      return;
    }

    // Strategy 2: aria-describedby pointing to an error element
    const describedBy = field.getAttribute('aria-describedby');
    if (describedBy) {
      const descEl = document.getElementById(describedBy);
      if (descEl && descEl.textContent?.trim()) {
        const isError = descEl.classList.toString().match(/error|invalid|danger/) ||
          descEl.getAttribute('role') === 'alert' ||
          field.getAttribute('aria-invalid') === 'true';
        if (isError) {
          errors.push({
            fieldSelector: buildFieldSelector(field),
            fieldLabel: getFieldLabel(field),
            errorSelector: `#${CSS.escape(describedBy)}`,
            errorMessage: descEl.textContent.trim().slice(0, 200),
          });
          return;
        }
      }
    }

    // Strategy 3: aria-errormessage attribute
    const errMsgId = field.getAttribute('aria-errormessage');
    if (errMsgId) {
      const errEl = document.getElementById(errMsgId);
      if (errEl && errEl.textContent?.trim()) {
        errors.push({
          fieldSelector: buildFieldSelector(field),
          fieldLabel: getFieldLabel(field),
          errorSelector: `#${CSS.escape(errMsgId)}`,
          errorMessage: errEl.textContent.trim().slice(0, 200),
        });
        return;
      }
    }

    // Strategy 4: Adjacent/sibling error element
    if (field.getAttribute('aria-invalid') === 'true' || field.classList.contains('is-invalid') || field.classList.contains('error')) {
      const errorSelectors = [
        '.invalid-feedback', '.field-error', '.error-message', '.help-block',
        '.ant-form-item-explain-error', '.MuiFormHelperText-root.Mui-error',
        '[role="alert"]', '.text-red-500', '.text-danger',
      ];
      // Look in parent container (form-group, form-item, etc.)
      const container = field.closest('.form-group, .form-item, .ant-form-item, .MuiFormControl-root, .field, label, .input-wrapper') ?? field.parentElement;
      if (container) {
        for (const sel of errorSelectors) {
          const errEl = container.querySelector(sel);
          if (errEl && errEl instanceof HTMLElement && errEl.textContent?.trim()) {
            errors.push({
              fieldSelector: buildFieldSelector(field),
              fieldLabel: getFieldLabel(field),
              errorSelector: sel,
              errorMessage: errEl.textContent.trim().slice(0, 200),
            });
            break;
          }
        }
      }
    }
  });

  return errors;
}

function buildFieldSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
  const name = el.getAttribute('name');
  if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
  return el.tagName.toLowerCase();
}

function getFieldLabel(field: Element): string | undefined {
  const input = field as HTMLInputElement;
  if (input.id) {
    const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (forLabel) return forLabel.textContent?.trim().slice(0, 100);
  }
  const ariaLabel = field.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  return input.name || undefined;
}

// ── Wizard/Stepper Detection ────────────────────────────────────────────────

interface WizardStepInfo {
  label: string;
  stepNumber: number;
  totalSteps: number;
  selector?: string;
  isActive: boolean;
}

function detectWizardSteps(): WizardStepInfo[] {
  const steps: WizardStepInfo[] = [];

  // Strategy 1: ARIA stepper patterns
  const stepperSelectors = [
    '[role="tablist"] [role="tab"]',
    '.stepper .step, .stepper .MuiStep-root',
    '.wizard-step, .wizard .step',
    '[class*="stepper"] [class*="step"]',
    '[data-testid*="step"]',
    '.ant-steps .ant-steps-item',
    '.progress-steps li, .steps li',
    'ol.steps > li',
    '[aria-label*="step" i]',
  ];

  for (const sel of stepperSelectors) {
    try {
      const elements = document.querySelectorAll(sel);
      if (elements.length < 2) continue;

      elements.forEach((el, idx) => {
        const htmlEl = el as HTMLElement;
        const text = htmlEl.innerText?.trim().replace(/\s+/g, ' ').slice(0, 60) || '';
        const isActive = htmlEl.classList.contains('active') ||
          htmlEl.getAttribute('aria-selected') === 'true' ||
          htmlEl.getAttribute('aria-current') === 'step' ||
          htmlEl.classList.contains('current') ||
          !!htmlEl.querySelector('.active, [aria-current]');

        steps.push({
          label: text || `Step ${idx + 1}`,
          stepNumber: idx + 1,
          totalSteps: elements.length,
          selector: htmlEl.id ? `#${htmlEl.id}` : undefined,
          isActive,
        });
      });

      if (steps.length > 0) break; // Found a stepper — don't search further
    } catch { /* skip */ }
  }

  return steps;
}

// ── Conditional Field Visibility Detection ──────────────────────────────────
// Detect fields that appear/disappear when a select/radio field changes value.
// This is done by reading the current DOM state — actual toggling happens in the explorer.

function detectConditionalFields(): Array<{ fieldSelector: string; triggerSelector: string; triggerValue: string }> {
  const rules: Array<{ fieldSelector: string; triggerSelector: string; triggerValue: string }> = [];

  // Look for fields that have conditional visibility attributes
  const conditionalSelectors = [
    '[data-show-when]',           // Custom data attribute
    '[data-visible-if]',
    '[data-depends-on]',
    '.conditional-field',
    '[class*="conditional"]',
  ];

  for (const sel of conditionalSelectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const showWhen = el.getAttribute('data-show-when') ?? el.getAttribute('data-visible-if') ?? '';
        const dependsOn = el.getAttribute('data-depends-on') ?? '';
        if (showWhen || dependsOn) {
          rules.push({
            fieldSelector: buildFieldSelector(el),
            triggerSelector: dependsOn || showWhen.split('=')[0] || '',
            triggerValue: showWhen.split('=')[1] || '',
          });
        }
      });
    } catch { /* skip */ }
  }

  // Also detect hidden fields inside containers that toggle visibility
  // (e.g., a div with display:none that contains form fields)
  document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((field) => {
    if (!(field instanceof HTMLElement)) return;
    const container = field.closest('[style*="display: none"], [style*="display:none"], .hidden, [hidden], [aria-hidden="true"]');
    if (container && container !== document.body) {
      // This field is inside a hidden container — likely conditionally visible
      const containerId = (container as HTMLElement).id;
      if (containerId) {
        rules.push({
          fieldSelector: buildFieldSelector(field),
          triggerSelector: `[aria-controls="${containerId}"], [data-target="#${containerId}"]`,
          triggerValue: 'toggle',
        });
      }
    }
  });

  return rules;
}

chrome.runtime.onMessage.addListener(
  (message: ContentScriptMessage, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true;
  }
);

async function handleMessage(message: ContentScriptMessage): Promise<unknown> {
  switch (message.type) {
    case 'PING':
      return { type: 'PONG' } satisfies ContentScriptResponse;

    case 'EXECUTE_ACTION': {
      const result = await executeAction(message.payload);
      return { type: 'ACTION_RESULT', success: result.success, error: result.error } satisfies ContentScriptResponse;
    }

    case 'GET_ELEMENTS': {
      const elements = detectInteractiveElements();
      return { type: 'ELEMENTS', payload: elements } satisfies ContentScriptResponse;
    }

    case 'GET_FORM_FIELDS': {
      const formFields = detectFormFields();
      return { type: 'FORM_FIELDS', payload: formFields } satisfies ContentScriptResponse;
    }

    case 'GET_LINKS': {
      const links = extractSameOriginLinks(message.payload.origin);
      return { type: 'LINKS', payload: links } satisfies ContentScriptResponse;
    }

    case 'REVEAL_PAGE_CONTENT': {
      await revealPageContent();
      return { type: 'REVEAL_DONE' } satisfies ContentScriptResponse;
    }

    case 'GET_DOM_SNAPSHOT':
    case 'SCAN_PAGE': {
      const compressed = compressDOM(document);
      const snapshot: PageSnapshot = {
        url: window.location.href,
        title: document.title,
        elements: detectInteractiveElements(),
        domCompressed: serializeCompressedDOM(compressed),
        capturedAt: new Date().toISOString(),
      };
      return { type: 'PAGE_SNAPSHOT', payload: snapshot } satisfies ContentScriptResponse;
    }

    case 'WAIT_FOR_IDLE': {
      const settleMs = (message as { type: string; settleMs?: number }).settleMs ?? 300;
      await waitForDOMIdle(settleMs, 5000);
      return { type: 'IDLE_READY' } satisfies ContentScriptResponse;
    }

    case 'DETECT_FORM_MESSAGES': {
      const result = detectFormMessageElements();
      return { type: 'FORM_MESSAGES', payload: result } satisfies ContentScriptResponse;
    }

    case 'GET_PAGE_METADATA': {
      const metadata = detectPageMetadata();
      return { type: 'PAGE_METADATA', payload: metadata } satisfies ContentScriptResponse;
    }

    case 'DETECT_MODAL': {
      const modal = detectOpenModal();
      return { type: 'MODAL_DETECTED', payload: modal } satisfies ContentScriptResponse;
    }

    case 'GET_PAGE_ACTIONS': {
      const pageActions = detectPageActions();
      return { type: 'PAGE_ACTIONS', payload: pageActions } satisfies ContentScriptResponse;
    }

    case 'GET_DATA_TABLES': {
      const dataTables = detectDataTables();
      return { type: 'DATA_TABLES', payload: dataTables } satisfies ContentScriptResponse;
    }

    case 'GET_PAGE_TYPE': {
      const pageType = classifyPageType();
      const errorPage = isErrorPage();
      const httpStatus = detectHttpStatus();
      return { type: 'PAGE_TYPE', payload: { pageType, isErrorPage: errorPage, httpStatus } } satisfies ContentScriptResponse;
    }

    case 'GET_FIELD_ERRORS': {
      const fieldErrors = detectFieldErrors();
      return { type: 'FIELD_ERRORS', payload: fieldErrors } satisfies ContentScriptResponse;
    }

    case 'GET_WIZARD_STEPS': {
      const wizardSteps = detectWizardSteps();
      return { type: 'WIZARD_STEPS', payload: wizardSteps } satisfies ContentScriptResponse;
    }

    case 'GET_CONDITIONAL_FIELDS': {
      const conditionalFields = detectConditionalFields();
      return { type: 'CONDITIONAL_FIELDS', payload: conditionalFields } satisfies ContentScriptResponse;
    }

    case 'VALIDATE_SELECTORS': {
      const { selectors } = message.payload;
      const anyExists = selectors.some((sel) => {
        try { return !!document.querySelector(sel); } catch { return false; }
      });
      return { type: 'SELECTOR_VALIDATION', payload: anyExists } satisfies ContentScriptResponse;
    }

    case 'DETECT_SPA_ROUTES': {
      const spaResult = detectSPARoutes();
      return { type: 'SPA_ROUTES', payload: spaResult };
    }

    case 'START_RECORDING': {
      // Inject the recording script directly (content script has same page context)
      if (!(window as any).__pathfinder_recording) {
        // Import recording script source and inject it
        try {
          const scriptEl = document.createElement('script');
          scriptEl.textContent = getRecordingScriptInline();
          (document.head || document.documentElement).appendChild(scriptEl);
          scriptEl.remove(); // DOM cleanup — script has already executed
        } catch (err) {
          return { success: false, error: String(err) };
        }
      }
      return { success: true };
    }

    case 'STOP_RECORDING': {
      const stopActions = (window as any).__pathfinder_stopRecording?.() ?? [];
      return { success: true, actions: stopActions };
    }

    case 'GET_RECORDED_ACTIONS': {
      const recordedActions = (window as any).__pathfinder_getRecordedActions?.() ?? [];
      return { success: true, actions: recordedActions };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}

/**
 * Detect SPA framework routes from page globals and navigation DOM.
 * Reads Next.js, Nuxt/__NUXT__, and Vue Router data; falls back to href links.
 */
function detectSPARoutes(): { framework: string; routes: string[] } {
  const routes = new Set<string>();
  let framework = 'unknown';

  // Next.js: __NEXT_DATA__ contains the current route; __BUILD_MANIFEST lists all routes
  const win = window as unknown as Record<string, unknown>;
  try {
    const nextData = win['__NEXT_DATA__'] as { page?: string } | undefined;
    if (nextData?.page) {
      routes.add(nextData.page);
      framework = 'next.js';
    }
    const buildManifest = win['__BUILD_MANIFEST'] as Record<string, string[]> | undefined;
    if (buildManifest) {
      framework = 'next.js';
      Object.keys(buildManifest).forEach((route) => {
        if (route && route !== '/_buildManifest' && route !== '/_ssgManifest') {
          routes.add(route);
        }
      });
    }
  } catch { /* skip */ }

  // Nuxt / Vue Router: __NUXT__ may expose router data
  try {
    const nuxt = win['__NUXT__'] as { state?: { route?: { path?: string } } } | undefined;
    if (nuxt?.state?.route?.path) {
      routes.add(nuxt.state.route.path);
      if (framework === 'unknown') framework = 'nuxt';
    }
  } catch { /* skip */ }

  // Navigation DOM: links inside nav, role=navigation, role=menubar
  try {
    const navSelectors = ['nav a[href]', '[role="navigation"] a[href]', '[role="menubar"] a[href]'];
    for (const sel of navSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const href = (el as HTMLAnchorElement).getAttribute('href');
        if (href && href.startsWith('/') && !href.startsWith('//')) {
          routes.add(href.split('?')[0].split('#')[0]);
        }
      });
    }
    if (routes.size > 0 && framework === 'unknown') framework = 'dom-nav';
  } catch { /* skip */ }

  // All same-origin <a href> paths
  try {
    document.querySelectorAll('a[href]').forEach((el) => {
      const href = (el as HTMLAnchorElement).getAttribute('href');
      if (href && href.startsWith('/') && !href.startsWith('//')) {
        routes.add(href.split('?')[0].split('#')[0]);
      }
    });
    if (routes.size > 0 && framework === 'unknown') framework = 'href-links';
  } catch { /* skip */ }

  return { framework, routes: [...routes].slice(0, 300) };
}

/**
 * Inline recording script — same logic as recorder.ts getRecordingScript()
 * but embedded directly to avoid dynamic import issues in content scripts.
 */
function getRecordingScriptInline(): string {
  // This returns the recording script that captures user interactions
  // and exposes __pathfinder_getRecordedActions() and __pathfinder_stopRecording()
  return `(function(){if(window.__pathfinder_recording)return;window.__pathfinder_recording=true;var actions=[];var MAX=200;function buildSelector(el){if(!el||el===document.body||el===document.documentElement)return"body";var tid=el.getAttribute("data-testid")||el.getAttribute("data-test");if(tid)return'[data-testid="'+CSS.escape(tid)+'"]';if(el.id&&document.querySelectorAll("#"+CSS.escape(el.id)).length===1)return"#"+CSS.escape(el.id);var al=el.getAttribute("aria-label");if(al){var s=el.tagName.toLowerCase()+'[aria-label="'+CSS.escape(al)+'"]';if(document.querySelectorAll(s).length===1)return s}var nm=el.getAttribute("name");if(nm){var s2=el.tagName.toLowerCase()+'[name="'+CSS.escape(nm)+'"]';if(document.querySelectorAll(s2).length===1)return s2}var parts=[];var c=el;while(c&&c!==document.body&&parts.length<4){var t=c.tagName.toLowerCase();var p=c.parentElement;if(p){var sibs=Array.from(p.children).filter(function(x){return x.tagName===c.tagName});if(sibs.length>1)parts.unshift(t+":nth-of-type("+(sibs.indexOf(c)+1)+")");else parts.unshift(t)}else parts.unshift(t);c=p}return parts.join(" > ")}function desc(el){var t=el.tagName.toLowerCase();var txt=(el.textContent||"").trim().slice(0,50);var lbl=el.getAttribute("aria-label")||el.getAttribute("placeholder")||el.getAttribute("name")||"";if(t==="input"||t==="textarea")return(lbl||el.type||t)+" field";if(t==="button")return'"'+(txt||lbl||"button")+'" button';if(t==="a")return'"'+(txt||"link")+'" link';return txt?'"'+txt+'" '+t:t}function rec(a){if(actions.length>=MAX)return;actions.push(a);window.postMessage({type:"__pathfinder_RECORDED_ACTION",action:a},"*")}var debounce={};document.addEventListener("click",function(e){var el=e.target;if(!el||!el.tagName)return;if(el.tagName==="INPUT"&&(el.type==="checkbox"||el.type==="radio"))return;rec({timestamp:Date.now(),action:"click",selector:buildSelector(el),elementDescription:desc(el),url:location.href})},true);document.addEventListener("input",function(e){var el=e.target;if(!el||!el.tagName)return;if(el.tagName!=="INPUT"&&el.tagName!=="TEXTAREA")return;if(el.type==="checkbox"||el.type==="radio")return;var sel=buildSelector(el);clearTimeout(debounce[sel]);debounce[sel]=setTimeout(function(){rec({timestamp:Date.now(),action:"type",selector:sel,value:el.value,elementDescription:desc(el),url:location.href})},500)},true);document.addEventListener("change",function(e){var el=e.target;if(!el||!el.tagName)return;if(el.tagName==="SELECT"){var opt=el.options[el.selectedIndex];rec({timestamp:Date.now(),action:"select",selector:buildSelector(el),value:el.value,optionText:opt?opt.text.trim():el.value,elementDescription:desc(el),url:location.href});return}if(el.type==="checkbox"||el.type==="radio"){rec({timestamp:Date.now(),action:"check",selector:buildSelector(el),value:el.checked?"true":"false",elementDescription:desc(el),url:location.href})}},true);document.addEventListener("keydown",function(e){if(["Enter","Escape","Tab"].includes(e.key)){var el=e.target||document.activeElement;rec({timestamp:Date.now(),action:"press_key",selector:buildSelector(el),key:e.key,elementDescription:desc(el),url:location.href})}},true);var lastUrl=location.href;new MutationObserver(function(){if(location.href!==lastUrl){rec({timestamp:Date.now(),action:"navigate",selector:"",value:location.href,elementDescription:"Navigation",url:location.href});lastUrl=location.href}}).observe(document,{subtree:true,childList:true});window.__pathfinder_getRecordedActions=function(){return JSON.parse(JSON.stringify(actions))};window.__pathfinder_stopRecording=function(){window.__pathfinder_recording=false;return JSON.parse(JSON.stringify(actions))}})();`;
}
