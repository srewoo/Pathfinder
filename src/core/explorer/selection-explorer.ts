/**
 * Bulk-action discovery: what appears once you select something.
 *
 * Exploration filtered every `input` out of its click set, so checkboxes were
 * never touched — and on a list page that removed a whole class of functionality
 * from the map. Selecting rows is what reveals the bulk-action toolbar (Export,
 * Move, Share, Delete), and those are usually the highest-consequence controls on
 * the page. No amount of reading the initial DOM finds them, because they do not
 * exist until something is checked.
 *
 * Two rules make this safe to run:
 *   - Revealed actions are RECORDED, never clicked. Discovering "Delete selected"
 *     is valuable; pressing it is not our decision to make.
 *   - Every toggle is returned to its prior state, and whether the reset actually
 *     worked is reported rather than assumed. Rows left selected change what every
 *     later step on the page does.
 */
import type { InteractiveElement, PageAction, SelectionDiscovery } from '../../storage/schemas';
import { selectToggleTargets, type ToggleTargetOptions } from './page-scanner';
import { createLogger } from '../../utils/logger';

const log = createLogger('selection-explorer');

export interface SelectionProbeDeps {
  /** Click a selector. Rejects if the element is gone or the click fails. */
  click(selector: string, description: string): Promise<void>;
  /** Actions currently available on the page. */
  scanActions(): Promise<PageAction[]>;
  /** Wait for the UI to settle after a click. */
  settle(): Promise<void>;
}

/** Identity of an action for before/after comparison. */
function actionKey(a: PageAction): string {
  return `${a.selector}|${a.label}`;
}

function labelFor(el: InteractiveElement): string {
  const raw = (el.ariaLabel || el.text || el.name || '').trim();
  return raw || el.selector;
}

/**
 * Toggle selection controls one at a time and record what each one reveals.
 *
 * Returns only toggles that revealed something — a checkbox that changes nothing
 * visible is not a discovery worth storing, and storing every one would bury the
 * pages where selection genuinely unlocks a toolbar.
 */
export async function probeSelectionActions(
  elements: InteractiveElement[],
  visited: Set<string>,
  deps: SelectionProbeDeps,
  options: ToggleTargetOptions = {}
): Promise<SelectionDiscovery[]> {
  const targets = selectToggleTargets(elements, visited, options);
  if (targets.length === 0) return [];

  const discoveries: SelectionDiscovery[] = [];

  for (const toggle of targets) {
    visited.add(toggle.selector);
    const label = labelFor(toggle);

    let before: PageAction[];
    try {
      before = await deps.scanActions();
    } catch (err) {
      log.debug(`Selection probe skipped for ${toggle.selector} — baseline scan failed`, err);
      continue;
    }
    const beforeKeys = new Set(before.map(actionKey));

    try {
      await deps.click(toggle.selector, `Explore: select via ${label}`);
    } catch (err) {
      // A toggle that cannot be clicked is not a failure of the run — virtualized
      // rows go away. Nothing was changed, so nothing needs resetting.
      log.debug(`Selection toggle unavailable: ${toggle.selector}`, err);
      continue;
    }
    await deps.settle();

    const after = await deps.scanActions().catch(() => [] as PageAction[]);
    const revealedActions = after.filter((a) => !beforeKeys.has(actionKey(a)));

    // Reset FIRST, before deciding whether to record. Leaving the page selected
    // would corrupt every later step on it, and that matters whether or not this
    // particular toggle turned out to be interesting.
    let resetOk = false;
    try {
      await deps.click(toggle.selector, `Explore: deselect via ${label}`);
      await deps.settle();
      // Verified by the toolbar going away rather than by reading the checkbox —
      // a proxy, but a behavioural one. If the revealed actions are gone, the
      // selection they depended on is gone too.
      const post = await deps.scanActions().catch(() => [] as PageAction[]);
      const postKeys = new Set(post.map(actionKey));
      resetOk =
        revealedActions.length === 0 || !revealedActions.some((a) => postKeys.has(actionKey(a)));
    } catch (err) {
      resetOk = false;
      log.warn(
        `Could not deselect "${label}" (${toggle.selector}) — the page may be left ` +
          `with a selection active, which affects later steps on it.`,
        err
      );
    }

    if (revealedActions.length === 0) continue;

    log.info(
      `Selection via "${label}" revealed ${revealedActions.length} action(s): ` +
        `${revealedActions.map((a) => a.label || a.selector).slice(0, 6).join(', ')}` +
        `${resetOk ? '' : ' (RESET FAILED)'}`
    );

    discoveries.push({
      triggerSelector: toggle.selector,
      triggerLabel: label,
      revealedActions,
      resetOk,
    });
  }

  return discoveries;
}
