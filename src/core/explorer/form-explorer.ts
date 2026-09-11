/**
 * Form submission as an act of exploration.
 *
 * The explorer submits a form twice on purpose: once empty, to make the app
 * state its own validation rules, and once filled, to see what a successful
 * submission actually does. Both are observations about the application, and
 * both land on the graph as `FormSubmissionOutcome` records that test
 * generation reads instead of guessing.
 *
 * Split out of `explorer-agent.ts` unchanged. It shared scope with the BFS
 * crawl while having a clean boundary of its own: it takes a tab, a page, and
 * the fields on it, and writes outcomes to the graph. Nothing here knows about
 * the queue, the worker pool, or the page budget.
 */
import type { InteractionGraph, InteractiveElement, FormField, FormSubmissionOutcome } from '../../storage/schemas';
import { addFormOutcome } from './interaction-graph';
import { scanFormFields, scanFieldErrors, getPageSnapshot } from './page-scanner';
import { executeStep as executeStepViaPort } from '../step-executor';
import { sendToContentScript } from '../../messaging/messenger';
import { getHAREntries, isAttached } from '../cdp/cdp-client';
import { delay, settle } from './exploration-primitives';
import { extractAPIEndpoints } from './observed-apis';
import { createLogger } from '../../utils/logger';

const log = createLogger('form-explorer');

/**
 * Try submitting a form with empty fields first (to discover validation errors),
 * then with placeholder/test data (to discover success states).
 */
export async function exploreFormSubmission(
  tabId: number,
  pageUrl: string,
  formFields: FormField[],
  elements: InteractiveElement[],
  graph: InteractionGraph,
  /**
   * Injected rather than imported: navigating a tab means touching `chrome.*`,
   * which `src/core/**` is barred from outside the burn-down list in
   * `.eslintrc.cjs`. The caller already owns that capability.
   */
  navigateToUrl: (tabId: number, url: string) => Promise<void>
): Promise<void> {
  const submitButton = findSubmitButton(elements);
  if (!submitButton) return;
  const cdpOn = isAttached(tabId);

  // ── Attempt 1: Empty submission — discover required field validation ──
  try {
    const harBefore = cdpOn ? getHAREntries(tabId).length : 0;
    await executeStepViaPort({ order: 0, action: 'click', selector: submitButton.selector, description: 'Explore: empty form submit' }, tabId);
    await settle(tabId);

    const outcome = await captureFormOutcome(tabId, pageUrl, [], submitButton.selector);
    addFormOutcome(graph, pageUrl, outcome);

    // Capture API endpoints triggered by the form submission
    if (cdpOn) {
      const formApis = extractAPIEndpoints(getHAREntries(tabId).slice(harBefore), 'form_submit');
      const node = graph.nodes.find((n) => n.url === pageUrl);
      if (node && formApis.length > 0) {
        node.apiEndpoints = [...(node.apiEndpoints ?? []), ...formApis];
      }
    }

    // Navigate back if submission caused navigation
    const afterSnap = await getPageSnapshot(tabId);
    if (afterSnap && afterSnap.url !== pageUrl) {
      await navigateToUrl(tabId, pageUrl);
      await settle(tabId);
    }
  } catch (err) {
    log.debug('Empty form submission exploration failed', err);
  }

  // ── Attempt 2: Fill all fields (required first, then optional) with test data, then submit ──
  // Filling all fields captures the full form submission experience — including
  // conditional fields that appear only after other fields are filled.
  const fieldsToFill = [
    ...formFields.filter((f) => f.required),
    ...formFields.filter((f) => !f.required),
  ];
  if (fieldsToFill.length === 0) return;

  try {
    const filledSelectors: string[] = [];
    for (const field of fieldsToFill) {
      const testValue = generateTestValue(field);
      if (!testValue) continue;

      // Use appropriate action based on field type
      const action = (field.type === 'select') ? 'select'
        : (field.type === 'checkbox' || field.type === 'radio') ? 'check'
        : 'type';

      await executeStepViaPort({
          order: 0,
          action,
          selector: field.selector,
          value: action === 'check' ? undefined : testValue,
          description: `Explore: fill ${field.label || field.name || field.type}`,
        }, tabId);
      filledSelectors.push(field.selector);
      await delay(300);
    }

    if (filledSelectors.length > 0) {
      const harBeforeFilled = cdpOn ? getHAREntries(tabId).length : 0;
      await executeStepViaPort({ order: 0, action: 'click', selector: submitButton.selector, description: 'Explore: filled form submit' }, tabId);
      await settle(tabId);

      const outcome = await captureFormOutcome(tabId, pageUrl, filledSelectors, submitButton.selector);
      addFormOutcome(graph, pageUrl, outcome);

      // Capture API endpoints triggered by filled form submission
      if (cdpOn) {
        const formApis = extractAPIEndpoints(getHAREntries(tabId).slice(harBeforeFilled), 'form_submit');
        const node = graph.nodes.find((n) => n.url === pageUrl);
        if (node && formApis.length > 0) {
          node.apiEndpoints = [...(node.apiEndpoints ?? []), ...formApis];
        }
      }
    }
  } catch (err) {
    log.debug('Filled form submission exploration failed', err);
  }
}

