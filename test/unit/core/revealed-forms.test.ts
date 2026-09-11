import { describe, it, expect } from 'vitest';
import { enumerateSkeletons } from '../../../src/core/flow/skeleton-enumerator';
import {
  serializeGraphForFlowLearning,
  extractFormFieldsStructured,
} from '../../../src/core/explorer/interaction-graph';
import type { FormField, InteractionGraph, PageNode } from '../../../src/storage/schemas';

/**
 * Fixture measured on a live login page: "Sign in with your username" is a
 * plain `<button type="button">`; clicking it swaps username/password/persistMe
 * into the page with no URL change and no dialog. Before this capture existed
 * the fields were discarded, and generation invented a "username input field"
 * it had never observed.
 */
function field(over: Partial<FormField> = {}): FormField {
  return {
    selector: 'input[name="username"]',
    name: 'username',
    type: 'text',
    label: 'Username',
    placeholder: 'Enter username (your company email)',
    required: true,
    ...over,
  } as FormField;
}

function loginNode(): PageNode {
  return {
    url: 'https://app.test/login',
    title: 'Sign in',
    elementCount: 8,
    revealedForms: [
      {
        triggerSelector: 'button[type="button"]',
        triggerLabel: 'Sign in with your username',
        formFields: [
          field(),
          field({ selector: 'input[name="password"]', name: 'password', type: 'password', label: 'Password' }),
          field({
            selector: 'input[name="persistMe"]',
            name: 'persistMe',
            type: 'checkbox',
            label: 'Remember me',
            required: false,
          }),
        ],
      },
    ],
  } as PageNode;
}

function graphOf(node: PageNode): InteractionGraph {
  return { nodes: [node], edges: [], createdAt: '', updatedAt: '' } as InteractionGraph;
}

describe('revealed-form skeleton flows', () => {
  it('given_a_revealed_form_then_a_flow_is_enumerated_for_it', () => {
    const flows = enumerateSkeletons(graphOf(loginNode()));
    const flow = flows.find((f) => f.name.includes('Sign in with your username'));
    expect(flow).toBeDefined();
  });

  // The whole point: typing into a field that is not in the DOM yet fails.
  it('given_a_revealed_form_flow_then_the_trigger_click_precedes_every_fill', () => {
    const flows = enumerateSkeletons(graphOf(loginNode()));
    const flow = flows.find((f) => f.name.includes('Sign in with your username'));
    const click = flow?.steps.find((s) => s.action === 'click');
    const firstFill = flow?.steps.find((s) => s.selector?.includes('username') && s.action !== 'click');

    expect(click?.selector).toBe('button[type="button"]');
    expect(click?.order).toBe(2);
    expect(firstFill).toBeDefined();
    expect(firstFill!.order).toBeGreaterThan(click!.order);
  });

  it('given_a_revealed_form_flow_then_it_starts_by_navigating_to_the_page', () => {
    const flows = enumerateSkeletons(graphOf(loginNode()));
    const flow = flows.find((f) => f.name.includes('Sign in with your username'));
    expect(flow?.steps[0]).toMatchObject({ order: 1, action: 'navigate', value: 'https://app.test/login' });
  });

  it('given_required_and_optional_fields_then_the_required_ones_are_filled_first', () => {
    const flows = enumerateSkeletons(graphOf(loginNode()));
    const flow = flows.find((f) => f.name.includes('Sign in with your username'));
    const fills = flow!.steps.filter((s) => s.order > 2).map((s) => s.selector);
    expect(fills.slice(0, 2)).toEqual(['input[name="username"]', 'input[name="password"]']);
  });

  it('given_no_revealed_forms_then_no_such_flow_is_produced', () => {
    const node = { ...loginNode(), revealedForms: undefined } as PageNode;
    const flows = enumerateSkeletons(graphOf(node));
    expect(flows.some((f) => f.name.startsWith('Reveal and fill'))).toBe(false);
  });

  it('given_a_reveal_with_no_fields_then_no_flow_is_produced_for_it', () => {
    const node = {
      ...loginNode(),
      revealedForms: [{ triggerSelector: '#x', triggerLabel: 'Empty', formFields: [] }],
    } as PageNode;
    const flows = enumerateSkeletons(graphOf(node));
    const flow = flows.find((f) => f.name.includes('Empty'));
    // A trigger with nothing behind it still yields navigate + click, and never
    // a fill step for a field that does not exist.
    expect(flow?.steps.every((s) => s.action === 'navigate' || s.action === 'click')).toBe(true);
  });
});

