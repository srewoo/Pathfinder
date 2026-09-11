/**
 * T13: a plan must not type into a field that is not in the DOM yet.
 *
 * The fixture is the page this was measured on. "Sign in with your username" is
 * a plain `<button type="button">`; clicking it swaps username/password into the
 * page with no URL change and no dialog. A generated test for it had step 1
 * *Grounded* and steps 2–3 *Inferred* — the model invented a username field
 * exploration had never recorded, and the resulting run-time failure was
 * indistinguishable from the application being broken.
 */
import { describe, it, expect } from 'vitest';
import {
  revealPrerequisites,
  missingPrerequisites,
  prerequisiteStep,
} from '../../../src/core/test-gen/reveal-prerequisites';
import type { ExecutionStep, FormField, PageNode } from '../../../src/storage/schemas';

function field(selector: string, name = 'username'): FormField {
  return { selector, name, type: 'text', label: name, required: true } as FormField;
}

/** The login page as exploration now records it. */
function loginPage(over: Partial<PageNode> = {}): PageNode {
  return {
    url: 'https://app.test/login',
    title: 'Sign in',
    elementCount: 8,
    revealedForms: [
      {
        triggerSelector: 'button[type="button"]',
        triggerLabel: 'Sign in with your username',
        formFields: [field('input[name="username"]'), field('input[name="password"]', 'password')],
      },
    ],
    ...over,
  } as PageNode;
}

const step = (order: number, action: ExecutionStep['action'], selector?: string, value?: string): ExecutionStep => ({
  order,
  action,
  selector,
  value,
  description: `${action} ${selector ?? value ?? ''}`,
});

describe('revealPrerequisites', () => {
  it('given_a_revealed_form_then_each_field_is_gated_on_the_trigger', () => {
    const prereqs = revealPrerequisites(loginPage());

    expect([...prereqs.keys()].sort()).toEqual(['input[name="password"]', 'input[name="username"]']);
    expect(prereqs.get('input[name="username"]')).toMatchObject({
      kind: 'click-trigger',
      triggerSelector: 'button[type="button"]',
      triggerLabel: 'Sign in with your username',
    });
  });

  // A field reachable without the click must not be gated, or a perfectly good
  // plan gets rejected.
  it('given_a_field_that_is_also_in_the_page_form_then_it_is_not_gated', () => {
    const prereqs = revealPrerequisites(
      loginPage({ formFields: [field('input[name="username"]')] })
    );

    expect(prereqs.has('input[name="username"]')).toBe(false);
    expect(prereqs.has('input[name="password"]')).toBe(true);
  });

  it('given_a_modal_form_then_its_fields_are_gated_on_the_modal_trigger', () => {
    const prereqs = revealPrerequisites({
      url: 'https://app.test/orders',
      title: 'Orders',
      elementCount: 4,
      modals: [
        { triggerSelector: '#new-order', triggerLabel: 'New order', formFields: [field('#qty', 'qty')] },
      ],
    } as PageNode);

    expect(prereqs.get('#qty')).toMatchObject({ kind: 'click-trigger', triggerSelector: '#new-order' });
  });

  it('given_a_tab_form_then_its_fields_are_gated_on_opening_the_tab', () => {
    const prereqs = revealPrerequisites({
      url: 'https://app.test/settings',
      title: 'Settings',
      elementCount: 4,
      tabs: [
        {
          label: 'Profile',
          url: 'https://app.test/settings?tab=profile',
          formFields: [field('#display-name', 'displayName')],
        },
      ],
    } as PageNode);

    expect(prereqs.get('#display-name')).toMatchObject({
      kind: 'open-tab',
      tabUrl: 'https://app.test/settings?tab=profile',
      triggerLabel: 'Profile',
    });
  });

  it.each([
    ['an unexplored page', undefined],
    ['a page with nothing gated', { url: 'u', title: 't', elementCount: 1 } as PageNode],
  ])('given_%s_then_nothing_is_gated', (_name, node) => {
    expect(revealPrerequisites(node).size).toBe(0);
  });
});

