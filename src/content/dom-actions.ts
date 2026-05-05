import { waitForElement, waitForDOMIdle, isNetworkIdle, waitForNetworkIdle } from './dom-observer';
import type { ExecutionStep } from '../storage/schemas';

const ACTION_DELAY_MS = 150;

export interface ActionResult {
  success: boolean;
  error?: string;
}

export async function executeAction(step: ExecutionStep): Promise<ActionResult> {
  try {
    switch (step.action) {
      case 'click':
        return await clickElement(step.selector!, step.timeout);
      case 'double_click':
        return await doubleClickElement(step.selector!, step.timeout);
      case 'type':
        return await typeText(step.selector!, step.value ?? '', step.timeout);
      case 'clear':
        return await clearInput(step.selector!, step.timeout);
      case 'check':
        return await checkElement(step.selector!, true, step.timeout);
      case 'uncheck':
        return await checkElement(step.selector!, false, step.timeout);
      case 'select':
        return await selectOption(step.selector!, step.value ?? '', step.timeout);
      case 'press_key':
        return await pressKey(step.selector, step.key ?? 'Enter', step.timeout);
      case 'wait':
        return await waitFor(step.selector!, step.timeout);
      case 'assert':
        return await assertState(step);
      case 'scroll':
        return await scrollTo(step.selector, step.value);
      case 'hover':
        return await hoverElement(step.selector!, step.timeout);
      case 'drag_drop':
        return await dragAndDrop(step.selector!, step.targetSelector!, step.timeout);
      case 'navigate':
        // Navigation is handled by the background service worker via chrome.tabs.update.
        // If this path is ever reached inside the content script it means a step was
        // routed incorrectly — return success so the background can handle it.
        return { success: true };
      case 'upload_file':
        return await uploadFile(step.selector!, step.value ?? '', step.timeout);
      case 'dismiss_dialog':
        return await dismissDialog();
      default:
        return { success: false, error: `Unknown action: ${(step as ExecutionStep).action}` };
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Click — fires the full pointer + mouse + click event chain that React, Vue,
// and Angular all listen to.
//
// Handles common obscuring scenarios:
//  1. Sticky headers/nav bars covering the element after scroll
//  2. MUI / Material Design modal backdrops (MuiBackdrop-root)
//  3. Navigation menu overlays (expanded-navigation-menu-head, etc.)
//  4. Generic overlay / popup dismiss
// ---------------------------------------------------------------------------
async function clickElement(selector: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const htmlEl = el as HTMLElement;

  // ── Step 1: Scroll into view, accounting for sticky headers ────────
  await scrollIntoViewSafe(htmlEl);
  await delay(ACTION_DELAY_MS);

  // ── Step 2: Check if element is obscured and try to unblock ────────
  let rect = htmlEl.getBoundingClientRect();
  let cx = rect.left + rect.width / 2;
  let cy = rect.top + rect.height / 2;

  const obscurer = getObscuringElement(htmlEl, cx, cy);
  if (obscurer) {
    // Try multiple strategies to unblock the element
    const unblocked = await tryUnblockElement(htmlEl, obscurer);

    // Recalculate coordinates after unblocking attempts
    rect = htmlEl.getBoundingClientRect();
    cx = rect.left + rect.width / 2;
    cy = rect.top + rect.height / 2;

    if (!unblocked) {
      // Fallback 1: Probe edges for an unobscured point
      const clearPoint = findClearClickPoint(htmlEl);
      if (clearPoint) {
        console.debug(`[pathfinder] Using edge point (${Math.round(clearPoint.x)},${Math.round(clearPoint.y)}) to avoid ${describeElement(obscurer)}`);
        fireClickSequence(htmlEl, clearPoint.x, clearPoint.y);

        await waitForDOMIdle(400, 5000);
        if (!isNetworkIdle()) {
          await waitForNetworkIdle(3000);
        }
        return { success: true };
      }

      // Fallback 2: Direct .click() bypasses coordinate hit-testing
      console.warn(`[pathfinder] Element fully obscured by ${describeElement(obscurer)} — using direct click()`);
      htmlEl.click();

      await waitForDOMIdle(400, 5000);
      if (!isNetworkIdle()) {
        await waitForNetworkIdle(3000);
      }
      return { success: true };
    }
  }

  // ── Step 3: Fire the full click event chain ────────────────────────
  fireClickSequence(htmlEl, cx, cy);

  // ── Step 4: Wait for DOM + network to settle ───────────────────────
  await waitForDOMIdle(400, 5000);
  if (!isNetworkIdle()) {
    await waitForNetworkIdle(3000);
  }

  return { success: true };
}

/**
 * Scroll element into view while accounting for sticky headers / fixed navs.
 * Uses `block: 'center'` first, then checks if a fixed header covers the
 * element and adjusts with an extra offset scroll.
 */
async function scrollIntoViewSafe(el: HTMLElement): Promise<void> {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(200);

  const rect = el.getBoundingClientRect();
  const stickyOffset = getStickyHeaderHeight();

  // If the element's top is behind a sticky header, scroll down further
  if (rect.top < stickyOffset + 10) {
    const scrollAmt = stickyOffset - rect.top + 20; // 20px padding
    window.scrollBy({ top: scrollAmt, behavior: 'smooth' });
    await delay(150);
  }

  // If element is below viewport, scroll it up
  if (rect.bottom > window.innerHeight - 20) {
    window.scrollBy({ top: rect.bottom - window.innerHeight + 40, behavior: 'smooth' });
    await delay(150);
  }

  // If element is behind a left sidebar, scroll horizontally to clear it
  const sidebarWidth = getStickyLeftWidth();
  if (sidebarWidth > 0) {
    const updatedRect = el.getBoundingClientRect();
    if (updatedRect.left < sidebarWidth + 10) {
      const horizontalOffset = sidebarWidth - updatedRect.left + 20;
      const scrollParent = findScrollableParent(el);
      if (scrollParent) {
        scrollParent.scrollBy({ left: horizontalOffset, behavior: 'smooth' });
      } else {
        window.scrollBy({ left: horizontalOffset, behavior: 'smooth' });
      }
      await delay(150);
    }
  }
}

/**
 * Detect the total height of sticky/fixed headers at the top of the viewport.
 */
function getStickyHeaderHeight(): number {
  let maxBottom = 0;
  const HEADER_SELECTORS = ['header', 'nav', '[role="banner"]', '[role="navigation"]'];

  for (const sel of HEADER_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
          const rect = el.getBoundingClientRect();
          if (rect.top <= 5 && rect.height > 0) {
            maxBottom = Math.max(maxBottom, rect.bottom);
          }
        }
      });
    } catch {
      // skip
    }
  }

  // Also check any element with position:fixed at the top
  try {
    const allFixed = document.querySelectorAll('*');
    for (const el of Array.from(allFixed).slice(0, 500)) {
      const style = getComputedStyle(el);
      if (
        (style.position === 'fixed' || style.position === 'sticky') &&
        el.getBoundingClientRect().top <= 5 &&
        el.getBoundingClientRect().height > 20 &&
        el.getBoundingClientRect().height < 200 // reasonable header height
      ) {
        maxBottom = Math.max(maxBottom, el.getBoundingClientRect().bottom);
      }
    }
  } catch {
    // skip
  }

  return maxBottom;
}

