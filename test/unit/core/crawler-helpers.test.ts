import { describe, it, expect } from 'vitest';
import { parseRobotsTxt, isBlockedByRobots, normalizeUrl } from '../../../src/core/knowledge/crawler';

describe('parseRobotsTxt', () => {
  it('given wildcard agent disallow rules when parsed then collects disallow paths', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /admin\nDisallow: /private');
    expect(rules.disallowPaths).toEqual(['/admin', '/private']);
  });

  it('given a crawl-delay directive when parsed then captures it in ms (capped at 10s)', () => {
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: 2').crawlDelayMs).toBe(2000);
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: 999').crawlDelayMs).toBe(10_000);
  });

  it('given rules scoped to another agent when parsed then ignores them', () => {
    const rules = parseRobotsTxt('User-agent: Googlebot\nDisallow: /no-google');
    expect(rules.disallowPaths).toEqual([]);
  });

  it('given a bare "Disallow: /" when parsed then does not block the whole site', () => {
    expect(parseRobotsTxt('User-agent: *\nDisallow: /').disallowPaths).toEqual([]);
  });

  it('given comments and blank lines when parsed then skips them', () => {
    const rules = parseRobotsTxt('# comment\n\nUser-agent: *\nDisallow: /x');
    expect(rules.disallowPaths).toEqual(['/x']);
  });
});

describe('isBlockedByRobots', () => {
  const rules = { disallowPaths: ['/admin', '/api/*/secret'] };

  it('given a path under a disallow prefix when checked then is blocked', () => {
    expect(isBlockedByRobots('https://x.com/admin/users', rules)).toBe(true);
  });

  it('given an allowed path when checked then is not blocked', () => {
    expect(isBlockedByRobots('https://x.com/public', rules)).toBe(false);
  });

  it('given a wildcard disallow pattern when checked then matches via regex', () => {
    expect(isBlockedByRobots('https://x.com/api/v1/secret', rules)).toBe(true);
  });

  it('given no disallow paths when checked then never blocks', () => {
    expect(isBlockedByRobots('https://x.com/anything', { disallowPaths: [] })).toBe(false);
  });
});

describe('normalizeUrl', () => {
  it('given a trailing slash when normalized then strips it (except root)', () => {
    expect(normalizeUrl('https://x.com/path/')).toBe('https://x.com/path');
    expect(normalizeUrl('https://x.com/')).toBe('https://x.com/');
  });

  it('given a mixed-case origin when normalized then lowercases scheme + host', () => {
    expect(normalizeUrl('HTTPS://X.COM/Path')).toBe('https://x.com/Path');
  });

  it('given equivalent encoded/decoded paths when normalized then they match', () => {
    expect(normalizeUrl('https://x.com/hello world')).toBe(normalizeUrl('https://x.com/hello%20world'));
  });

  it('given a malformed URL when normalized then returns input unchanged', () => {
    expect(normalizeUrl('not a url')).toBe('not a url');
  });
});
