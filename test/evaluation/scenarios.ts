/**
 * The evaluation scenarios.
 *
 * Each one is a test as a user would plausibly write it, plus the oracles a
 * competent QA engineer would attach. It is driven **identically** against the
 * `correct/` and `broken/` variants; the only variable is the seeded defect.
 *
 * ## The rule that keeps the measurement honest
 *
 * A scenario is never told which variant it is running against. There is no
 * `variant` parameter in any check, no fixture id in any assertion, and no
 * branch anywhere below on the directory name. The harness knows, because it
 * chose the directory; the checks do not.
 *
 * That is what makes a false positive measurable. A check that fires on
 * `correct/` is wrong, full stop — and because the same code ran against both,
 * a detector cannot be tuned to pass the evaluation without actually being
 * right.
 *
 * ## Why the checks are written here rather than generated
 *
 * These are the *oracle* under evaluation, not the product's own generation. A
 * scenario states what a reasonable test would verify; whether Pathfinder's
 * execution, healing and verdict logic then reaches the right conclusion is the
 * thing being measured. Generating the checks from the same model being
 * evaluated would measure nothing.
 */
import type { JsdomDriver } from './jsdom-driver';
import { fromCss, fromTestId, type Locator } from '../../src/core/locator';

/** What a scenario concluded about the application. */
export interface ScenarioOutcome {
  /** True when the scenario decided the application misbehaved. */
  defectFound: boolean;
  /** What it observed, for the report. Always populated. */
  detail: string;
  /**
   * True when the scenario could not reach a conclusion — a page that never
   * loaded, a selector the tier cannot resolve. Neither a detection nor a
   * false positive; counted separately so it cannot flatter either number.
   */
  inconclusive?: boolean;
  /**
   * Set by a `healing` scenario when the locator ladder had to fall below its
   * preferred tier to reach the control. This is what such a scenario measures.
   */
  healedToTier?: 'testid' | 'semantic' | 'structural';
}

export interface Scenario {
  id: string;
  /**
   * What the scenario is measuring.
   *
   * `defect-detection` scenarios have a real application defect in the broken
   * variant and belong in the detection denominator. `healing` scenarios do
   * not: a renamed selector that the locator ladder recovers from is a
   * *testability* regression, and the test still passed — counting it as a
   * missed defect would understate detection, while counting a flag as a
   * detection would reward crying wolf. It is scored on its own terms instead.
   */
  measures: 'defect-detection' | 'healing';
  /** What kind of defect this probes, for grouping in the report. */
  kind:
    | 'save-persistence'
    | 'backend-failure'
    | 'input-validation'
    | 'delayed-render'
    | 'changed-selector'
    | 'spa-modal'
    | 'session-interruption'
    | 'multipage-journey'
    | 'css-hidden-confirmation';
  /** The page (or first page) this scenario drives. */
  page: string;
  /** How a fetch should answer, when the scenario needs a specific response. */
  respondTo?: (url: string, method: string) => { status: number; body?: unknown };
  /**
   * Repeat count for scenarios whose outcome could plausibly vary.
   *
   * The plan requires at least five repeats on the timing and healing
   * scenarios, to expose basic instability. It does not prove flake freedom and
   * is not reported as if it does.
   */
  repeats?: number;
  /**
   * Set when the scenario can only be judged on one tier.
   *
   * A blind spot is a reason to EXCLUDE a scenario from a tier, not to run it
   * there and score the inevitable failure as a missed defect. The report says
   * how many were excluded.
   */
  requiresTier?: 'real-browser';
  run: (driver: JsdomDriver) => Promise<ScenarioOutcome>;
}

/** Locator for a control, preferring testid and falling through as the app does. */
function control(testid: string, role: 'button' | 'link', name: string, css: string): Locator {
  return {
    testid,
    semantic: { role, name },
    structural: { css },
    preferredTier: 'testid',
  };
}