/**
 * Classify which viewport edge a fixed/sticky element is anchored to.
 * Returns 'top' | 'left' | 'right' | 'bottom' | null.
 */
function classifyStickyPosition(el: HTMLElement): 'top' | 'left' | 'right' | 'bottom' | null {
  const style = getComputedStyle(el);
  if (style.position !== 'fixed' && style.position !== 'sticky') return null;

  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Left sidebar: anchored to left edge, tall relative to viewport
  if (rect.left <= 10 && rect.height > vh * 0.3 && rect.width < vw * 0.4) {
    return 'left';
  }
  // Right sidebar: anchored to right edge, tall relative to viewport
  if (rect.right >= vw - 10 && rect.height > vh * 0.3 && rect.width < vw * 0.4) {
    return 'right';
  }
  // Top header: anchored to top, wide relative to viewport
  if (rect.top <= 10 && rect.width > vw * 0.3 && rect.height < vh * 0.4) {
    return 'top';
  }
  // Bottom bar: anchored to bottom, wide relative to viewport
  if (rect.bottom >= vh - 10 && rect.width > vw * 0.3 && rect.height < vh * 0.4) {
    return 'bottom';
  }

  return null;
}

/**
 * Detect the width of fixed/sticky elements anchored to the left edge (sidebars).
 */
function getStickyLeftWidth(): number {
  let maxRight = 0;
  const SIDEBAR_SELECTORS = ['nav', 'aside', '[role="navigation"]', '[class*="sidebar"]', '[class*="Sidebar"]', '[class*="nav-menu"]', '[class*="NavMenu"]'];

  for (const sel of SIDEBAR_SELECTORS) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        if (classifyStickyPosition(el as HTMLElement) === 'left') {
          maxRight = Math.max(maxRight, el.getBoundingClientRect().right);
        }
      });
    } catch {
      // skip
    }
  }

  // Also scan first 500 elements for left-anchored fixed/sticky
  try {
    const allEls = document.querySelectorAll('*');
    for (const el of Array.from(allEls).slice(0, 500)) {
      if (classifyStickyPosition(el as HTMLElement) === 'left') {
        maxRight = Math.max(maxRight, el.getBoundingClientRect().right);
      }
    }
  } catch {
    // skip
  }

  return maxRight;
}

/**
 * Walk up the DOM to find the nearest ancestor with horizontal scroll capability.
 */
