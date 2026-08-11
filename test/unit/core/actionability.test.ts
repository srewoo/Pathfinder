import { describe, it, expect } from 'vitest';
import {
  ALL_CHECKS,
  centerOf,
  checksForAction,
  evaluateActionability,
  isStable,
  NotActionableError,
  type ElementSample,
} from '../../../src/core/actionability';

const ok: ElementSample = {
  attached: true,
  visible: true,
  enabled: true,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  receivesEvents: true,
};

describe('evaluateActionability', () => {
  it('given_a_settled_element_when_evaluated_then_actionable', () => {
    const v = evaluateActionability(ok, ok, ALL_CHECKS);
    expect(v.actionable).toBe(true);
    expect(v.failed).toEqual([]);
  });

  it('given_first_sample_when_stability_required_then_not_actionable', () => {
    // One sample cannot establish that a box stopped moving. This costs one
    // poll interval and is why mid-animation clicks stop happening.
    const v = evaluateActionability(ok, null, ALL_CHECKS);
    expect(v.actionable).toBe(false);
    expect(v.failed).toEqual(['stable']);
    expect(v.reason).toMatch(/first sample/);
  });

  it('given_a_detached_element_then_attached_fails_first', () => {
    const v = evaluateActionability({ ...ok, attached: false }, ok, ALL_CHECKS);
    expect(v.failed[0]).toBe('attached');
    expect(v.reason).toMatch(/not attached/);
  });

  it('given_a_zero_size_box_then_visible_fails', () => {
    const v = evaluateActionability(
      { ...ok, rect: { x: 0, y: 0, width: 0, height: 0 } },
      ok,
      ALL_CHECKS
    );
    expect(v.failed).toContain('visible');
    expect(v.reason).toMatch(/empty bounding box/);
  });

  it('given_a_disabled_element_then_enabled_fails', () => {
    const v = evaluateActionability({ ...ok, enabled: false }, ok, ALL_CHECKS);
    expect(v.failed).toContain('enabled');
  });

  it('given_an_obscured_element_then_receivesEvents_fails_and_names_the_obscurer', () => {
    const v = evaluateActionability(
      { ...ok, receivesEvents: false, obscuredBy: 'div.MuiBackdrop-root' },
      ok,
      ALL_CHECKS
    );
    expect(v.failed).toContain('receivesEvents');
    expect(v.reason).toContain('div.MuiBackdrop-root');
  });

  it('given_a_moving_element_then_stable_fails', () => {
    const moved: ElementSample = { ...ok, rect: { x: 0, y: 40, width: 100, height: 20 } };
    const v = evaluateActionability(moved, ok, ALL_CHECKS);
    expect(v.failed).toContain('stable');
    expect(v.reason).toMatch(/still moving/);
  });

  it('given_a_resizing_element_then_stable_fails_even_with_static_origin', () => {
    // An element mid-expand has a fixed origin but a moving click point.
    const resizing: ElementSample = { ...ok, rect: { x: 0, y: 0, width: 300, height: 20 } };
    expect(isStable(resizing, ok)).toBe(false);
  });

  it('given_only_required_checks_then_others_are_ignored', () => {
    // A hidden file input is legitimately unclickable yet perfectly settable.
    const hidden: ElementSample = { ...ok, visible: false, receivesEvents: false };
    const v = evaluateActionability(hidden, hidden, ['attached']);
    expect(v.actionable).toBe(true);
  });
});

describe('checksForAction', () => {
  it('given_click_then_requires_the_full_set', () => {
    expect(checksForAction('click')).toEqual(ALL_CHECKS);
  });

  it('given_type_then_tolerates_occlusion', () => {
    // Floating labels and inline validation icons commonly overlap an input.
    expect(checksForAction('type')).not.toContain('receivesEvents');
    expect(checksForAction('type')).toContain('enabled');
  });

  it('given_upload_file_then_only_requires_attachment', () => {
    expect(checksForAction('upload_file')).toEqual(['attached']);
  });

  it('given_an_unknown_action_then_falls_back_to_attached_only', () => {
    expect(checksForAction('no_such_action')).toEqual(['attached']);
  });
});

describe('centerOf', () => {
  it('given_a_rect_then_returns_its_center', () => {
    expect(centerOf({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
  });
});

describe('NotActionableError', () => {
  it('given_a_verdict_then_the_message_names_the_failed_checks', () => {
    const err = new NotActionableError(
      'button("Save")',
      { actionable: false, failed: ['visible', 'stable'], reason: 'element is not visible' },
      5000
    );
    expect(err.message).toContain('button("Save")');
    expect(err.message).toContain('visible, stable');
    expect(err.message).toContain('5000ms');
    expect(err.isOperational).toBe(true);
  });
});
