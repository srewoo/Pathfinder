/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import {
  collectShadowHosts,
  buildFramePath,
  correlateActionsAndNetwork,
  suggestAssertions,
  networkCallsToStubSpec,
} from '../../../src/core/recorder/recorder-utils';
import type { RecordedAction } from '../../../src/core/recorder/recorder';

const action = (overrides: Partial<RecordedAction>): RecordedAction => ({
  timestamp: 1000,
  action: 'click',
  selector: 'button',
  elementDescription: 'btn',
  url: 'https://x.com/',
  ...overrides,
});

describe('collectShadowHosts', () => {
  it('given element with no shadow when collecting then returns empty', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(collectShadowHosts(div)).toEqual([]);
  });

  it('given element inside one shadow root when collecting then returns one host', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('span');
    root.appendChild(inner);
    expect(collectShadowHosts(inner)).toEqual([host]);
  });

  it('given element inside nested shadow roots when collecting then returns chain', () => {
    const outerHost = document.createElement('div');
    document.body.appendChild(outerHost);
    const outerRoot = outerHost.attachShadow({ mode: 'open' });
    const innerHost = document.createElement('div');
    outerRoot.appendChild(innerHost);
    const innerRoot = innerHost.attachShadow({ mode: 'open' });
    const target = document.createElement('span');
    innerRoot.appendChild(target);
    const hosts = collectShadowHosts(target);
    expect(hosts).toEqual([innerHost, outerHost]);
  });
});

describe('correlateActionsAndNetwork', () => {
  it('given calls within the next-action gap when correlating then attributes them', () => {
    const actions = [
      action({ timestamp: 1000 }),
      action({ timestamp: 3000 }),
    ];
    const network = [
      { url: '/a', method: 'GET', timestamp: 1100 },
      { url: '/b', method: 'POST', timestamp: 2900 },
      { url: '/c', method: 'GET', timestamp: 5000 },
    ];
    const map = correlateActionsAndNetwork(actions, network);
    expect(map.get(0)?.length).toBe(2);
    expect(map.get(1)).toBeUndefined();
  });

  it('given trailing action when correlating then uses windowMs', () => {
    const actions = [action({ timestamp: 1000 })];
    const network = [{ url: '/a', method: 'GET', timestamp: 1500 }];
    const map = correlateActionsAndNetwork(actions, network, 1000);
    expect(map.get(0)?.length).toBe(1);
  });
});

describe('suggestAssertions', () => {
  it('given click then navigate when suggesting then proposes URL assertion', () => {
    const out = suggestAssertions([
      action({ action: 'click' }),
      action({ action: 'navigate', value: 'https://x.com/dashboard' }),
    ]);
    expect(out.find((s) => s.step.assertType === 'url')?.step.assertExpected).toBe('https://x.com/dashboard');
  });

  it('given type with value when suggesting then proposes value assertion', () => {
    const out = suggestAssertions([
      action({ action: 'type', selector: '#email', value: 'a@b.com' }),
    ]);
    const valAssert = out.find((s) => s.step.assertType === 'value');
    expect(valAssert).toBeDefined();
    expect(valAssert?.step.assertExpected).toBe('a@b.com');
  });

  it('given Submit click when suggesting then proposes toast assertion', () => {
    const out = suggestAssertions([
      action({ action: 'click', elementDescription: '"Submit" button' }),
    ]);
    expect(out.some((s) => s.step.assertType === 'visible' && /toast|notification|alert|status/.test(s.step.selector ?? ''))).toBe(true);
  });

  it('given empty type value when suggesting then no value assertion', () => {
    const out = suggestAssertions([action({ action: 'type', value: '' })]);
    expect(out.find((s) => s.step.assertType === 'value')).toBeUndefined();
  });
});

describe('networkCallsToStubSpec', () => {
  it('given duplicate calls when converting then dedupes by url+method', () => {
    const out = networkCallsToStubSpec([
      { url: '/a', method: 'GET', timestamp: 1, status: 200 },
      { url: '/a', method: 'GET', timestamp: 2, status: 200 },
      { url: '/a', method: 'POST', timestamp: 3, status: 201 },
    ]);
    expect(out).toHaveLength(2);
  });

  it('given empty calls when converting then empty', () => {
    expect(networkCallsToStubSpec([])).toEqual([]);
  });
});

describe('buildFramePath', () => {
  it('given top-level window when building then empty', () => {
    expect(buildFramePath(window)).toEqual([]);
  });
});