function findScrollableParent(el: HTMLElement): HTMLElement | null {
  let current = el.parentElement;
  while (current && current !== document.documentElement) {
    const style = getComputedStyle(current);
    const overflowX = style.overflowX;
    if (
      (overflowX === 'auto' || overflowX === 'scroll') &&
      current.scrollWidth > current.clientWidth
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/**
 * Check if an element is obscured at its center point.
 * Returns the obscuring element or null if the element is clickable.
 */
function getObscuringElement(target: HTMLElement, cx: number, cy: number): HTMLElement | null {
  const topEl = document.elementFromPoint(cx, cy);
  if (!topEl) return null;
  if (topEl === target || target.contains(topEl) || topEl.contains(target)) return null;
  return topEl as HTMLElement;
}

/**
 * Try multiple strategies to unblock an obscured element.
 * Returns true if the element is now unobscured.
 */
async function tryUnblockElement(target: HTMLElement, obscurer: HTMLElement): Promise<boolean> {
  // ── Strategy 1: Dismiss MUI / Material backdrops ──────────────────
  if (isMuiBackdrop(obscurer)) {
    // Press Escape to close the modal
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await delay(300);

    // Check if it worked
    const rect = target.getBoundingClientRect();
    if (!getObscuringElement(target, rect.left + rect.width / 2, rect.top + rect.height / 2)) return true;

    // Try clicking the backdrop itself (many modals close on backdrop click)
    obscurer.click();
    await delay(500);

    const rect2 = target.getBoundingClientRect();
    if (!getObscuringElement(target, rect2.left + rect2.width / 2, rect2.top + rect2.height / 2)) return true;
  }

  // ── Strategy 2: Dismiss generic popups / overlays / banners ────────
  if (isOverlay(obscurer)) {
    // Look for close / dismiss buttons inside the overlay
    const closeBtn = findCloseButton(obscurer);
    if (closeBtn) {
      closeBtn.click();
      await delay(400);
      const rect = target.getBoundingClientRect();
      if (!getObscuringElement(target, rect.left + rect.width / 2, rect.top + rect.height / 2)) return true;
    }

    // Try Escape key
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await delay(300);
    const rect = target.getBoundingClientRect();
    if (!getObscuringElement(target, rect.left + rect.width / 2, rect.top + rect.height / 2)) return true;
  }

  // ── Strategy 3: Sticky nav / header / sidebar covering element — position-aware scroll ──
  if (isStickyElement(obscurer)) {
    const stickyPos = classifyStickyPosition(obscurer);
    const stickyRect = obscurer.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();

    if (stickyPos === 'top') {
      // Scroll DOWN to move element below the header
      const neededScroll = stickyRect.bottom - targetRect.top + 30;
      window.scrollBy({ top: neededScroll, behavior: 'smooth' });
    } else if (stickyPos === 'left') {
      // Scroll content RIGHT to move element clear of left sidebar
      const neededScroll = stickyRect.right - targetRect.left + 30;
      const scrollParent = findScrollableParent(target);
      if (scrollParent) {
        scrollParent.scrollBy({ left: neededScroll, behavior: 'smooth' });
      } else {
        window.scrollBy({ left: neededScroll, behavior: 'smooth' });
      }
    } else if (stickyPos === 'right') {
      // Scroll content LEFT to move element clear of right sidebar
      const neededScroll = targetRect.right - stickyRect.left + 30;
      const scrollParent = findScrollableParent(target);
      if (scrollParent) {
        scrollParent.scrollBy({ left: -neededScroll, behavior: 'smooth' });
      } else {
        window.scrollBy({ left: -neededScroll, behavior: 'smooth' });
      }
    } else {
      // Fallback: scroll DOWN
      const neededScroll = stickyRect.bottom - targetRect.top + 30;
      window.scrollBy({ top: neededScroll, behavior: 'smooth' });
    }
    await delay(300);

    const rect = target.getBoundingClientRect();
    if (!getObscuringElement(target, rect.left + rect.width / 2, rect.top + rect.height / 2)) return true;
  }

  // ── Strategy 4: Inline label/span obscurer — click it directly ──────
  // Many UI frameworks wrap clickable elements with a label/span that sits
  // on top due to CSS stacking. If the obscurer is an inline text element
  // inside the same parent or a sibling, clicking it will bubble to the target.
  if (isInlineTextElement(obscurer)) {
    const shareParent = obscurer.parentElement === target.parentElement ||
      obscurer.closest('button, a, [role="button"], label') === target.closest('button, a, [role="button"], label') ||
      target.contains(obscurer.parentElement) ||
      obscurer.parentElement?.contains(target);
    if (shareParent) {
      obscurer.click();
      await delay(300);
      return true; // Click bubbled through the label to the target
    }
  }

  // ── Strategy 5: Wait briefly — overlay may be transitioning out ────
  await delay(500);
  const rect = target.getBoundingClientRect();
  if (!getObscuringElement(target, rect.left + rect.width / 2, rect.top + rect.height / 2)) return true;

  // ── Strategy 6: Click body to dismiss open menus/dropdowns ──────────
  // Some overlay menus close when you click outside them.
  if (isOverlay(obscurer) || obscurer.className?.toLowerCase().includes('menu')) {
    document.body.click();
    await delay(300);
    const rectMenu = target.getBoundingClientRect();
    if (!getObscuringElement(target, rectMenu.left + rectMenu.width / 2, rectMenu.top + rectMenu.height / 2)) return true;
  }

  // ── Strategy 7: Try collapsing sidebar via toggle button ────────────
  if (isStickyElement(obscurer) && classifyStickyPosition(obscurer) === 'left') {
    const toggle = findSidebarToggle(obscurer);
    if (toggle) {
      toggle.click();
      await delay(500);
      const rect5 = target.getBoundingClientRect();
      if (!getObscuringElement(target, rect5.left + rect5.width / 2, rect5.top + rect5.height / 2)) return true;
    }
  }

  return false;
}

/** Check if element is an MUI backdrop/modal overlay */
function isMuiBackdrop(el: HTMLElement): boolean {
  const cls = el.className || '';
  return (
    cls.includes('MuiBackdrop') ||
    cls.includes('MuiModal') ||
    cls.includes('MuiDialog') ||
    cls.includes('mtdls-modal') ||          // MindTickle Design System modals
    cls.includes('modal-wrapper') ||
    el.getAttribute('role') === 'presentation' ||
    (cls.includes('backdrop') && getComputedStyle(el).position === 'fixed')
  );
}

/** Check if element is a generic overlay / popup */
function isOverlay(el: HTMLElement): boolean {
  const cls = (el.className || '').toLowerCase();
  const style = getComputedStyle(el);
  const isFixedFullScreen =
    (style.position === 'fixed' || style.position === 'absolute') &&
    el.getBoundingClientRect().width > window.innerWidth * 0.5 &&
    el.getBoundingClientRect().height > window.innerHeight * 0.3;

  return (
    isFixedFullScreen ||
    cls.includes('overlay') ||
    cls.includes('modal') ||
    cls.includes('popup') ||
    cls.includes('dialog') ||
    cls.includes('backdrop') ||
    cls.includes('cookie') ||
    cls.includes('consent') ||
    cls.includes('banner') ||
    cls.includes('menu-content-wrapper') || // MindTickle menu overlays
    cls.includes('menu-wrapper') ||
    cls.includes('dropdown-overlay') ||
    el.getAttribute('role') === 'dialog' ||
    el.getAttribute('role') === 'alertdialog'
  );
}

/** Check if element is a sticky/fixed header, nav, or sidebar */
function isStickyElement(el: HTMLElement): boolean {
  const cls = (el.className || '').toLowerCase();
  return (
    classifyStickyPosition(el) !== null ||
    cls.includes('nav-menu-head') ||
    cls.includes('sticky') ||
    cls.includes('fixed-header') ||
    cls.includes('sidebar') ||
    cls.includes('header-layout') ||          // MindTickle header wrapper
    cls.includes('header-wrapper') ||
    cls.includes('top-bar') ||
    cls.includes('app-header') ||
    el.tagName === 'HEADER'
  );
}

/** Check if element is an inline text element (span, label, etc.) rather than a structural overlay */
function isInlineTextElement(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  const display = getComputedStyle(el).display;
  return (
    (tag === 'span' || tag === 'label' || tag === 'em' || tag === 'strong' || tag === 'i' || tag === 'b') ||
    display === 'inline' || display === 'inline-block'
  );
}

/** Find a close/dismiss button inside an overlay element */
function findCloseButton(container: HTMLElement): HTMLElement | null {
  const CLOSE_SELECTORS = [
    'button[aria-label*="close" i]',
    'button[aria-label*="dismiss" i]',
    'button[aria-label*="Close" i]',
    '[data-testid*="close" i]',
    '[data-dismiss]',
    '.close-button',
    '.close-btn',
    '.btn-close',
    '.modal-close',
    'button.close',
    '.mtdls-modal-close',                    // MindTickle Design System
    '[class*="modal-close"]',
    '[class*="CloseIcon"]',
    '[class*="close-icon"]',
    'i.icon-close',                          // Icon-font close buttons
    'svg[class*="close" i]',                 // SVG close icons
    '[class*="close" i]:is(button, [role="button"])',
    // X / × character buttons
    'button:not([disabled])',
  ];

  for (const sel of CLOSE_SELECTORS) {
    try {
      const btns = container.querySelectorAll(sel);
      for (const btn of Array.from(btns)) {
        const text = (btn.textContent ?? '').trim().toLowerCase();
        const ariaLabel = (btn.getAttribute('aria-label') ?? '').toLowerCase();
        // Match close/dismiss/ok/accept/proceed buttons
        if (
          text === '×' || text === 'x' || text === '✕' ||
          text === 'close' || text === 'dismiss' || text === 'ok' ||
          text === 'accept' || text === 'proceed' || text === 'got it' ||
          text === 'i agree' || text === 'accept all' ||
          ariaLabel.includes('close') || ariaLabel.includes('dismiss')
        ) {
          return btn as HTMLElement;
        }
      }
    } catch {
      // skip invalid selectors
    }
  }

  return null;
}

/** Find a hamburger/toggle/collapse button associated with a sidebar */
function findSidebarToggle(sidebar: HTMLElement): HTMLElement | null {
  const TOGGLE_SELECTORS = [
    'button[aria-label*="menu" i]',
    'button[aria-label*="toggle" i]',
    'button[aria-label*="collapse" i]',
    'button[aria-label*="sidebar" i]',
    '[data-testid*="toggle" i]',
    '[data-testid*="hamburger" i]',
    '[class*="hamburger" i]',
    '[class*="toggle" i]:is(button, [role="button"])',
    '[class*="collapse" i]:is(button, [role="button"])',
    '[class*="menu-toggle" i]',
  ];

  // Search inside the sidebar itself
  for (const sel of TOGGLE_SELECTORS) {
    try {
      const btn = sidebar.querySelector(sel);
      if (btn) return btn as HTMLElement;
    } catch {
      // skip
    }
  }

  // Search in the sidebar's parent (toggle is often outside the nav)
  const parent = sidebar.parentElement;
  if (parent) {
    for (const sel of TOGGLE_SELECTORS) {
      try {
        const btn = parent.querySelector(sel);
        if (btn) return btn as HTMLElement;
      } catch {
        // skip
      }
    }
  }

  return null;
}

/**
 * Probe 9 points on the element (center, edges, corners) looking for one
 * where the target element is on top (not obscured). Returns {x, y} or null.
 */
function findClearClickPoint(target: HTMLElement): { x: number; y: number } | null {
  const rect = target.getBoundingClientRect();
  const inset = 4; // px inset from edges to avoid border hit-testing issues
  const points = [
    { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },       // center
    { x: rect.left + inset, y: rect.top + rect.height / 2 },                 // left edge
    { x: rect.right - inset, y: rect.top + rect.height / 2 },                // right edge
    { x: rect.left + rect.width / 2, y: rect.top + inset },                  // top edge
    { x: rect.left + rect.width / 2, y: rect.bottom - inset },               // bottom edge
    { x: rect.left + inset, y: rect.top + inset },                           // top-left corner
    { x: rect.right - inset, y: rect.top + inset },                          // top-right corner
    { x: rect.left + inset, y: rect.bottom - inset },                        // bottom-left corner
    { x: rect.right - inset, y: rect.bottom - inset },                       // bottom-right corner
  ];

  for (const pt of points) {
    if (pt.x < 0 || pt.y < 0 || pt.x > window.innerWidth || pt.y > window.innerHeight) continue;
    const topEl = document.elementFromPoint(pt.x, pt.y);
    if (topEl && (topEl === target || target.contains(topEl) || topEl.contains(target))) {
      return pt;
    }
  }
  return null;
}

/** Describe an element for debug logging */
function describeElement(el: HTMLElement): string {
  const tag = el.tagName;
  const cls = (el.className || '').toString().slice(0, 100);
  return `${tag}${cls ? '.' + cls.split(/\s+/).slice(0, 3).join('.') : ''}`;
}

/**
 * Fire the full synthetic click event sequence that React/Vue/Angular recognise.
 */
function fireClickSequence(htmlEl: HTMLElement, cx: number, cy: number): void {
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: cx,
    clientY: cy,
    button: 0,
    buttons: 1,
  };

  htmlEl.dispatchEvent(new PointerEvent('pointerover', { ...eventInit, pointerId: 1 }));
  htmlEl.dispatchEvent(new PointerEvent('pointerenter', { ...eventInit, pointerId: 1, bubbles: false }));
  htmlEl.dispatchEvent(new MouseEvent('mouseover', eventInit));
  htmlEl.dispatchEvent(new MouseEvent('mouseenter', { ...eventInit, bubbles: false }));
  htmlEl.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, pointerId: 1 }));
  htmlEl.dispatchEvent(new MouseEvent('mousemove', eventInit));
  htmlEl.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1 }));
  htmlEl.dispatchEvent(new MouseEvent('mousedown', eventInit));
  htmlEl.focus();
  htmlEl.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1 }));
  htmlEl.dispatchEvent(new MouseEvent('mouseup', eventInit));
  htmlEl.click();
  htmlEl.dispatchEvent(new MouseEvent('click', eventInit));
}

