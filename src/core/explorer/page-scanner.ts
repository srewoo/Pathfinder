import type { InteractiveElement, FormField, PageSnapshot, PageAction, DataTable, PageType, FieldError, WizardStep } from '../../storage/schemas';
import { sendToContentScript } from '../../messaging/messenger';
import { createLogger } from '../../utils/logger';

const log = createLogger('page-scanner');

export async function scanPage(tabId: number): Promise<InteractiveElement[]> {
  try {
    const response = await sendToContentScript<{ payload: InteractiveElement[] }>(tabId, {
      type: 'GET_ELEMENTS',
    });
    return response?.payload ?? [];
  } catch (err) {
    log.warn('scanPage failed — content script may be unavailable', { tabId, err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Scroll through the page and hover nav items to reveal lazy-loaded content
 * and dropdown menus before scanning elements and links.
 */
export async function revealPageContent(tabId: number): Promise<void> {
  try {
    await sendToContentScript(tabId, { type: 'REVEAL_PAGE_CONTENT' });
  } catch {
    // non-fatal — continue even if reveal fails
  }
}

/**
 * Extract all same-origin `<a href>` links from the current page.
 * Returns absolute URLs filtered to the provided origin.
 */
export interface DiscoveredLink {
  url: string;
  text: string;
}

export async function scanPageLinks(tabId: number, origin: string): Promise<DiscoveredLink[]> {
  try {
    const response = await sendToContentScript<{ payload: DiscoveredLink[] }>(tabId, {
      type: 'GET_LINKS',
      payload: { origin },
    });
    return response?.payload ?? [];
  } catch {
    return [];
  }
}

export async function scanFormFields(tabId: number): Promise<FormField[]> {
  try {
    const response = await sendToContentScript<{ payload: FormField[] }>(tabId, {
      type: 'GET_FORM_FIELDS',
    });
    return response?.payload ?? [];
  } catch (err) {
    log.warn('scanFormFields failed', { tabId, err: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function getPageSnapshot(tabId: number): Promise<PageSnapshot | null> {
  try {
    const response = await sendToContentScript<{ payload: PageSnapshot }>(tabId, {
      type: 'GET_DOM_SNAPSHOT',
    });
    return response?.payload ?? null;
  } catch (err) {
    log.warn('getPageSnapshot failed', { tabId, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function scanPageMetadata(tabId: number): Promise<{ breadcrumb?: string; headings: string[] }> {
  try {
    const response = await sendToContentScript<{ payload: { breadcrumb?: string; headings: string[] } }>(tabId, {
      type: 'GET_PAGE_METADATA',
    });
    return response?.payload ?? { headings: [] };
  } catch {
    return { headings: [] };
  }
}

export async function detectModal(tabId: number): Promise<{
  found: boolean;
  title?: string;
  content?: string;
  formFields?: FormField[];
}> {
  try {
    const response = await sendToContentScript<{
      payload: { found: boolean; title?: string; content?: string; formFields?: FormField[] };
    }>(tabId, { type: 'DETECT_MODAL' });
    return response?.payload ?? { found: false };
  } catch (err) {
    log.warn('detectModal failed', { tabId, err: err instanceof Error ? err.message : String(err) });
    return { found: false };
  }
}

export async function scanPageActions(tabId: number): Promise<PageAction[]> {
  try {
    const response = await sendToContentScript<{ payload: PageAction[] }>(tabId, {
      type: 'GET_PAGE_ACTIONS',
    });
    return response?.payload ?? [];
  } catch {
    return [];
  }
}

export async function scanDataTables(tabId: number): Promise<DataTable[]> {
  try {
    const response = await sendToContentScript<{ payload: DataTable[] }>(tabId, {
      type: 'GET_DATA_TABLES',
    });
    return response?.payload ?? [];
  } catch {
    return [];
  }
}

export async function scanPageType(tabId: number): Promise<{ pageType: PageType; isErrorPage: boolean; httpStatus?: number }> {
  try {
    const response = await sendToContentScript<{
      payload: { pageType: PageType; isErrorPage: boolean; httpStatus?: number };
    }>(tabId, { type: 'GET_PAGE_TYPE' });
    return response?.payload ?? { pageType: 'other', isErrorPage: false };
  } catch {
    return { pageType: 'other', isErrorPage: false };
  }
}

export async function scanFieldErrors(tabId: number): Promise<FieldError[]> {
  try {
    const response = await sendToContentScript<{ payload: FieldError[] }>(tabId, {
      type: 'GET_FIELD_ERRORS',
    });
    return response?.payload ?? [];
  } catch {
    return [];
  }
}

export async function scanWizardSteps(tabId: number): Promise<WizardStep[]> {
  try {
    const response = await sendToContentScript<{ payload: WizardStep[] }>(tabId, {
      type: 'GET_WIZARD_STEPS',
    });
    return response?.payload ?? [];
  } catch {
    return [];
  }
}

export async function scanConditionalFields(tabId: number): Promise<Array<{ fieldSelector: string; triggerSelector: string; triggerValue: string }>> {
  try {
    const response = await sendToContentScript<{
      payload: Array<{ fieldSelector: string; triggerSelector: string; triggerValue: string }>;
    }>(tabId, { type: 'GET_CONDITIONAL_FIELDS' });
    return response?.payload ?? [];
  } catch {
    return [];
  }
}

const CLICKABLE_TAGS = new Set(['button', 'a']);
const CLICKABLE_ROLES = new Set(['button', 'tab', 'menuitem', 'link']);
const FORM_TAGS = new Set(['input', 'select', 'textarea']);
const FORM_ROLES = new Set(['combobox', 'listbox']);
const DANGEROUS_TEXTS = ['delete', 'remove', 'logout', 'sign out', 'cancel subscription'];
const EXCLUDED_INPUT_TYPES = new Set(['hidden', 'password', 'file']);

export interface ExplorationTargetOptions {
  /**
   * When true, includes destructive buttons (delete/remove/logout/etc.) in the
   * click set. Default false — destructive actions can wipe data, log the
   * tester out, or trigger billing-side effects, so we skip them by default.
   */
  includeDangerous?: boolean;
  /** Maximum number of click targets to return. Default 100. */
  maxTargets?: number;
}

export function selectExplorationTargets(
  elements: InteractiveElement[],
  visited: Set<string>,
  options: ExplorationTargetOptions = {}
): InteractiveElement[] {
  const { includeDangerous = false, maxTargets = 100 } = options;
  // NOTE: off-viewport-but-rendered elements ARE included — the click action
  // scrolls them into view first. We only require them to be clickable; the
  // ordering below clicks in-viewport elements first, off-viewport if budget
  // remains. This captures below-the-fold buttons and virtualized-list rows.
  const candidates = elements
    .filter((el) => {
      if (visited.has(el.selector)) return false;
      if (el.disabled) return false;
      if (FORM_TAGS.has(el.tag)) return false;
      const isClickable =
        CLICKABLE_TAGS.has(el.tag) || CLICKABLE_ROLES.has(el.role ?? '');
      if (!isClickable) return false;
      if (!includeDangerous) {
        const text = (el.text ?? '').toLowerCase();
        if (DANGEROUS_TEXTS.some((d) => new RegExp(`\\b${d}\\b`, 'i').test(text))) return false;
      }
      return true;
    });

  // Prioritise navigation links and buttons with meaningful text over generic elements.
  // This ensures we discover actual page routes before spending time on toolbar buttons.
  const navElements = candidates.filter((el) =>
    el.tag === 'a' || el.role === 'tab' || el.role === 'menuitem' || el.role === 'link'
  );
  const actionButtons = candidates.filter((el) =>
    el.tag === 'button' && !navElements.includes(el)
  );
  const other = candidates.filter((el) =>
    !navElements.includes(el) && !actionButtons.includes(el)
  );

  // Within the priority order, click in-viewport elements before off-viewport
  // ones (stable partition keeps relative order otherwise).
  const viewportFirst = (list: InteractiveElement[]): InteractiveElement[] =>
    [...list.filter((el) => el.visible), ...list.filter((el) => !el.visible)];

  return [
    ...viewportFirst(navElements),
    ...viewportFirst(actionButtons),
    ...viewportFirst(other),
  ].slice(0, maxTargets);
}

export function selectFormTargets(
  elements: InteractiveElement[],
  visited: Set<string>
): InteractiveElement[] {
  return elements
    .filter((el) => {
      if (!el.visible) return false;
      if (visited.has(el.selector)) return false;
      if (el.disabled) return false;
      if (el.tag === 'input' && EXCLUDED_INPUT_TYPES.has(el.type ?? '')) return false;
      const isFormElement =
        FORM_TAGS.has(el.tag) ||
        FORM_ROLES.has(el.role ?? '') ||
        el.contentEditable === true;
      return isFormElement;
    })
    .slice(0, 100);
}