describe('missingPrerequisites', () => {
  const prereqs = revealPrerequisites(loginPage());

  // The exact plan the live generation produced.
  it('given_a_plan_that_types_without_clicking_the_trigger_then_it_is_rejected', () => {
    const missing = missingPrerequisites(
      [
        step(1, 'navigate', undefined, 'https://app.test/login'),
        step(2, 'type', 'input[name="username"]'),
        step(3, 'click', '#sign-in'),
      ],
      prereqs
    );

    expect(missing).toHaveLength(1);
    expect(missing[0].stepOrder).toBe(2);
  });

  // The message has to name the step to add, or it is not actionable.
  it('given_a_missing_prerequisite_then_the_message_names_the_step_to_add', () => {
    const missing = missingPrerequisites([step(2, 'type', 'input[name="username"]')], prereqs);

    expect(missing[0].message).toContain('Sign in with your username');
    expect(missing[0].message).toContain('button[type="button"]');
    expect(missing[0].message).toMatch(/before it/i);
  });

  it('given_a_plan_that_clicks_the_trigger_first_then_it_is_accepted', () => {
    const missing = missingPrerequisites(
      [
        step(1, 'navigate', undefined, 'https://app.test/login'),
        step(2, 'click', 'button[type="button"]'),
        step(3, 'type', 'input[name="username"]'),
        step(4, 'type', 'input[name="password"]'),
      ],
      prereqs
    );

    expect(missing).toEqual([]);
  });

  // Presence is not enough. Clicking the trigger after typing is still a plan
  // that types into nothing.
  it('given_the_trigger_clicked_after_the_field_then_it_is_still_rejected', () => {
    const missing = missingPrerequisites(
      [step(1, 'type', 'input[name="username"]'), step(2, 'click', 'button[type="button"]')],
      prereqs
    );

    expect(missing).toHaveLength(1);
    expect(missing[0].stepOrder).toBe(1);
  });

  it('given_steps_out_of_array_order_then_the_step_order_field_decides', () => {
    const missing = missingPrerequisites(
      [step(3, 'type', 'input[name="username"]'), step(2, 'click', 'button[type="button"]')],
      prereqs
    );

    expect(missing).toEqual([]);
  });

  it('given_every_gated_field_used_then_each_is_reported_once', () => {
    const missing = missingPrerequisites(
      [step(1, 'type', 'input[name="username"]'), step(2, 'type', 'input[name="password"]')],
      prereqs
    );

    expect(missing.map((m) => m.selector)).toEqual([
      'input[name="username"]',
      'input[name="password"]',
    ]);
  });

  // Clicking the trigger is not itself gated by the trigger.
  it('given_a_step_that_clicks_the_trigger_then_it_is_not_reported', () => {
    expect(missingPrerequisites([step(1, 'click', 'button[type="button"]')], prereqs)).toEqual([]);
  });

  it('given_a_step_that_touches_no_gated_selector_then_nothing_is_reported', () => {
    expect(missingPrerequisites([step(1, 'click', '#something-else')], prereqs)).toEqual([]);
  });

  it('given_no_prerequisites_then_any_plan_is_accepted', () => {
    expect(missingPrerequisites([step(1, 'type', 'input[name="username"]')], new Map())).toEqual([]);
  });

  it('given_a_tab_gated_field_then_navigating_to_the_tab_first_satisfies_it', () => {
    const tabPrereqs = revealPrerequisites({
      url: 'https://app.test/settings',
      title: 'Settings',
      elementCount: 4,
      tabs: [
        { label: 'Profile', url: 'https://app.test/settings?tab=profile', formFields: [field('#display-name')] },
      ],
    } as PageNode);

    expect(
      missingPrerequisites(
        [
          step(1, 'navigate', undefined, 'https://app.test/settings?tab=profile'),
          step(2, 'type', '#display-name'),
        ],
        tabPrereqs
      )
    ).toEqual([]);

    expect(missingPrerequisites([step(1, 'type', '#display-name')], tabPrereqs)).toHaveLength(1);
  });
});

describe('prerequisiteStep', () => {
  it('given_a_click_trigger_prerequisite_then_it_produces_the_click_step', () => {
    const [missing] = missingPrerequisites(
      [step(2, 'type', 'input[name="username"]')],
      revealPrerequisites(loginPage())
    );

    expect(prerequisiteStep(missing, 1)).toMatchObject({
      order: 1,
      action: 'click',
      selector: 'button[type="button"]',
    });
    expect(prerequisiteStep(missing, 1)?.description).toContain('Sign in with your username');
  });

  it('given_a_tab_prerequisite_then_it_produces_the_navigate_step', () => {
    const [missing] = missingPrerequisites(
      [step(2, 'type', '#display-name')],
      revealPrerequisites({
        url: 'u',
        title: 't',
        elementCount: 1,
        tabs: [{ label: 'Profile', url: 'https://app.test/s?tab=profile', formFields: [field('#display-name')] }],
      } as PageNode)
    );

    expect(prerequisiteStep(missing, 1)).toMatchObject({
      order: 1,
      action: 'navigate',
      value: 'https://app.test/s?tab=profile',
    });
  });
});

