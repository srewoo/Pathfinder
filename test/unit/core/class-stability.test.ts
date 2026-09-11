import { describe, it, expect } from 'vitest';
import {
  isHashedClassName,
  stableClassesOf,
  isHashOnlySelector,
} from '../../../src/core/healing/class-stability';

describe('isHashedClassName', () => {
  // Real-world hashes observed in styled-components, emotion and CSS modules.
  const hashed = [
    'sc-1e593sq-0', // styled-components component id
    'beZfZu', // styled-components generated class
    'css-1x2y3z', // emotion
    'jss123', // JSS
    'Button_root__a1b2c', // CSS modules
    'styles__StyledLink-sc-1e593sq-0',
    'x1n2onr6', // atomic css
    'a8Kd92Lf',
  ];
  it.each(hashed)('given_hashed_class_%s_when_tested_then_true', (cls) => {
    expect(isHashedClassName(cls)).toBe(true);
  });

  // Human-authored names must never be rejected — a false positive here
  // discards the only usable selector.
  const stable = [
    'btn',
    'btn-primary',
    'nav-link',
    'login-container',
    'share-icon',
    'form-group',
    'is-active',
    'col-md-6',
    'mt-4',
    'dashboard-dropdown-menu-item',
    'modal',
    'primary',
    'header',
    'sidebar-nav',
    'text-sm',
    'mtdls-typography-label-medium-default',
  ];
  it.each(stable)('given_authored_class_%s_when_tested_then_false', (cls) => {
    expect(isHashedClassName(cls)).toBe(false);
  });

  it('given_empty_string_when_tested_then_false', () => {
    expect(isHashedClassName('')).toBe(false);
  });
});

describe('stableClassesOf', () => {
  it('given_mixed_class_attribute_when_filtered_then_keeps_only_authored_names', () => {
    const attr =
      'styles__StyledLink-sc-1e593sq-0 beZfZu mtdls-typography-label-medium-default expanded-state-route-item';
    expect(stableClassesOf(attr)).toEqual([
      'mtdls-typography-label-medium-default',
      'expanded-state-route-item',
    ]);
  });

  it('given_all_hashed_when_filtered_then_empty', () => {
    expect(stableClassesOf('sc-abc12-3 beZfZu')).toEqual([]);
  });

  it('given_extra_whitespace_when_filtered_then_ignores_blanks', () => {
    expect(stableClassesOf('  btn   primary  ')).toEqual(['btn', 'primary']);
  });
});

describe('isHashOnlySelector', () => {
  it('given_selector_of_only_hashed_classes_then_true', () => {
    expect(isHashOnlySelector('.sc-1e593sq-0.beZfZu')).toBe(true);
  });

  it('given_selector_with_one_authored_class_then_false', () => {
    expect(isHashOnlySelector('.sc-1e593sq-0.nav-link')).toBe(false);
  });

  it('given_selector_with_stable_attribute_then_false', () => {
    expect(isHashOnlySelector('[data-testid="save"].beZfZu')).toBe(false);
  });

  it('given_id_selector_then_false', () => {
    expect(isHashOnlySelector('#submit-btn')).toBe(false);
  });

  it('given_selector_with_no_classes_then_false', () => {
    expect(isHashOnlySelector('button[type="submit"]')).toBe(false);
  });
});
