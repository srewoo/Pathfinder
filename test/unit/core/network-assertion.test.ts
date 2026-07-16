import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecutionStep } from '../../../src/storage/schemas';

vi.mock('../../../src/core/cdp/cdp-client', () => ({
  getHAREntries: vi.fn(),
  isAttached: vi.fn(),
}));

const { getHAREntries, isAttached } = await import('../../../src/core/cdp/cdp-client');
const { isNetworkAssertion, evaluateNetworkAssertion, parseNetworkSpec } =
  await import('../../../src/core/executor/network-assertion');

const entry = (method: string, url: string, status: number) =>
  ({ method, url, status, statusText: '', requestHeaders: {}, responseHeaders: {}, mimeType: 'application/json', startedAt: 0, duration: 1, bodySize: 0 });

const assertStep = (assertType: ExecutionStep['assertType'], assertExpected: string): ExecutionStep =>
  ({ order: 1, action: 'assert', assertType, assertExpected, description: 'net assert' });

describe('isNetworkAssertion', () => {
  it('recognizes api_* assertions and nothing else', () => {
    expect(isNetworkAssertion(assertStep('api_called', '/x'))).toBe(true);
    expect(isNetworkAssertion(assertStep('api_status', '/x 200'))).toBe(true);
    expect(isNetworkAssertion(assertStep('visible', ''))).toBe(false);
    expect(isNetworkAssertion({ order: 1, action: 'click', description: 'c' })).toBe(false);
  });
});

describe('parseNetworkSpec', () => {
  it('parses method + url', () => {
    expect(parseNetworkSpec('POST /api/login', false)).toEqual({ method: 'POST', urlSubstring: '/api/login', status: undefined });
  });
  it('parses url only', () => {
    expect(parseNetworkSpec('/api/login', false)).toEqual({ method: undefined, urlSubstring: '/api/login', status: undefined });
  });
  it('parses method + url + status for api_status', () => {
    expect(parseNetworkSpec('POST /api/login 200', true)).toEqual({ method: 'POST', urlSubstring: '/api/login', status: '200' });
  });
  it('parses a status class (2xx)', () => {
    expect(parseNetworkSpec('/api/orders 2xx', true)).toEqual({ method: undefined, urlSubstring: '/api/orders', status: '2xx' });
  });
  it('rejects api_status with no status token', () => {
    expect(parseNetworkSpec('/api/login', true)).toBeNull();
  });
  it('rejects empty spec', () => {
    expect(parseNetworkSpec('   ', false)).toBeNull();
  });
});

describe('evaluateNetworkAssertion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAttached).mockReturnValue(true);
  });

  it('fails loudly (not a false pass) when CDP capture is not active', () => {
    vi.mocked(isAttached).mockReturnValue(false);
    const r = evaluateNetworkAssertion(assertStep('api_called', '/api/x'), 1);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/CDP/);
  });

  it('api_called passes when a matching request was observed', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('POST', 'https://app/api/login', 200)] as never);
    expect(evaluateNetworkAssertion(assertStep('api_called', 'POST /api/login'), 1).passed).toBe(true);
  });

  it('api_called fails when method does not match', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('GET', 'https://app/api/login', 200)] as never);
    expect(evaluateNetworkAssertion(assertStep('api_called', 'POST /api/login'), 1).passed).toBe(false);
  });

  it('api_not_called passes when nothing matched (negative-test oracle)', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('GET', 'https://app/api/home', 200)] as never);
    expect(evaluateNetworkAssertion(assertStep('api_not_called', '/api/submit'), 1).passed).toBe(true);
  });

  it('api_not_called fails when the request WAS made', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('POST', 'https://app/api/submit', 200)] as never);
    const r = evaluateNetworkAssertion(assertStep('api_not_called', '/api/submit'), 1);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/observed/);
  });

  it('api_status passes on exact status match', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('POST', 'https://app/api/login', 200)] as never);
    expect(evaluateNetworkAssertion(assertStep('api_status', 'POST /api/login 200'), 1).passed).toBe(true);
  });

  it('api_status matches a status class (2xx)', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('POST', 'https://app/api/orders', 201)] as never);
    expect(evaluateNetworkAssertion(assertStep('api_status', '/api/orders 2xx'), 1).passed).toBe(true);
  });

  it('api_status fails and reports the actual status when it differs', () => {
    vi.mocked(getHAREntries).mockReturnValue([entry('POST', 'https://app/api/login', 401)] as never);
    const r = evaluateNetworkAssertion(assertStep('api_status', 'POST /api/login 200'), 1);
    expect(r.passed).toBe(false);
    expect(r.error).toMatch(/401/);
  });
});