describe('grounding summary', () => {
  it('given_mixed_confidences_then_grounded_and_doc_asserted_both_count', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');
    const s = summarizeGrounding(['grounded', 'inferred', 'doc_asserted']);

    expect(s).toMatchObject({ grounded: 1, docAsserted: 1, inferred: 1, total: 3, allInferred: false });
    expect(s.label).toBe('2 of 3 steps grounded');
  });

  // The case the live login test hit: nothing was backed by capture.
  it('given_every_step_inferred_then_allInferred_is_true', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');
    expect(summarizeGrounding(['inferred', 'inferred']).allInferred).toBe(true);
  });

  // Absent confidence is "not assessed". Treating it as all-inferred would flag
  // every test authored before this was recorded.
  it.each([
    ['undefined', undefined],
    ['an empty array', [] as never],
  ])('given_%s_then_it_is_not_reported_as_all_inferred', async (_n, input) => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');
    const s = summarizeGrounding(input);
    expect(s.allInferred).toBe(false);
    expect(s.label).toMatch(/not recorded/i);
  });

  // A doc-asserted step's expectation came from documentation, but its target
  // still was not captured — so the "no step targets a recorded element" warning
  // is accurate for it. Named to match, because the previous name claimed the
  // opposite of what it asserted.
  it('given_only_doc_asserted_steps_then_it_still_counts_as_ungrounded', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');
    const s = summarizeGrounding(['doc_asserted']);
    expect(s.allInferred).toBe(true);
    expect(s.docAsserted).toBe(1);
    expect(s.grounded).toBe(0);
  });
});

describe('a failure on an inferred selector is labelled', () => {
  function failedResult(groundedAtAuthoring?: boolean) {
    return {
      id: 'r',
      testCaseId: 'tc',
      testCaseTitle: 'Sign in with username',
      status: 'failed' as const,
      startedAt: '2026-09-11T00:00:00.000Z',
      duration: 100,
      steps: [
        {
          step: { order: 1, action: 'type' as const, selector: 'input[name="username"]', description: 'Enter username' },
          status: 'failed' as const,
          duration: 10,
          error: 'Element input[name="username"] not found',
          groundedAtAuthoring,
        },
      ],
      healingAttempts: [],
      runId: 'run',
    };
  }

  it('given_a_failure_on_an_inferred_selector_then_the_reason_says_the_test_is_the_likely_cause', async () => {
    const { verdictWithReason } = await import('../../../src/core/report/result-adapter');
    const { reason, verdict } = verdictWithReason(failedResult(false));

    expect(verdict).toBe('FAIL');
    // The underlying error survives — the note is additive.
    expect(reason).toContain('not found');
    expect(reason).toMatch(/never recorded/i);
    expect(reason).toMatch(/regenerate/i);
  });

  it('given_a_failure_on_a_grounded_selector_then_no_such_note_is_added', async () => {
    const { verdictWithReason } = await import('../../../src/core/report/result-adapter');
    expect(verdictWithReason(failedResult(true)).reason).not.toMatch(/never recorded/i);
  });

  // A record from before grounding was tracked must read as a normal failure,
  // not be excused as a generation gap.
  it('given_an_unknown_grounding_then_no_note_is_added', async () => {
    const { verdictWithReason } = await import('../../../src/core/report/result-adapter');
    expect(verdictWithReason(failedResult(undefined)).reason).not.toMatch(/never recorded/i);
  });

  it('given_the_note_then_it_reaches_the_export_reason', async () => {
    const { toExportRun } = await import('../../../src/core/report/result-adapter');
    const exported = toExportRun([failedResult(false)]);
    expect(exported.results[0].verdictReason).toMatch(/never recorded/i);
  });
});

/**
 * T07 item 3: documentation support is its own dimension.
 *
 * "Can this test find the control" and "does anyone claim the control should do
 * this" are different questions, and a test that is perfectly grounded in
 * captured selectors while asserting an undocumented outcome is exactly the
 * test that passes when the feature is wrong.
 */
describe('documentation support is reported separately from element grounding', () => {
  it('given_no_doc_asserted_step_then_documentation_support_is_absent', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');

    expect(summarizeGrounding(['grounded', 'grounded']).noDocumentationSupport).toBe(true);
  });

  it('given_a_doc_asserted_step_then_documentation_support_is_present', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');

    expect(summarizeGrounding(['grounded', 'doc_asserted']).noDocumentationSupport).toBe(false);
  });

  // A fully grounded test with no documentation is the case worth naming: the
  // element warning stays silent, so without this the gap is invisible.
  it('given_a_fully_grounded_undocumented_test_then_only_the_documentation_gap_is_reported', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');
    const s = summarizeGrounding(['grounded', 'grounded']);

    expect(s.allInferred).toBe(false);
    expect(s.noDocumentationSupport).toBe(true);
  });

  it('given_no_recorded_confidence_then_no_documentation_claim_is_made', async () => {
    const { summarizeGrounding } = await import('../../../src/core/test-gen/step-confidence');

    expect(summarizeGrounding(undefined).noDocumentationSupport).toBe(false);
  });
});
