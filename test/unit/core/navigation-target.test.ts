/**
 * Where a `navigate` step may go.
 *
 * The observed failure: a generated step carried `/university/command-center` — a
 * path, not a URL. Nothing checked it, `chrome.tabs.update` resolved it against the
 * EXTENSION's base, and the tab landed on
 *
 *   chrome-extension://mccnppbdegniiipcffblljjbfllalahp/university/command-center
 *   → ERR_FILE_NOT_FOUND
 *
 * Every step after that ran against a Chrome error page, so the run failed for the
 * wrong reason and the report blamed the app.
 */
import { describe, it, expect } from 'vitest';
import {
  assessNavigationGrounding,
  isAbsoluteAppUrl,
  resolveNavigationTarget,
} from '../../../src/core/executor/navigation-target';

describe('relative targets resolve against the page, not the caller', () => {
  it('given_the_exact_failing_value_then_it_resolves_to_the_app', () => {
    const t = resolveNavigationTarget('/university/command-center', {
      currentUrl: 'https://app.mindtickle.com/new/ui/learner/home',
    });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url).toBe('https://app.mindtickle.com/university/command-center');
  });

  it('given_a_relative_path_and_no_current_page_then_the_start_url_is_the_base', () => {
    const t = resolveNavigationTarget('settings/profile', {
      startUrl: 'https://app.test/home/',
    });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url).toBe('https://app.test/home/settings/profile');
  });

  it('given_a_protocol_relative_target_then_the_base_protocol_is_used', () => {
    const t = resolveNavigationTarget('//cdn.app.test/page', { currentUrl: 'https://app.test/' });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url).toBe('https://cdn.app.test/page');
  });

  it('given_a_query_only_target_then_it_resolves_against_the_current_path', () => {
    const t = resolveNavigationTarget('?tab=overview', {
      currentUrl: 'https://app.test/reports/list',
    });
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.url).toBe('https://app.test/reports/list?tab=overview');
  });
});

describe('targets that can never be the app are refused', () => {
  it('given_a_chrome_extension_url_then_it_is_refused_with_the_cause_named', () => {
    // Refusing loudly beats navigating there and failing obscurely for the rest of
    // the run.
    const t = resolveNavigationTarget(
      'chrome-extension://mccnppbdegniiipcffblljjbfllalahp/university/command-center'
    );
    expect(t.ok).toBe(false);
    if (!t.ok) {
      expect(t.error).toContain('never the app under test');
      expect(t.error).toContain('chrome-extension:');
    }
  });

  it('given_other_privileged_schemes_then_all_are_refused', () => {
    for (const url of [
      'file:///Users/someone/report.html',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'view-source:https://app.test/',
    ]) {
      expect(resolveNavigationTarget(url).ok, url).toBe(false);
    }
  });

  it('given_a_relative_target_with_NO_usable_base_then_it_refuses_instead_of_guessing', () => {
    // This is the case that produced the bug: the tab was on an extension page, so
    // there was no app origin to resolve against. Guessing an origin would run the
    // test somewhere unrelated and report the result as the app's.
    const t = resolveNavigationTarget('/university/command-center', {
      currentUrl: 'chrome-extension://abc/sidepanel.html',
    });
    expect(t.ok).toBe(false);
    if (!t.ok) {
      expect(t.error).toContain('relative path');
      expect(t.error).toContain('absolute URL');
    }
  });

  it('given_an_empty_value_then_it_is_refused', () => {
    expect(resolveNavigationTarget('').ok).toBe(false);
    expect(resolveNavigationTarget('   ').ok).toBe(false);
  });
});

describe('absolute app URLs pass through untouched', () => {
  it('given_http_and_https_then_they_are_used_as_is', () => {
    for (const url of ['https://app.test/x?y=1#z', 'http://localhost:5173/home']) {
      const t = resolveNavigationTarget(url, { currentUrl: 'https://elsewhere.test/' });
      expect(t.ok, url).toBe(true);
      if (t.ok) expect(t.url).toBe(url);
    }
  });

  it('given_an_absolute_url_then_no_base_is_needed', () => {
    expect(resolveNavigationTarget('https://app.test/x').ok).toBe(true);
  });

  it('isAbsoluteAppUrl distinguishes the two cases', () => {
    expect(isAbsoluteAppUrl('https://app.test/x')).toBe(true);
    expect(isAbsoluteAppUrl('/university/command-center')).toBe(false);
    expect(isAbsoluteAppUrl('chrome-extension://abc/x')).toBe(false);
    expect(isAbsoluteAppUrl('')).toBe(false);
  });
});

describe('grounding — was this target ever actually observed?', () => {
  /**
   * Planning asks a model to turn "go to the command center" into a URL. With a
   * thin graph it has nothing to copy, so it writes a URL that reads correctly and
   * does not exist. That is how a run navigated to `/university/command-center`.
   *
   * Nothing is repaired here on purpose: substituting a guess of our own would be
   * the same mistake with a different author.
   */
  const mapped = (...urls: string[]) => ({ knownUrls: urls, mappedPageCount: urls.length });

  it('given_a_url_that_was_visited_then_it_is_grounded', () => {
    const v = assessNavigationGrounding('https://app.test/reports', mapped(
      'https://app.test/home', 'https://app.test/reports'
    ));
    expect(v.grounded).toBe(true);
  });

  it('given_a_trailing_slash_or_fragment_difference_then_it_still_matches', () => {
    // Cosmetic differences must not be reported as invented URLs.
    expect(assessNavigationGrounding('https://app.test/reports/', mapped('https://app.test/reports')).grounded).toBe(true);
    expect(assessNavigationGrounding('https://app.test/reports#top', mapped('https://app.test/reports')).grounded).toBe(true);
  });

  it('given_a_SINGLE_page_mapped_then_the_reason_names_the_actual_cause', () => {
    // The measured situation: 1 page, 32 unvisited edges, flows and plans invented
    // from documentation.
    const v = assessNavigationGrounding(
      'https://app.test/university/command-center',
      mapped('https://app.test/new/ui/learner/home')
    );
    expect(v.grounded).toBe(false);
    if (!v.grounded) {
      expect(v.reason).toContain('1 page(s) mapped');
      expect(v.reason).toContain('inferred from documentation');
      expect(v.reason).toContain('Re-explore');
    }
  });

  it('given_a_well_explored_app_then_the_message_is_the_milder_one', () => {
    const v = assessNavigationGrounding('https://app.test/invented', {
      knownUrls: Array.from({ length: 40 }, (_, i) => `https://app.test/p${i}`),
      mappedPageCount: 40,
    });
    expect(v.grounded).toBe(false);
    if (!v.grounded) {
      expect(v.reason).toContain('may be invented');
      expect(v.reason).not.toContain('inferred from documentation');
    }
  });

  it('given_nothing_explored_then_it_says_so_rather_than_blaming_the_url', () => {
    const v = assessNavigationGrounding('https://app.test/x', { knownUrls: [], mappedPageCount: 0 });
    expect(v.grounded).toBe(false);
    if (!v.grounded) expect(v.reason).toContain('nothing has been explored yet');
  });
});