describe('revealed forms in AI grounding', () => {
  it('given_a_revealed_form_then_the_prompt_states_the_trigger_must_be_clicked_first', () => {
    const text = serializeGraphForFlowLearning(graphOf(loginNode()));
    expect(text).toContain('Sign in with your username');
    expect(text).toMatch(/MUST be clicked first/i);
    expect(text).toContain('input[name="username"]');
  });

  // Otherwise a login page is filed under "navigation only" and generation is
  // told there is nothing to do on the most testable page in the app.
  it('given_a_page_whose_only_form_is_revealed_then_it_counts_as_actionable', () => {
    const text = serializeGraphForFlowLearning(graphOf(loginNode()));
    expect(text).toMatch(/Actionable Pages \(1/);
  });

  /** The output is fenced markdown wrapping the JSON payload. */
  function parseSchema(graph: InteractionGraph): { pages?: unknown[] } | null {
    const raw = extractFormFieldsStructured(graph);
    const match = /```json\s*([\s\S]*?)```/.exec(raw);
    if (!match) return null;
    return JSON.parse(match[1]) as { pages?: unknown[] };
  }

  it('given_a_revealed_form_then_it_appears_in_the_form_schema_json_with_its_trigger', () => {
    const parsed = parseSchema(graphOf(loginNode()));
    const pages = (parsed?.pages ?? parsed) as Array<{
      revealedForms?: Array<{ triggerSelector: string; fields: Array<{ name: string }> }>;
    }>;
    const reveal = pages[0].revealedForms;
    expect(reveal).toHaveLength(1);
    expect(reveal![0].triggerSelector).toBe('button[type="button"]');
    expect(reveal![0].fields.map((f) => f.name)).toContain('username');
  });

  // A page with nothing fillable must not appear at all — an empty entry reads
  // to the model as "this page has a form with no fields".
  it('given_a_page_with_no_forms_at_all_then_no_schema_is_emitted', () => {
    const bare = { url: 'https://app.test/about', title: 'About', elementCount: 1 } as PageNode;
    expect(parseSchema(graphOf(bare))).toBeNull();
  });
});

describe('in-page tab contents', () => {
  function tabbedNode(formFields?: FormField[]): PageNode {
    return {
      url: 'https://app.test/settings',
      title: 'Settings',
      elementCount: 12,
      tabs: [
        {
          label: 'Profile',
          url: 'https://app.test/settings?tab=profile',
          headings: ['Your profile'],
          elementCount: 4,
          formFields,
        },
      ],
    } as PageNode;
  }

  const profileFields: FormField[] = [
    field({ selector: '#display-name', name: 'displayName', label: 'Display name', required: true }),
    field({ selector: '#bio', name: 'bio', label: 'Bio', required: false }),
  ];

  // A tab used to be recorded as a label and a URL only, so the best flow
  // anyone could generate was "open it and check it rendered".
  it('given_a_tab_with_a_form_then_the_flow_fills_it_rather_than_only_opening_it', () => {
    const flows = enumerateSkeletons(graphOf(tabbedNode(profileFields)));
    const flow = flows.find((f) => f.name.includes('Profile'));
    expect(flow?.name).toMatch(/Fill the Profile form/);
    const fills = flow!.steps.filter((s) => s.order > 2);
    expect(fills.map((s) => s.selector)).toEqual(['#display-name', '#bio']);
  });

  it('given_a_tab_form_then_the_view_is_opened_before_any_field_is_filled', () => {
    const flows = enumerateSkeletons(graphOf(tabbedNode(profileFields)));
    const flow = flows.find((f) => f.name.includes('Profile'));
    expect(flow?.steps[0]).toMatchObject({ order: 1, action: 'navigate', value: 'https://app.test/settings?tab=profile' });
    expect(flow!.steps.filter((s) => s.selector).every((s) => s.order > 1)).toBe(true);
  });

  it('given_required_and_optional_tab_fields_then_required_are_filled_first', () => {
    const reversed = [profileFields[1], profileFields[0]];
    const flows = enumerateSkeletons(graphOf(tabbedNode(reversed)));
    const flow = flows.find((f) => f.name.includes('Profile'));
    expect(flow!.steps.filter((s) => s.order > 2)[0].selector).toBe('#display-name');
  });

  // A tab with nothing in it keeps the old, honest behaviour.
  it('given_a_tab_with_no_captured_form_then_it_stays_an_open_and_verify_flow', () => {
    const flows = enumerateSkeletons(graphOf(tabbedNode(undefined)));
    const flow = flows.find((f) => f.name.includes('Profile'));
    expect(flow?.name).toMatch(/^Open Profile/);
    expect(flow!.steps).toHaveLength(2);
    expect(flow!.steps[1].action).toBe('verify');
  });

  it('given_tab_contents_then_they_reach_the_grounding_prompt', () => {
    const text = serializeGraphForFlowLearning(graphOf(tabbedNode(profileFields)));
    expect(text).toContain('Your profile');
    expect(text).toContain('#display-name');
    expect(text).toMatch(/open the view first/i);
  });
});