export function findSubmitButton(elements: InteractiveElement[]): InteractiveElement | undefined {
  // Priority: submit buttons → buttons with submit-like text
  const submitInput = elements.find(
    (el) => (el.tag === 'button' || el.tag === 'input') && el.type === 'submit' && el.visible
  );
  if (submitInput) return submitInput;

  const submitText = ['submit', 'save', 'create', 'add', 'send', 'register', 'sign up', 'log in', 'login', 'continue', 'next', 'confirm'];
  return elements.find((el) => {
    if (el.tag !== 'button' || !el.visible) return false;
    const text = (el.text ?? '').toLowerCase();
    return submitText.some((st) => text.includes(st));
  });
}

export async function captureFormOutcome(
  tabId: number,
  originalUrl: string,
  filledFields: string[],
  submitSelector: string
): Promise<FormSubmissionOutcome> {
  const snapshot = await getPageSnapshot(tabId);
  const currentUrl = snapshot?.url ?? originalUrl;

  // Check for navigation
  if (currentUrl !== originalUrl) {
    return {
      filledFields,
      submitSelector,
      result: 'navigation',
      resultUrl: currentUrl,
    };
  }

  // Look for error/success messages in the DOM — check immediately and again
  // after a short delay to catch toast/snackbar animations that appear async.
  let messageInfo = await detectFormMessages(tabId);

  if (!messageInfo.hasError && !messageInfo.hasSuccess) {
    // Many UI frameworks show toasts/snackbars after a short async delay. Let
    // the network/DOM settle (bounded) before re-checking rather than a flat
    // sleep, then re-detect.
    await settle(tabId, { idleMs: 300, timeoutMs: 3_000, fallbackMs: 800 });
    messageInfo = await detectFormMessages(tabId);
  }

  if (messageInfo.hasError) {
    // Capture per-field error mapping for downstream test assertions
    const fieldErrors = await scanFieldErrors(tabId);
    return {
      filledFields,
      submitSelector,
      result: 'validation_error',
      resultMessage: messageInfo.message,
      errorSelectors: messageInfo.selectors,
      fieldErrors: fieldErrors.length > 0 ? fieldErrors : undefined,
    };
  }

  if (messageInfo.hasSuccess) {
    return {
      filledFields,
      submitSelector,
      result: 'success',
      resultMessage: messageInfo.message,
    };
  }

  // Last resort: check if the form fields were cleared after submission
  // (a common pattern — the form resets on success without showing a message)
  if (filledFields.length > 0) {
    try {
      const currentFormFields = await scanFormFields(tabId);
      const wasCleared = filledFields.every((filledSelector) => {
        const field = currentFormFields.find((f) => f.selector === filledSelector);
        // If the field no longer exists or has no name, it was likely removed (success)
        return !field;
      });
      if (wasCleared) {
        return {
          filledFields,
          submitSelector,
          result: 'success',
          resultMessage: 'Form fields cleared after submission',
        };
      }
    } catch { /* non-fatal */ }
  }

  return {
    filledFields,
    submitSelector,
    result: 'unknown',
  };
}

async function detectFormMessages(
  tabId: number
): Promise<{ hasError: boolean; hasSuccess: boolean; message?: string; selectors?: string[] }> {
  try {
    const response = await sendToContentScript<{
      payload: { hasError: boolean; hasSuccess: boolean; message?: string; selectors?: string[] };
    }>(tabId, { type: 'DETECT_FORM_MESSAGES' });
    return response?.payload ?? { hasError: false, hasSuccess: false };
  } catch {
    return { hasError: false, hasSuccess: false };
  }
}

export function generateTestValue(field: FormField): string | undefined {
  switch (field.type) {
    case 'email':
      return 'test@example.com';
    case 'tel':
      return '+1234567890';
    case 'url':
      return 'https://example.com';
    case 'number':
      return field.min ?? '1';
    case 'date':
      return '2025-01-15';
    case 'datetime-local':
      return '2025-01-15T10:30';
    case 'time':
      return '10:30';
    case 'color':
      return '#ff0000';
    case 'range':
      return field.min ?? '50';
    case 'text':
    case 'search':
      // Use field context to generate more realistic values
      if (field.name?.toLowerCase().includes('name') || field.label?.toLowerCase().includes('name')) return 'Test User';
      if (field.name?.toLowerCase().includes('title') || field.label?.toLowerCase().includes('title')) return 'Test Title';
      if (field.name?.toLowerCase().includes('company') || field.label?.toLowerCase().includes('company')) return 'Test Corp';
      if (field.name?.toLowerCase().includes('address') || field.label?.toLowerCase().includes('address')) return '123 Test Street';
      if (field.name?.toLowerCase().includes('city') || field.label?.toLowerCase().includes('city')) return 'Test City';
      if (field.name?.toLowerCase().includes('zip') || field.label?.toLowerCase().includes('zip')) return '12345';
      return 'Test input';
    case 'password':
      return 'TestPassword123!';
    case 'textarea':
      return 'Test description text for automated exploration.';
    case 'select':
      // Pick the first non-empty option
      return field.options?.[0];
    case 'checkbox':
    case 'radio':
      return 'true'; // signal to check/select
    default:
      return 'test';
  }
}