// ---------------------------------------------------------------------------
// Type — uses the native HTMLInputElement value setter so React's synthetic
// event system recognises the change and updates internal fiber state.
// ---------------------------------------------------------------------------
async function typeText(selector: string, text: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const input = el as HTMLInputElement | HTMLTextAreaElement;

  input.focus();
  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(ACTION_DELAY_MS);

  // Clear existing value first
  await setNativeValue(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));

  // Set the full value via native setter (bypasses React's read-only .value trap)
  await setNativeValue(input, text);

  // Fire the event sequence that React/Vue/Angular controlled-input handlers expect
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

  // Also fire keyboard events for components that listen at key level
  for (const char of text) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true, cancelable: true }));
  }

  await waitForDOMIdle(150, 2000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Clear — explicitly empties an input field.
// ---------------------------------------------------------------------------
async function clearInput(selector: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const input = el as HTMLInputElement | HTMLTextAreaElement;

  input.focus();
  await setNativeValue(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Select — choose an option from a <select> element or custom dropdown by
// visible text or value.
// ---------------------------------------------------------------------------
async function selectOption(selector: string, value: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);

  // Native <select> element
  if (el.tagName.toLowerCase() === 'select') {
    return selectNativeOption(el as HTMLSelectElement, value);
  }

  // Custom dropdown (React Select, Ant Design, Headless UI, Radix, etc.)
  return selectCustomDropdownOption(el as HTMLElement, value, timeout);
}

async function selectNativeOption(select: HTMLSelectElement, value: string): Promise<ActionResult> {
  let matched = false;
  for (const opt of Array.from(select.options)) {
    if (opt.text.trim() === value || opt.value === value || opt.text.trim().toLowerCase() === value.toLowerCase()) {
      select.value = opt.value;
      matched = true;
      break;
    }
  }

  if (!matched) {
    return { success: false, error: `No option matching "${value}" found in native select` };
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(select, select.value);

  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));

  await waitForDOMIdle(150, 2000);
  return { success: true };
}

async function selectCustomDropdownOption(trigger: HTMLElement, value: string, _timeout: number): Promise<ActionResult> {
  // Step 1: Click the trigger to open the dropdown
  trigger.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(ACTION_DELAY_MS);
  trigger.click();
  trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));

  // Step 2: Wait for dropdown options to appear by polling.
  // Many custom dropdowns (React Select, Ant Design, MUI, Headless UI) load
  // options lazily or with animation. Polling handles these reliably.
  const optionSelectors = [
    `[role="option"]`,
    `[role="listbox"] > *`,
    `[role="menu"] > *`,
    `[role="menuitem"]`,
    `li[data-value]`,
    `.option`,
    `[class*="option"]`,
  ];

  const POLL_TIMEOUT = Math.max(_timeout ?? 5000, 3000);
  const POLL_INTERVAL = 200;
  const valueLower = value.toLowerCase().trim();

  let matchedOption: HTMLElement | null = null;
  const deadline = Date.now() + POLL_TIMEOUT;

  while (Date.now() < deadline) {
    // Search for the matching option across all known selector patterns
    for (const optSel of optionSelectors) {
      const options = document.querySelectorAll(optSel);
      for (const opt of Array.from(options)) {
        const text = (opt.textContent ?? '').trim();
        const dataValue = opt.getAttribute('data-value') ?? '';
        if (
          text.toLowerCase() === valueLower ||
          text.toLowerCase().includes(valueLower) ||
          dataValue.toLowerCase() === valueLower
        ) {
          matchedOption = opt as HTMLElement;
          break;
        }
      }
      if (matchedOption) break;
    }
    if (matchedOption) break;

    // Scroll the dropdown list container to trigger virtualized option loading.
    // Many custom dropdowns (React Select, MUI Autocomplete) render options lazily
    // as the user scrolls. Scroll down incrementally to reveal more options.
    const listContainerSelectors = ['[role="listbox"]', '[role="menu"]', '.dropdown-menu', '[class*="menu-list"]', '[class*="option-list"]'];
    for (const listSel of listContainerSelectors) {
      const listEl = document.querySelector(listSel);
      if (listEl && listEl instanceof HTMLElement && listEl.scrollHeight > listEl.clientHeight) {
        listEl.scrollTop += listEl.clientHeight; // Scroll down one viewport
        break;
      }
    }

    await delay(POLL_INTERVAL);
  }

  if (!matchedOption) {
    return { success: false, error: `No dropdown option matching "${value}" found within ${POLL_TIMEOUT}ms after opening dropdown (scrolled to load virtualized options)` };
  }

  // Step 3: Click the matched option
  matchedOption.scrollIntoView({ block: 'nearest' });
  matchedOption.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  matchedOption.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
  await delay(50);
  matchedOption.click();
  matchedOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  matchedOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));

  await waitForDOMIdle(200, 3000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Press key — dispatches a keyboard event on a focused element or document.
// Supports modifier+key format: "Ctrl+A", "Shift+Enter", "Meta+C", etc.
// ---------------------------------------------------------------------------
async function pressKey(selector: string | undefined, key: string, timeout = 10000): Promise<ActionResult> {
  let target: EventTarget = document.activeElement ?? document.body;

  if (selector) {
    try {
      const el = await waitForElement(selector, timeout);
      (el as HTMLElement).focus();
      target = el;
    } catch {
      // fall back to currently focused element
    }
  }

  // Parse modifier+key format: "Ctrl+A", "Shift+Enter", "Meta+C"
  const parts = key.split('+');
  const mainKey = parts.pop() ?? key;
  const modifiers = new Set(parts.map((m) => m.toLowerCase()));

  const keyInit: KeyboardEventInit = {
    key: mainKey,
    code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
    bubbles: true,
    cancelable: true,
    ctrlKey: modifiers.has('ctrl') || modifiers.has('control'),
    shiftKey: modifiers.has('shift'),
    altKey: modifiers.has('alt'),
    metaKey: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
  };

  (target as EventTarget).dispatchEvent(new KeyboardEvent('keydown', keyInit));
  if (mainKey.length === 1) {
    (target as EventTarget).dispatchEvent(new KeyboardEvent('keypress', keyInit));
  }
  (target as EventTarget).dispatchEvent(new KeyboardEvent('keyup', keyInit));

  await waitForDOMIdle(200, 2000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Wait — waits for element to appear in DOM.
// ---------------------------------------------------------------------------
async function waitFor(selector: string, timeout = 10000): Promise<ActionResult> {
  await waitForElement(selector, timeout);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Assert — comprehensive assertion engine with polling for async UI updates.
// SPAs render asynchronously after API calls, so assertions poll until the
// condition is met or the timeout expires.
// ---------------------------------------------------------------------------
const ASSERT_POLL_INTERVAL = 250;

async function assertState(step: ExecutionStep): Promise<ActionResult> {
  const { selector, assertType = 'visible', assertExpected, timeout = 5000, attribute } = step;
  const deadline = Date.now() + timeout;

  // URL assertion — no selector needed, polls for URL change
  if (assertType === 'url') {
    const expected = assertExpected ?? '';
    return pollUntil(deadline, () => {
      const current = window.location.href;
      if (current.includes(expected) || current === expected) return { success: true };
      return { success: false, error: `URL mismatch: expected to include "${expected}", got "${current}"` };
    });
  }

  // not_exists — poll until element disappears
  if (assertType === 'not_exists') {
    if (!selector) return { success: false, error: 'No selector provided for not_exists assertion' };
    try { document.querySelector(selector); } catch {
      return { success: false, error: `Invalid CSS selector: ${selector}` };
    }
    return pollUntil(deadline, () => {
      const el = document.querySelector(selector);
      if (el === null) return { success: true };
      const tag = (el as HTMLElement).tagName?.toLowerCase() ?? '?';
      const text = (el.textContent ?? '').trim().slice(0, 100);
      return { success: false, error: `Element still exists in DOM: ${selector} (<${tag}> "${text}") [${window.location.href}]` };
    });
  }

  // exists — poll until element appears
  if (assertType === 'exists') {
    if (!selector) return { success: false, error: 'No selector provided for exists assertion' };
    try { document.querySelector(selector); } catch {
      return { success: false, error: `Invalid CSS selector: ${selector}` };
    }
    return pollUntil(deadline, () => {
      const el = document.querySelector(selector);
      if (el !== null) return { success: true };
      return { success: false, error: `Element not found in DOM: ${selector} [${window.location.href}]` };
    });
  }

  if (!selector) {
    return { success: false, error: 'No selector provided for assertion' };
  }

  // For all other assertion types, wait for the element first, then poll the condition
  try {
    const remainingForElement = Math.max(1000, deadline - Date.now());
    const el = await waitForElement(selector, remainingForElement);

    // Wait for CSS transitions/animations to settle before checking the condition.
    // This prevents false negatives when elements are mid-animation (e.g. opacity 0→1).
    if (el instanceof HTMLElement && (assertType === 'visible' || assertType === 'not_visible')) {
      await waitForAnimationEnd(el, Math.min(1000, deadline - Date.now()));
    }

    return pollUntil(deadline, () => checkAssertCondition(el, selector, assertType, assertExpected, attribute));
  } catch (err) {
    // Element not found — for text assertions, also check toast/snackbar containers
    if (assertType === 'text' && assertExpected) {
      const toastResult = findTextInToasts(assertExpected);
      if (toastResult) return { success: true };
    }
    return {
      success: false,
      error: (err instanceof Error ? err.message : String(err)) + ` [${window.location.href}]`,
    };
  }
}

/** Check a single assertion condition (no waiting). */
function checkAssertCondition(
  el: Element,
  selector: string,
  assertType: string,
  assertExpected: string | undefined,
  attribute: string | undefined
): ActionResult {
  switch (assertType) {
    case 'visible': {
      const visible = isElementVisible(el);
      if (visible) return { success: true };
      const style = getComputedStyle(el);
      return {
        success: false,
        error: `Element not visible: ${selector} (display=${style.display}, visibility=${style.visibility}, opacity=${style.opacity}) [${window.location.href}]`,
      };
    }

    case 'not_visible': {
      const visible = isElementVisible(el);
      if (!visible) return { success: true };
      return { success: false, error: `Element is still visible: ${selector} [${window.location.href}]` };
    }

    case 'enabled': {
      const disabled = (el as HTMLButtonElement | HTMLInputElement).disabled;
      if (!disabled) return { success: true };
      return { success: false, error: `Element is disabled: ${selector} [${window.location.href}]` };
    }

    case 'disabled': {
      const disabled = (el as HTMLButtonElement | HTMLInputElement).disabled;
      if (disabled) return { success: true };
      return { success: false, error: `Element is not disabled: ${selector} [${window.location.href}]` };
    }

    case 'text': {
      const actual = el.textContent?.trim() ?? '';
      const expected = assertExpected ?? '';
      // Case-insensitive match
      if (actual.toLowerCase().includes(expected.toLowerCase())) return { success: true };
      // Also check toast/snackbar containers for transient feedback
      if (findTextInToasts(expected)) return { success: true };
      const truncated = actual.length > 200 ? actual.slice(0, 200) + '...' : actual;
      return {
        success: false,
        error: `Text mismatch: expected to contain "${expected}", got "${truncated}" [${window.location.href}]`,
      };
    }

    case 'not_text': {
      const actual = el.textContent?.trim() ?? '';
      const expected = assertExpected ?? '';
      // Case-insensitive match
      if (!actual.toLowerCase().includes(expected.toLowerCase())) return { success: true };
      return { success: false, error: `Text still present: "${expected}" found in element [${window.location.href}]` };
    }

    case 'value': {
      const actual = (el as HTMLInputElement | HTMLTextAreaElement).value ?? '';
      const expected = assertExpected ?? '';
      // Exact match first, then case-insensitive fallback
      if (actual === expected || actual.toLowerCase() === expected.toLowerCase()) return { success: true };
      return {
        success: false,
        error: `Value mismatch: expected "${expected}", got "${actual}" [${window.location.href}]`,
      };
    }

    case 'attribute': {
      if (!attribute) {
        return { success: false, error: 'No attribute name specified for attribute assertion' };
      }
      const actual = el.getAttribute(attribute) ?? '';
      const expected = assertExpected ?? '';
      if (actual.toLowerCase().includes(expected.toLowerCase())) return { success: true };
      return {
        success: false,
        error: `Attribute [${attribute}] mismatch: expected "${expected}", got "${actual}" [${window.location.href}]`,
      };
    }

    case 'count': {
      const count = document.querySelectorAll(selector).length;
      const expected = Number(assertExpected ?? 1);
      if (count >= expected) return { success: true };
      return { success: false, error: `Count assertion failed: expected at least ${expected}, got ${count} [${window.location.href}]` };
    }

    case 'exact_count': {
      const count = document.querySelectorAll(selector).length;
      const expected = Number(assertExpected ?? 1);
      if (count === expected) return { success: true };
      return { success: false, error: `Exact count mismatch: expected ${expected}, got ${count} [${window.location.href}]` };
    }

    default: {
      return { success: false, error: `Unknown assertType: "${assertType}"` };
    }
  }
}

/** Poll a condition until it passes or the deadline expires. */
/**
 * Wait for CSS transitions and animations to settle on an element.
 * Checks computed transition/animation-duration and waits that long,
 * or listens for transitionend/animationend events.
 */
async function waitForAnimationEnd(el: HTMLElement, maxWaitMs: number): Promise<void> {
  if (maxWaitMs <= 0) return;

  const style = getComputedStyle(el);

  // Parse CSS duration strings like "0.3s" or "300ms"
  function parseDuration(value: string): number {
    if (!value || value === '0s' || value === 'none') return 0;
    const parts = value.split(',').map((v) => v.trim());
    let maxMs = 0;
    for (const part of parts) {
      if (part.endsWith('ms')) maxMs = Math.max(maxMs, parseFloat(part));
      else if (part.endsWith('s')) maxMs = Math.max(maxMs, parseFloat(part) * 1000);
    }
    return maxMs;
  }

  const transitionMs = parseDuration(style.transitionDuration);
  const animationMs = parseDuration(style.animationDuration);
  const totalMs = Math.max(transitionMs, animationMs);

  if (totalMs === 0) return; // No animation — nothing to wait for

  // Wait for the animation/transition to finish, capped at maxWaitMs
  const waitMs = Math.min(totalMs + 50, maxWaitMs); // +50ms buffer for rendering
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, waitMs);
    const done = () => { clearTimeout(timer); resolve(); };
    el.addEventListener('transitionend', done, { once: true });
    el.addEventListener('animationend', done, { once: true });
  });
}

async function pollUntil(deadline: number, check: () => ActionResult): Promise<ActionResult> {
  // Fast path — check immediately
  const immediate = check();
  if (immediate.success) return immediate;

  // Poll until deadline
  let lastResult = immediate;
  while (Date.now() < deadline) {
    await delay(ASSERT_POLL_INTERVAL);
    lastResult = check();
    if (lastResult.success) return lastResult;
  }
  return lastResult;
}

// ---------------------------------------------------------------------------
// Toast / Snackbar detection — scans common toast containers for transient
// feedback messages that may appear briefly after form submissions.
// ---------------------------------------------------------------------------
const TOAST_SELECTORS = [
  '[role="alert"]',
  '[role="status"]',
  '.toast',
  '.Toastify__toast',
  '.MuiSnackbar-root',
  '.MuiAlert-root',
  '.ant-message',
  '.ant-notification',
  '.chakra-toast',
  '.chakra-alert',
  '.notification',
  '.snackbar',
  '[class*="toast"]',
  '[class*="snackbar"]',
];

function findTextInToasts(expected: string): boolean {
  const expectedLower = expected.toLowerCase();
  for (const sel of TOAST_SELECTORS) {
    try {
      const elements = document.querySelectorAll(sel);
      for (const el of Array.from(elements)) {
        const text = (el.textContent ?? '').trim().toLowerCase();
        if (text.includes(expectedLower)) return true;
      }
    } catch {
      // invalid selector — skip
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scroll
// ---------------------------------------------------------------------------
async function scrollTo(selector?: string, value?: string): Promise<ActionResult> {
  if (selector) {
    try {
      const el = document.querySelector(selector);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        return { success: false, error: `Element not found for scroll: ${selector}` };
      }
    } catch {
      window.scrollBy(0, 300);
    }
  } else if (value === 'top') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (value === 'bottom') {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  } else {
    window.scrollBy(0, 300);
  }
  await delay(300);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Double-click
// ---------------------------------------------------------------------------
async function doubleClickElement(selector: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const htmlEl = el as HTMLElement;

  htmlEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(ACTION_DELAY_MS);

  const rect = htmlEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const eventInit: MouseEventInit = {
    bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0, buttons: 1, detail: 2,
  };

  // Two full click sequences followed by the dblclick event
  for (let i = 0; i < 2; i++) {
    htmlEl.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerId: 1 }));
    htmlEl.dispatchEvent(new MouseEvent('mousedown', eventInit));
    htmlEl.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerId: 1 }));
    htmlEl.dispatchEvent(new MouseEvent('mouseup', eventInit));
    htmlEl.dispatchEvent(new MouseEvent('click', { ...eventInit, detail: i + 1 }));
  }
  htmlEl.dispatchEvent(new MouseEvent('dblclick', eventInit));

  await waitForDOMIdle(250, 3000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Check / Uncheck — checkbox and radio button with proper React event firing.
// Using click() alone works for simple checkboxes, but React controlled
// checkboxes need the native `checked` setter + a synthetic change event that
// carries the updated checked value in e.target.checked.
// ---------------------------------------------------------------------------
async function checkElement(selector: string, checked: boolean, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const input = el as HTMLInputElement;

  if (input.type !== 'checkbox' && input.type !== 'radio') {
    return { success: false, error: `check/uncheck expects a checkbox or radio, got type="${input.type}"` };
  }
  if (input.type === 'radio' && !checked) {
    return { success: false, error: 'Radio buttons cannot be unchecked directly — select a different radio in the group' };
  }

  // Already in the desired state — idempotent success
  if (input.checked === checked) return { success: true };

  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(ACTION_DELAY_MS);

  // Use native prototype setter so React registers the state change
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
  if (nativeSetter) {
    nativeSetter.call(input, checked);
  } else {
    input.checked = checked;
  }

  // Fire the event sequence that React/Vue onChange handlers expect
  input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await waitForDOMIdle(150, 2000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Drag and drop — supports both HTML5 DnD API and pointer-based DnD libraries
// (react-beautiful-dnd, dnd-kit, React DnD, etc.).
// ---------------------------------------------------------------------------
async function dragAndDrop(sourceSelector: string, targetSelector: string, timeout = 10000): Promise<ActionResult> {
  if (!targetSelector) {
    return { success: false, error: 'drag_drop requires targetSelector' };
  }

  const source = await waitForElement(sourceSelector, timeout) as HTMLElement;
  const target = await waitForElement(targetSelector, timeout) as HTMLElement;

  source.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(ACTION_DELAY_MS);

  const srcRect = source.getBoundingClientRect();
  const tgtRect = target.getBoundingClientRect();
  const srcX = srcRect.left + srcRect.width / 2;
  const srcY = srcRect.top + srcRect.height / 2;
  const tgtX = tgtRect.left + tgtRect.width / 2;
  const tgtY = tgtRect.top + tgtRect.height / 2;

  // Detect if the source element uses HTML5 draggable attribute
  const isHTML5Draggable = source.draggable || source.getAttribute('draggable') === 'true';

  if (isHTML5Draggable) {
    return html5DragAndDrop(source, target, srcX, srcY, tgtX, tgtY);
  }

  // Pointer-based DnD for libraries like react-beautiful-dnd, dnd-kit, React DnD
  return pointerDragAndDrop(source, target, srcX, srcY, tgtX, tgtY);
}

async function html5DragAndDrop(
  source: HTMLElement, target: HTMLElement,
  srcX: number, srcY: number, tgtX: number, tgtY: number
): Promise<ActionResult> {
  const dt = new DataTransfer();

  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: srcX, clientY: srcY, dataTransfer: dt }));
  await delay(50);

  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: tgtX, clientY: tgtY, dataTransfer: dt }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: tgtX, clientY: tgtY, dataTransfer: dt }));
  await delay(50);

  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: tgtX, clientY: tgtY, dataTransfer: dt }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, clientX: tgtX, clientY: tgtY, dataTransfer: dt }));

  await waitForDOMIdle(300, 3000);
  return { success: true };
}

