import { describe, it, expect } from 'vitest';
import {
  resolveUrl,
  extractPath,
  normalizeUrl,
  rewriteOrigin,
  detectGraphOrigin,
  rewriteTestCaseUrls,
} from '../../src/environment/url-resolver.js';

describe('resolveUrl', () => {
  it('given_relative_path_when_resolved_then_returns_absolute_url', () => {
    expect(resolveUrl('/courses/123', 'https://staging.example.com')).toBe(
      'https://staging.example.com/courses/123'
    );
  });

  it('given_root_path_when_resolved_then_returns_origin_with_slash', () => {
    expect(resolveUrl('/', 'https://example.com')).toBe('https://example.com/');
  });

  it('given_path_with_query_when_resolved_then_preserves_query', () => {
    expect(resolveUrl('/search?q=test', 'https://app.com')).toBe(
      'https://app.com/search?q=test'
    );
  });
});

describe('extractPath', () => {
  it('given_full_url_when_extracted_then_returns_path_and_query', () => {
    expect(extractPath('https://staging.example.com/courses/123?tab=overview')).toBe(
      '/courses/123?tab=overview'
    );
  });

  it('given_url_with_no_path_when_extracted_then_returns_slash', () => {
    expect(extractPath('https://example.com')).toBe('/');
  });
});

describe('normalizeUrl', () => {
  it('given_trailing_slash_when_normalized_then_removes_it', () => {
    expect(normalizeUrl('https://example.com/courses/')).toBe('https://example.com/courses');
  });

  it('given_root_url_when_normalized_then_keeps_slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('given_invalid_url_when_normalized_then_returns_as_is', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('rewriteOrigin', () => {
  it('given_staging_url_when_rewritten_to_prod_then_changes_origin', () => {
    expect(rewriteOrigin('https://staging.app.com/courses/123', 'https://prod.app.com')).toBe(
      'https://prod.app.com/courses/123'
    );
  });

  it('given_http_url_when_rewritten_to_https_then_changes_protocol', () => {
    expect(rewriteOrigin('http://localhost:3000/test', 'https://prod.app.com')).toBe(
      'https://prod.app.com/test'
    );
  });

  it('given_invalid_url_when_rewritten_then_returns_original', () => {
    expect(rewriteOrigin('not-a-url', 'https://prod.app.com')).toBe('not-a-url');
  });

  it('given_url_with_port_when_rewritten_then_changes_port', () => {
    expect(rewriteOrigin('http://localhost:3000/api', 'http://localhost:8080')).toBe(
      'http://localhost:8080/api'
    );
  });
});

describe('detectGraphOrigin', () => {
  it('given_multiple_urls_when_detected_then_returns_most_common_origin', () => {
    const urls = [
      'https://staging.app.com/page1',
      'https://staging.app.com/page2',
      'https://staging.app.com/page3',
      'https://other.com/page1',
    ];
    expect(detectGraphOrigin(urls)).toBe('https://staging.app.com');
  });

  it('given_empty_array_when_detected_then_returns_undefined', () => {
    expect(detectGraphOrigin([])).toBeUndefined();
  });

  it('given_invalid_urls_when_detected_then_skips_them', () => {
    expect(detectGraphOrigin(['not-a-url', 'also-invalid'])).toBeUndefined();
  });
});

describe('rewriteTestCaseUrls', () => {
  it('given_same_origin_when_rewritten_then_no_change', () => {
    const result = rewriteTestCaseUrls(
      ['Click on https://app.com/login'],
      'https://app.com/login',
      'https://app.com',
      'https://app.com'
    );
    expect(result.startUrl).toBe('https://app.com/login');
    expect(result.steps?.[0]).toBe('Click on https://app.com/login');
  });

  it('given_different_origin_when_rewritten_then_rewrites_all', () => {
    const result = rewriteTestCaseUrls(
      ['Navigate to https://staging.app.com/dashboard', 'Click submit on https://staging.app.com/form'],
      'https://staging.app.com/login',
      'https://staging.app.com',
      'https://prod.app.com'
    );
    expect(result.startUrl).toBe('https://prod.app.com/login');
    expect(result.steps?.[0]).toContain('https://prod.app.com/dashboard');
    expect(result.steps?.[1]).toContain('https://prod.app.com/form');
  });

  it('given_undefined_steps_when_rewritten_then_handles_gracefully', () => {
    const result = rewriteTestCaseUrls(
      undefined,
      undefined,
      'https://staging.app.com',
      'https://prod.app.com'
    );
    expect(result.steps).toBeUndefined();
    expect(result.startUrl).toBeUndefined();
  });
});
