import type { InteractiveElement, FormField, PageSnapshot, PageAction, DataTable, PageType, FieldError, WizardStep, UnscannedFrame } from '../../storage/schemas';
import { sendToContentScript } from '../../messaging/messenger';
import { classifyControl } from './danger-heuristics';
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
 * Scroll through the page and hover nav items to reveal lazy-loaded content and
 * dropdown menus.
 *
 * Returns the elements seen DURING the sweep. Callers must merge these with their
 * own `scanPage` result: a virtualized row mounted at scroll step 4 is gone by the
 * time the sweep ends, so the post-sweep scan cannot see it. Returning an empty
 * array on failure is safe — the caller still has its own scan.
 */
export async function revealPageContent(tabId: number): Promise<InteractiveElement[]> {
  try {
    const response = await sendToContentScript<{ payload: InteractiveElement[] }>(tabId, {
      type: 'REVEAL_PAGE_CONTENT',
    });
    return response?.payload ?? [];
  } catch {
    // non-fatal — continue even if reveal fails
    return [];
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

/**
 * Frames on the page the scan could not see into.
 *
 * Failure is reported as "none found", not as an error: a page whose content
 * script never answered has bigger problems than its frame inventory, and the
 * explorer should not abort a page over it.
 */
export async function scanUnscannedFrames(tabId: number): Promise<UnscannedFrame[]> {
  try {
    const response = await sendToContentScript<{
      payload: { frames: UnscannedFrame[]; omitted: number };
    }>(tabId, { type: 'GET_FRAME_COVERAGE' });
    return response?.payload?.frames ?? [];
  } catch {
    return [];
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

/**
 * A focusable custom widget: no semantic role, but a tabindex that makes it
 * keyboard-reachable — which is how design systems build dropdowns.
 *
 * Measured on a live app: 118 dropdowns, and **zero** native `<select>` elements
 * anywhere in it. Every one is `<div class="oxd-select-text-input" tabindex="0">`.
 * They were detected and then never clicked, because the click set required a
 * button/anchor tag or a button-ish role — so no filter and no dropdown in the
 * entire application could be operated.
 */
function isFocusableWidget(el: InteractiveElement): boolean {
  if (FORM_TAGS.has(el.tag)) return false;
  if (el.tabIndex === undefined || el.tabIndex < 0) return false;
  // A role we already handle elsewhere shouldn't be double-counted here.
  const role = el.role ?? '';
  if (CLICKABLE_ROLES.has(role)) return false;
  return role === '' || role === 'combobox' || role === 'listbox';
}

/**
 * How many rows to click per page.
 *
 * Rows on a list page are homogeneous: every one leads to the same detail
 * template, so the second and third confirm the pattern and the fiftieth teaches
 * nothing. A measured page had 50 — clicking them all would spend the entire page
 * budget navigating back and forth to one template.
 */
const MAX_ROW_NAVIGATIONS = 3;

export interface TargetPartition {
  targets: InteractiveElement[];
  /**
   * Withheld because clicking them ends the session. Withheld even under
   * `includeDangerous` — a logged-out crawler maps the login page while the run
   * keeps counting pages as explored.
   */
  sessionEnding: InteractiveElement[];
  /** Withheld because they name or depict a destructive action. */
  destructive: InteractiveElement[];
  /** Withheld because they are unnamed row controls of unknown effect. */
  unidentified: InteractiveElement[];
  /** Dropped by `maxTargets` after prioritisation. */
  overCap: number;
  /** Row-navigation targets beyond `MAX_ROW_NAVIGATIONS`. */
  rowNavigationsSkipped: number;
}

/**
 * Choose click targets, and account for everything withheld.
 *
 * Returns the withheld sets rather than silently dropping them: a crawler that
 * skips 50 controls per page and says nothing reports the same coverage as one
 * that had nothing to skip.
 */
export function partitionExplorationTargets(
  elements: InteractiveElement[],
  visited: Set<string>,
  options: ExplorationTargetOptions = {}
): TargetPartition {
  const { includeDangerous = false, maxTargets = 100 } = options;

  // NOTE: off-viewport-but-rendered elements ARE included — the click action
  // scrolls them into view first. We only require them to be clickable; the
  // ordering below clicks in-viewport elements first, off-viewport if budget
  // remains. This captures below-the-fold buttons and virtualized-list rows.
  const clickable = elements.filter((el) => {
    if (visited.has(el.selector)) return false;
    if (el.disabled) return false;
    if (FORM_TAGS.has(el.tag)) return false;
    return CLICKABLE_TAGS.has(el.tag) || CLICKABLE_ROLES.has(el.role ?? '') || isFocusableWidget(el);
  });

  const sessionEnding: InteractiveElement[] = [];
  const destructive: InteractiveElement[] = [];
  const unidentified: InteractiveElement[] = [];
  const candidates: InteractiveElement[] = [];
  let rowNavSeen = 0;
  let rowNavigationsSkipped = 0;
  for (const el of clickable) {
    if (el.rowNavigation) {
      // Sampled, not exhausted — and the shortfall is counted rather than dropped.
      rowNavSeen++;
      if (rowNavSeen > MAX_ROW_NAVIGATIONS) { rowNavigationsSkipped++; continue; }
    }
    const verdict = classifyControl(el);
    // Checked before the includeDangerous escape hatch: opting into destructive
    // exploration is a decision about data, not about staying signed in.
    if (verdict.risk === 'session-ending') { sessionEnding.push(el); continue; }
    if (includeDangerous) { candidates.push(el); continue; }
    if (verdict.risk === 'destructive') destructive.push(el);
    else if (verdict.risk === 'unidentified') unidentified.push(el);
    else candidates.push(el);
  }

  // Prioritise navigation links and buttons with meaningful text over generic elements.
  // This ensures we discover actual page routes before spending time on toolbar buttons.
  const navElements = candidates.filter((el) =>
    el.tag === 'a' || el.role === 'tab' || el.role === 'menuitem' || el.role === 'link'
  );
  const actionButtons = candidates.filter((el) =>
    el.tag === 'button' && !navElements.includes(el)
  );
  // Dropdowns before generic pseudo-clickables: opening one reveals its options,
  // which is a larger discovery than most stray divs.
  const widgets = candidates.filter(
    (el) => isFocusableWidget(el) && !navElements.includes(el) && !actionButtons.includes(el)
  );
  // Row navigations rank with navigation, not with leftovers: on a list page the
  // record detail behind a row is usually the most valuable thing on the screen,
  // and it is reachable no other way when the row carries no href.
  const rowNav = candidates.filter(
    (el) => el.rowNavigation && !navElements.includes(el) && !actionButtons.includes(el) && !widgets.includes(el)
  );
  const other = candidates.filter(
    (el) => !navElements.includes(el) && !actionButtons.includes(el) && !widgets.includes(el) && !rowNav.includes(el)
  );

  // Within the priority order, click in-viewport elements before off-viewport
  // ones (stable partition keeps relative order otherwise).
  const viewportFirst = (list: InteractiveElement[]): InteractiveElement[] =>
    [...list.filter((el) => el.visible), ...list.filter((el) => !el.visible)];

  const ordered = [
    ...viewportFirst(navElements),
    ...viewportFirst(rowNav),
    ...viewportFirst(actionButtons),
    ...viewportFirst(widgets),
    ...viewportFirst(other),
  ];

  return {
    targets: ordered.slice(0, maxTargets),
    sessionEnding,
    destructive,
    unidentified,
    overCap: Math.max(0, ordered.length - maxTargets),
    rowNavigationsSkipped,
  };
}

/**
 * Most stay-on-page controls added back to an AI-ranked target list.
 *
 * Agent mode exists to keep the per-page cost down, so the union has to be
 * bounded or it defeats the point. Ten covers the button clusters seen in
 * practice; the shortfall is reported rather than silently dropped.
 */
export const MAX_REVEAL_CANDIDATES_ADDED = 10;

/**
 * Does clicking this stay on the page, and could it therefore reveal something?
 *
 * Links, tabs and menu items navigate or switch view, and the explorer already
 * handles those through its own paths. A `<button>` is the control that swaps
 * fields into the page in place — which is the case the reveal capture exists
 * for, and the one that is invisible until it is clicked.
 */
function isRevealCandidate(el: InteractiveElement): boolean {
  if (el.tag === 'a') return false;
  const role = el.role ?? '';
  if (role === 'link' || role === 'tab' || role === 'menuitem') return false;
  return el.tag === 'button' || role === 'button';
}

export interface RevealUnion<T> {
  targets: T[];
  /** How many stay-on-page controls were added back to the AI's list. */
  added: number;
  /** Candidates left out because the cap was reached. */
  omitted: number;
}

/**
 * Union an AI-ranked target list with the stay-on-page controls it left out.
 *
 * Agent mode replaced the deterministic target list with the model's picks
 * outright, so a `<button>` the model did not happen to rank was never clicked
 * — and a form that only exists after that click was therefore never captured.
 * A ranking model deciding which elements are *interesting* is a reasonable
 * cost control; it is not a reasonable way to decide which elements *exist*.
 *
 * `ranked` comes first so the model's ordering is preserved and its picks are
 * tried while the page budget is still healthy.
 */
export function unionWithRevealCandidates<T>(
  ranked: readonly T[],
  gatedCandidates: readonly InteractiveElement[],
  selectorOf: (item: T) => string,
  toTarget: (el: InteractiveElement) => T,
  maxAdded = MAX_REVEAL_CANDIDATES_ADDED
): RevealUnion<T> {
  const alreadyRanked = new Set(ranked.map(selectorOf));
  // Drawn from the ALREADY-GATED list, so the safety classifier's refusals are
  // inherited rather than re-litigated here.
  const missing = gatedCandidates.filter(
    (el) => isRevealCandidate(el) && !alreadyRanked.has(el.selector)
  );

  const added = missing.slice(0, maxAdded);
  return {
    targets: [...ranked, ...added.map(toTarget)],
    added: added.length,
    omitted: missing.length - added.length,
  };
}

export function selectExplorationTargets(
  elements: InteractiveElement[],
  visited: Set<string>,
  options: ExplorationTargetOptions = {}
): InteractiveElement[] {
  return partitionExplorationTargets(elements, visited, options).targets;
}

const TOGGLE_INPUT_TYPES = new Set(['checkbox', 'radio']);
const TOGGLE_ROLES = new Set(['checkbox', 'radio', 'switch']);

export interface ToggleTargetOptions {
  /**
   * Include toggles OUTSIDE a table/grid/list region.
   *
   * Off by default, and the reason is a real difference in consequence: a
   * row-selection checkbox changes client-side selection only, while a settings
   * toggle usually persists immediately (`PATCH /preferences`). Discovering bulk
   * actions should not silently rewrite the user's account settings.
   */
  includeSettingsToggles?: boolean;
  /** Maximum toggles to return. Default 5 — enough to reveal a bulk-action bar. */
  maxTargets?: number;
}

/**
 * Selection controls worth toggling to discover what selecting things reveals.
 *
 * These are deliberately absent from `selectExplorationTargets`, which filters out
 * every form tag. That exclusion meant bulk-action flows — select rows, act on the
 * selection — were invisible to exploration on every list page in the app, even
 * though the toolbar they reveal is often the most consequential UI there.
 */
export function selectToggleTargets(
  elements: InteractiveElement[],
  visited: Set<string>,
  options: ToggleTargetOptions = {}
): InteractiveElement[] {
  const { includeSettingsToggles = false, maxTargets = 5 } = options;

  const candidates = elements.filter((el) => {
    if (visited.has(el.selector)) return false;
    if (el.disabled) return false;
    const isToggle =
      (el.tag === 'input' && TOGGLE_INPUT_TYPES.has(el.type ?? '')) ||
      TOGGLE_ROLES.has(el.role ?? '');
    if (!isToggle) return false;
    if (!includeSettingsToggles && !el.inDataRegion) return false;
    return true;
  });

  // Row checkboxes before the header "select all": one row is the cheaper probe
  // and reveals the same toolbar, and a header toggle on a 4,000-row grid selects
  // everything — a far riskier state to leave behind if a reset ever fails.
  const isSelectAll = (el: InteractiveElement): boolean =>
    /select\s*all|all\s*rows/i.test(`${el.ariaLabel ?? ''} ${el.text ?? ''}`);

  return [
    ...candidates.filter((el) => !isSelectAll(el)),
    ...candidates.filter((el) => isSelectAll(el)),
  ].slice(0, maxTargets);
}