async function pointerDragAndDrop(
  source: HTMLElement, target: HTMLElement,
  srcX: number, srcY: number, tgtX: number, tgtY: number
): Promise<ActionResult> {
  const commonInit = { bubbles: true, cancelable: true, button: 0, buttons: 1 };

  // Press down on source
  source.dispatchEvent(new PointerEvent('pointerdown', { ...commonInit, pointerId: 1, clientX: srcX, clientY: srcY }));
  source.dispatchEvent(new MouseEvent('mousedown', { ...commonInit, clientX: srcX, clientY: srcY }));
  await delay(100);

  // Move through intermediate points for smooth drag recognition
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    const mx = srcX + (tgtX - srcX) * ratio;
    const my = srcY + (tgtY - srcY) * ratio;
    source.dispatchEvent(new PointerEvent('pointermove', { ...commonInit, pointerId: 1, clientX: mx, clientY: my }));
    source.dispatchEvent(new MouseEvent('mousemove', { ...commonInit, clientX: mx, clientY: my }));
    await delay(30);
  }

  // Move onto target
  target.dispatchEvent(new PointerEvent('pointerenter', { ...commonInit, pointerId: 1, clientX: tgtX, clientY: tgtY, bubbles: false }));
  target.dispatchEvent(new PointerEvent('pointermove', { ...commonInit, pointerId: 1, clientX: tgtX, clientY: tgtY }));
  target.dispatchEvent(new MouseEvent('mousemove', { ...commonInit, clientX: tgtX, clientY: tgtY }));
  await delay(50);

  // Release on target
  target.dispatchEvent(new PointerEvent('pointerup', { ...commonInit, pointerId: 1, clientX: tgtX, clientY: tgtY }));
  target.dispatchEvent(new MouseEvent('mouseup', { ...commonInit, clientX: tgtX, clientY: tgtY }));

  await waitForDOMIdle(300, 3000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------
async function hoverElement(selector: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const htmlEl = el as HTMLElement;

  htmlEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await delay(ACTION_DELAY_MS);

  const rect = htmlEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const init: MouseEventInit = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };

  htmlEl.dispatchEvent(new PointerEvent('pointerover', { ...init, pointerId: 1 }));
  htmlEl.dispatchEvent(new PointerEvent('pointerenter', { ...init, pointerId: 1, bubbles: false }));
  htmlEl.dispatchEvent(new MouseEvent('mouseover', init));
  htmlEl.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }));
  htmlEl.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 1 }));
  htmlEl.dispatchEvent(new MouseEvent('mousemove', init));

  await waitForDOMIdle(200, 2000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Upload file — creates a synthetic File and dispatches it to input[type=file]
// ---------------------------------------------------------------------------
async function uploadFile(selector: string, fileName: string, timeout = 10000): Promise<ActionResult> {
  const el = await waitForElement(selector, timeout);
  const input = el as HTMLInputElement;

  if (input.type !== 'file') {
    return { success: false, error: `upload_file expects input[type="file"], got type="${input.type}"` };
  }

  // Create a synthetic file
  const content = `Test file content for ${fileName}`;
  const file = new File([content], fileName || 'test-upload.txt', {
    type: 'text/plain',
    lastModified: Date.now(),
  });

  // Use DataTransfer to set the file on the input
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;

  // Fire events that frameworks listen to
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  await waitForDOMIdle(200, 3000);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Dismiss dialog — handles window.alert/confirm/prompt by auto-accepting
// This works by overriding the native dialog functions on the page.
// The background service worker handles chrome.debugger-based dismissal.
// ---------------------------------------------------------------------------
async function dismissDialog(): Promise<ActionResult> {
  // Override native dialogs to auto-accept (content script approach)
  // This is a preemptive installation — call before actions that trigger dialogs
  (window as any).__pathfinder_orig_alert = (window as any).__pathfinder_orig_alert ?? window.alert;
  (window as any).__pathfinder_orig_confirm = (window as any).__pathfinder_orig_confirm ?? window.confirm;
  (window as any).__pathfinder_orig_prompt = (window as any).__pathfinder_orig_prompt ?? window.prompt;

  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => '';

  return { success: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isElementVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  const style = getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden') return false;
  if (style.opacity === '0') return false;
  if (style.pointerEvents === 'none') return false;

  // Check if element is in viewport
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;

  // Check for clip-path that completely hides the element
  const clipPath = style.clipPath ?? (style as CSSStyleDeclaration & { webkitClipPath?: string }).webkitClipPath;
  if (clipPath === 'polygon(0px 0px, 0px 0px, 0px 0px, 0px 0px)' || clipPath === 'inset(100%)') return false;

  return true;
}

/**
 * Set an input's value through the native prototype setter so that React's
 * synthetic event system registers the change correctly.
 */
function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;

  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(el, value);
  } else {
    (el as HTMLInputElement).value = value;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
