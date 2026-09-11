import { describe, it, expect } from 'vitest';
import { emitLocator, quote } from '../../../src/core/export/playwright-locator';
import type { Locator } from '../../../src/core/locator';

function loc(partial: Partial<Locator>): Locator {
  return { preferredTier: 'structural', ...partial } as Locator;
}

describe('quote', () => {
  it('given_plain_text_then_single_quoted', () => {
    expect(quote('Save')).toBe("'Save'");
  });

  it('given_apostrophe_then_escaped', () => {
    expect(quote("User's name")).toBe("'User\\'s name'");
  });

  it('given_backslash_then_escaped', () => {
    expect(quote('a\\b')).toBe("'a\\\\b'");
  });

  it('given_newline_then_escaped_not_literal', () => {
    expect(quote('a\nb')).toBe("'a\\nb'");
  });
});

describe('emitLocator', () => {
  it('given_testid_tier_then_getByTestId', () => {
    const r = emitLocator(loc({ testid: 'save-btn', preferredTier: 'testid' }));
    expect(r).toEqual({ expr: "page.getByTestId('save-btn')" });
  });

  it('given_semantic_tier_then_getByRole_with_name', () => {
    const r = emitLocator(
      loc({ semantic: { role: 'button', name: 'Save', exact: true }, preferredTier: 'semantic' })
    );
    expect(r).toEqual({ expr: "page.getByRole('button', { name: 'Save', exact: true })" });
  });

  it('given_semantic_without_exact_then_omits_exact', () => {
    const r = emitLocator(
      loc({ semantic: { role: 'link', name: 'Assets' }, preferredTier: 'semantic' })
    );
    expect(r).toEqual({ expr: "page.getByRole('link', { name: 'Assets' })" });
  });

  it('given_scoped_semantic_then_chains_from_the_scope', () => {
    const r = emitLocator(
      loc({
        semantic: {
          role: 'button',
          name: 'Save',
          scope: { preferredTier: 'testid', testid: 'billing-form' },
        },
        preferredTier: 'semantic',
      })
    );
    expect(r).toEqual({
      expr: "page.getByTestId('billing-form').getByRole('button', { name: 'Save' })",
    });
  });

  it('given_structural_tier_then_locator_with_css', () => {
    const r = emitLocator(loc({ structural: { css: '.login-container .primary-btn' } }));
    expect(r).toEqual({ expr: "page.locator('.login-container .primary-btn')" });
  });

  // 'generic' is in ARIA_ROLES but is not a Playwright role — falling through
  // to a lower tier beats emitting code that throws at runtime.
  it('given_generic_role_then_falls_through_to_structural', () => {
    const r = emitLocator(
      loc({
        semantic: { role: 'generic', name: 'thing' },
        structural: { css: '#thing' },
        preferredTier: 'semantic',
      })
    );
    expect(r).toEqual({ expr: "page.locator('#thing')" });
  });

  it('given_testid_preferred_but_absent_then_uses_next_available_tier', () => {
    const r = emitLocator(
      loc({ semantic: { role: 'button', name: 'Go' }, preferredTier: 'testid' })
    );
    expect(r).toEqual({ expr: "page.getByRole('button', { name: 'Go' })" });
  });

  it('given_no_usable_tier_then_unsupported_with_reason', () => {
    const r = emitLocator(
      loc({ semantic: { role: 'generic', name: 'x' }, preferredTier: 'semantic' })
    );
    expect(r).toEqual({ unsupported: 'locator has no emittable tier' });
  });

  it('given_custom_root_then_chains_from_it', () => {
    const r = emitLocator(loc({ testid: 'row', preferredTier: 'testid' }), 'frame');
    expect(r).toEqual({ expr: "frame.getByTestId('row')" });
  });

  it('given_a_scope_with_no_emittable_tier_then_the_whole_locator_is_unsupported', () => {
    const r = emitLocator(
      loc({
        semantic: {
          role: 'button',
          name: 'Save',
          scope: { preferredTier: 'semantic', semantic: { role: 'generic', name: 'x' } },
        },
        preferredTier: 'semantic',
      })
    );
    expect(r).toEqual({ unsupported: 'locator has no emittable tier' });
  });
});