/** Did an element end up visible? Absence and invisibility are the same answer. */
async function isShown(driver: JsdomDriver, locator: Locator): Promise<boolean> {
  const handle = await driver.resolve(locator);
  if (!handle) return false;
  return (await driver.sample(handle)).visible;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'save-persists',
    measures: 'defect-detection',
    kind: 'save-persistence',
    page: 'save.html',
    async run(driver) {
      await driver.navigate('save.html');
      await driver.type(fromTestId('display-name'), 'Ada Lovelace');
      await driver.click(fromTestId('save-settings'));

      const bannerShown = await isShown(driver, fromCss('#save-banner'));
      const persisted = driver.storedValue('local', 'fixture.displayName');

      // The oracle that matters: the UI claiming success is not evidence the
      // write happened. A test asserting only the banner passes on both
      // variants, which is exactly why this scenario exists.
      if (bannerShown && persisted !== 'Ada Lovelace') {
        return {
          defectFound: true,
          detail: `Banner said saved, but storage holds ${JSON.stringify(persisted)}`,
        };
      }
      if (!bannerShown) {
        return { defectFound: true, detail: 'No confirmation appeared after saving' };
      }
      return { defectFound: false, detail: 'Saved and persisted' };
    },
  },

  {
    id: 'backend-failure-surfaced',
    measures: 'defect-detection',
    kind: 'backend-failure',
    page: 'api.html',
    // The backend fails in BOTH variants. What differs is whether the app says so.
    respondTo: () => ({ status: 500, body: { error: 'boom' } }),
    async run(driver) {
      await driver.navigate('api.html');
      await driver.click(fromTestId('create-order'));

      const requests = driver.recordedRequests();
      const failed = requests.some((r) => r.status >= 500);
      const status = await driver.readText(fromCss('#order-status')).catch(() => '');
      const claimsSuccess = /saved/i.test(status);

      if (failed && claimsSuccess) {
        return { defectFound: true, detail: `Request returned 500, UI showed "${status}"` };
      }
      if (!requests.length) {
        return { defectFound: false, detail: 'No request was made', inconclusive: true };
      }
      return { defectFound: false, detail: `Failure surfaced as "${status}"` };
    },
  },

  {
    id: 'invalid-input-rejected',
    measures: 'defect-detection',
    kind: 'input-validation',
    page: 'validate.html',
    async run(driver) {
      await driver.navigate('validate.html');
      await driver.type(fromTestId('email'), 'not-an-email');
      await driver.click(fromTestId('submit-signup'));

      const errorShown = await isShown(driver, fromCss('#email-error'));
      const accepted = await isShown(driver, fromCss('#signup-done'));

      if (accepted) {
        return { defectFound: true, detail: 'An invalid email was accepted' };
      }
      if (!errorShown) {
        return { defectFound: true, detail: 'Invalid email was neither accepted nor rejected' };
      }
      return { defectFound: false, detail: 'Invalid email rejected with a message' };
    },
  },

  {
    id: 'delayed-content-arrives',
    measures: 'defect-detection',
    kind: 'delayed-render',
    page: 'delayed.html',
    // Timing-sensitive: repeated to expose instability, per the plan.
    repeats: 5,
    async run(driver) {
      await driver.navigate('delayed.html');
      await driver.click(fromTestId('load-report'));

      try {
        // The correct variant reveals this after 250ms, so a real wait is
        // required — and a scenario that polled once would call it a defect.
        const text = await driver.readText(fromCss('#report-body'), {
          checks: ['visible'],
          timeoutMs: 1500,
        });
        return { defectFound: false, detail: `Content arrived: "${text}"` };
      } catch {
        return { defectFound: true, detail: 'Content never arrived within 1500ms' };
      }
    },
  },

  {
    id: 'renamed-control-still-reached',
    measures: 'healing',
    kind: 'changed-selector',
    page: 'selector.html',
    // Healing is the thing under test here; repeated for the same reason.
    repeats: 5,
    async run(driver) {
      await driver.navigate('selector.html');
      const locator = control('submit-order', 'button', 'Place order', '#submit-order');

      const handle = await driver.resolve(locator);
      if (!handle) {
        return { defectFound: true, detail: 'The control could not be found by any tier' };
      }

      await driver.click(locator);
      const placed = await isShown(driver, fromCss('#order-placed'));
      if (!placed) {
        return { defectFound: true, detail: 'Clicking the control did nothing' };
      }

      // A rename is a testability regression, not an application defect: the
      // test still passed, and saying otherwise would be a false positive.
      // Reported through `detail` so the report can show that healing was
      // needed without counting it as a bug.
      return {
        defectFound: false,
        healedToTier: handle.healed ? handle.tier : undefined,
        detail: handle.healed
          ? `Order placed, but the locator fell to the ${handle.tier} tier`
          : 'Order placed at the preferred tier',
      };
    },
  },

  {
    id: 'modal-form-usable',
    measures: 'defect-detection',
    kind: 'spa-modal',
    page: 'modal.html',
    async run(driver) {
      await driver.navigate('modal.html');
      await driver.click(fromTestId('invite-member'));

      const dialogShown = await isShown(driver, fromCss('#invite-modal'));
      if (!dialogShown) {
        return { defectFound: true, detail: 'The dialog did not open' };
      }

      // The dialog opening is not the same as the dialog being usable. A test
      // asserting only that it appeared passes on both variants.
      const field = await driver.resolve(fromTestId('invite-email'));
      if (!field) {
        return { defectFound: true, detail: 'The dialog opened with no form to fill in' };
      }

      await driver.type(fromTestId('invite-email'), 'ada@example.com');
      return { defectFound: false, detail: 'Dialog opened and its form accepted input' };
    },
  },

  {
    id: 'expired-session-reported',
    measures: 'defect-detection',
    kind: 'session-interruption',
    page: 'session.html',
    repeats: 5,
    async run(driver) {
      await driver.navigate('session.html');
      await driver.type(fromTestId('bio'), 'Mathematician');
      // The session drops after 150ms in both variants; wait past it so the
      // save happens on an expired session.
      await new Promise((resolve) => setTimeout(resolve, 220));
      await driver.click(fromTestId('save-profile'));

      const saved = await isShown(driver, fromCss('#profile-saved'));
      const expired = await isShown(driver, fromCss('#session-expired'));

      if (saved && !expired) {
        return { defectFound: true, detail: 'Claimed the profile saved on an expired session' };
      }
      if (!saved && !expired) {
        return { defectFound: false, detail: 'Neither outcome shown', inconclusive: true };
      }
      return { defectFound: false, detail: 'The expired session was reported' };
    },
  },

  {
    id: 'css-hidden-confirmation',
    measures: 'defect-detection',
    kind: 'css-hidden-confirmation',
    page: 'css-hidden.html',
    // Only judgeable with real layout. The confirmation is in the DOM, carries
    // no `hidden` attribute and no inline style — a stylesheet rule collapses
    // it. A DOM engine without layout reads it as visible and would report this
    // working application as broken, so the deterministic tier EXCLUDES the
    // scenario rather than manufacturing a false positive from a blind spot.
    requiresTier: 'real-browser',
    async run(driver) {
      await driver.navigate('css-hidden.html');
      await driver.click(fromTestId('publish'));

      const shown = await isShown(driver, fromCss('#publish-banner'));
      if (!shown) {
        return { defectFound: true, detail: 'The confirmation never became visible' };
      }
      return { defectFound: false, detail: 'The confirmation was shown' };
    },
  },

  {
    id: 'journey-carries-value',
    measures: 'defect-detection',
    kind: 'multipage-journey',
    page: 'journey-1.html',
    async run(driver) {
      await driver.navigate('journey-1.html');
      await driver.type(fromTestId('order-ref'), 'REF-4417');
      await driver.click(fromTestId('to-step-2'));

      await driver.navigate('journey-2.html');
      const carried = await driver.readText(fromTestId('carried-ref'));

      if (carried !== 'REF-4417') {
        return {
          defectFound: true,
          detail: `Step 2 showed ${JSON.stringify(carried)} instead of the reference entered`,
        };
      }

      await driver.click(fromTestId('confirm-order'));
      const done = await isShown(driver, fromCss('#journey-done'));
      if (!done) {
        return { defectFound: true, detail: 'Confirming the order did nothing' };
      }
      return { defectFound: false, detail: 'The reference survived both steps' };
    },
  },
];
