/**
 * Destructive-control detection.
 *
 * Every case here is drawn from a measurement, not imagined. Run against a live
 * app, the old text-only rule caught **0 of 50** delete buttons on one page,
 * because they carry no text, no aria-label and no title — only an icon class.
 * These tests exist so that specific failure cannot come back.
 */
import { describe, it, expect } from 'vitest';
import {
  accessibleNameOf,
  classifyControl,
  isSafeToClick,
  isSessionEndingUrl,
} from '../../../src/core/explorer/danger-heuristics';
import type { InteractiveElement } from '../../../src/storage/schemas';

const el = (over: Partial<InteractiveElement> = {}): InteractiveElement =>
  ({ selector: '#x', tag: 'button', visible: true, position: { x: 0, y: 0, width: 30, height: 30 }, ...over }) as InteractiveElement;

describe('icon-only controls — the measured failure', () => {
  it('given_the_real_orangehrm_delete_button_then_it_is_destructive', () => {
    // <button class="oxd-icon-button"><i class="oxd-icon bi-trash"></i></button>
    const trash = el({ text: '', ariaLabel: undefined, iconClasses: ['oxd-icon', 'bi-trash'], inDataRegion: true });
    const v = classifyControl(trash);
    expect(v.risk).toBe('destructive');
    if (v.risk === 'destructive') expect(v.reason).toContain('bi-trash');
    expect(isSafeToClick(trash)).toBe(false);
  });

  it('given_icon_naming_conventions_across_libraries_then_all_are_caught', () => {
    for (const icon of ['bi-trash', 'bi-trash-fill', 'fa-trash-o', 'mdi-delete', 'icon-bin']) {
      expect(classifyControl(el({ iconClasses: [icon] })).risk, icon).toBe('destructive');
    }
    // `power-off` and `box-arrow-right` depict LEAVING, so they classify as
    // session-ending — a stricter verdict, since that tier is never clickable.
    for (const icon of ['fa-power-off', 'bi-box-arrow-right']) {
      expect(classifyControl(el({ iconClasses: [icon] })).risk, icon).toBe('session-ending');
    }
  });

  it('given_an_edit_pencil_icon_then_it_is_safe', () => {
    // The other half of every row: if this were withheld too, list pages would
    // lose their entire row-action surface.
    expect(classifyControl(el({ iconClasses: ['oxd-icon', 'bi-pencil-fill'], inDataRegion: true })).risk).toBe('safe');
  });

  it('given_a_close_or_times_icon_then_it_is_NOT_treated_as_destructive', () => {
    // Deliberate. An "x" almost always dismisses a dialog, and withholding it
    // would leave the crawler stuck behind the first modal it opened.
    for (const icon of ['bi-x', 'bi-x-lg', 'fa-times', 'bi-x-circle']) {
      expect(classifyControl(el({ iconClasses: [icon] })).risk, icon).toBe('safe');
    }
  });
});

describe('labels', () => {
  it('given_destructive_words_in_any_name_source_then_they_are_caught', () => {
    expect(classifyControl(el({ text: 'Delete' })).risk).toBe('destructive');
    expect(classifyControl(el({ ariaLabel: 'Remove attachment' })).risk).toBe('destructive');
    expect(classifyControl(el({ text: 'Yes, Delete' })).risk).toBe('destructive');
    // "Log Out" is session-ending rather than destructive — see the dedicated
    // describe block; it is refused even under includeDangerous.
    expect(classifyControl(el({ text: 'Log Out' })).risk).toBe('session-ending');
    expect(classifyControl(el({ text: 'Reset Password' })).risk).toBe('destructive');
    expect(classifyControl(el({ text: 'Purge Records' })).risk).toBe('destructive');
  });

  it('given_a_word_that_merely_contains_a_destructive_word_then_it_is_safe', () => {
    // Word boundaries matter: withholding these would cost coverage for nothing.
    expect(classifyControl(el({ text: 'Undeleted items' })).risk).toBe('safe');
    expect(classifyControl(el({ text: 'Removal notice' })).risk).toBe('safe');
    expect(classifyControl(el({ text: 'Deletion policy FAQ' })).risk).toBe('safe');
  });

  it('given_an_ordinary_labelled_button_then_it_is_safe', () => {
    for (const text of ['Save', 'Add', 'Search', 'Reset', '+ Add', 'Cancel']) {
      expect(classifyControl(el({ text })).risk, text).toBe('safe');
    }
  });

  it('given_cancel_alone_then_it_is_safe_but_cancel_subscription_is_not', () => {
    // "Cancel" closes a form; "Cancel Subscription" ends a paid account.
    expect(classifyControl(el({ text: 'Cancel' })).risk).toBe('safe');
    expect(classifyControl(el({ text: 'Cancel Subscription' })).risk).toBe('destructive');
  });
});

describe('unnamed controls in data rows', () => {
  it('given_an_unnamed_unrecognised_control_in_a_row_then_it_is_withheld_as_unidentified', () => {
    // Precaution, not evidence: in a table row this is usually edit or delete and
    // there is no way to tell which. Reported separately so the coverage cost of
    // the precaution is visible.
    const v = classifyControl(el({ text: '', iconClasses: ['oxd-icon', 'bi-three-dots'], inDataRegion: true }));
    expect(v.risk).toBe('unidentified');
    if (v.risk === 'unidentified') expect(v.reason).toContain('bi-three-dots');
  });

  it('given_the_same_control_OUTSIDE_a_data_row_then_it_is_safe', () => {
    expect(classifyControl(el({ text: '', iconClasses: ['bi-three-dots'], inDataRegion: false })).risk).toBe('safe');
  });

  it('given_an_unnamed_row_control_with_a_recognised_safe_icon_then_it_is_safe', () => {
    expect(classifyControl(el({ text: '', iconClasses: ['bi-eye'], inDataRegion: true })).risk).toBe('safe');
  });

  it('given_includeDangerous_then_everything_is_clickable', () => {
    // The escape hatch has to actually open, or users disable safety wholesale.
    const trash = el({ iconClasses: ['bi-trash'], inDataRegion: true });
    expect(isSafeToClick(trash, true)).toBe(true);
  });
});

describe('accessibleNameOf', () => {
  it('given_several_name_sources_then_all_are_considered', () => {
    expect(accessibleNameOf(el({ ariaLabel: 'Delete row', text: '' }))).toBe('Delete row');
    expect(accessibleNameOf(el({ text: 'Save', name: 'submit' }))).toContain('Save');
    expect(accessibleNameOf(el({ text: '' }))).toBe('');
  });
});

describe('session-ending controls — never clicked, under any setting', () => {
  /**
   * A different kind of consequence from a delete. Logging out does not damage one
   * record; it invalidates every page the crawl visits afterwards. The crawler lands
   * on the login screen and maps THAT, while the run keeps reporting pages as
   * explored — a full crawl silently becomes a map of a login form.
   */
  it('given_a_logout_label_then_it_is_session_ending_not_merely_destructive', () => {
    for (const text of ['Logout', 'Log Out', 'Sign out', 'Sign Out', 'LOGOFF', 'Log off', 'End session']) {
      const v = classifyControl(el({ text }));
      expect(v.risk, text).toBe('session-ending');
    }
  });

  it('given_includeDangerous_then_logout_is_STILL_refused', () => {
    // The headline property. Opting into destructive exploration is a decision
    // about data; nobody enabling it wants to be logged out three pages in — least
    // of all before the destructive flows they turned it on to exercise.
    const logout = el({ text: 'Sign out' });
    expect(isSafeToClick(logout, true)).toBe(false);
    expect(isSafeToClick(logout, false)).toBe(false);
  });

  it('given_a_delete_button_then_includeDangerous_DOES_open_it', () => {
    // The contrast that makes the rule above meaningful rather than blanket caution.
    expect(isSafeToClick(el({ text: 'Delete' }), true)).toBe(true);
  });

  it('given_an_unlabelled_link_to_a_logout_URL_then_the_URL_gives_it_away', () => {
    // <a href="/logout"><i class="icon"></i></a> — no text, no label. The URL is
    // the only signal, and it is the one that survives an icon-only control.
    const v = classifyControl(el({ tag: 'a', text: '', href: 'https://app.test/auth/logout' }));
    expect(v.risk).toBe('session-ending');
  });

  it('given_logout_URL_variants_then_all_are_recognised', () => {
    for (const url of [
      'https://app.test/logout',
      'https://app.test/log-out',
      'https://app.test/sign_out',
      'https://app.test/users/sign_out',
      'https://app.test/auth/logout?redirect=/',
      'https://app.test/index.php?action=logoff',
      'https://app.test/saml/logout',
      'https://app.test/session/end-session',
    ]) {
      expect(isSessionEndingUrl(url), url).toBe(true);
    }
  });

  it('given_URLs_that_merely_CONTAIN_the_letters_then_they_are_not_matched', () => {
    // False positives here cost real coverage: these are ordinary pages.
    for (const url of [
      'https://app.test/blog/logout-best-practices',
      'https://app.test/products/signout-widget-pro',
      'https://app.test/dialogue/list',
    ]) {
      expect(isSessionEndingUrl(url), url).toBe(false);
    }
  });

  it('given_a_logout_ICON_then_it_is_session_ending', () => {
    for (const icon of ['bi-box-arrow-right', 'fa-sign-out', 'mdi-logout', 'bi-power']) {
      expect(classifyControl(el({ text: '', iconClasses: [icon] })).risk, icon).toBe('session-ending');
    }
  });

  it('given_ambiguous_words_then_they_are_NOT_treated_as_session_ending', () => {
    // "Exit full screen" and "Leave feedback" are ordinary controls, and in an HR
    // app "Sign off" usually means approving a document, not ending a session.
    for (const text of ['Exit full screen', 'Leave feedback', 'Sign off timesheet', 'Exit preview']) {
      expect(classifyControl(el({ text })).risk, text).not.toBe('session-ending');
    }
  });

  it('given_switch_account_then_it_is_session_ending', () => {
    // Ends the session under test even though nothing is destroyed.
    expect(classifyControl(el({ text: 'Switch account' })).risk).toBe('session-ending');
    expect(classifyControl(el({ ariaLabel: 'Switch user' })).risk).toBe('session-ending');
  });
});
