import { vi } from 'vitest';

// Mock chrome APIs
const chromeMock = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    lastError: undefined as chrome.runtime.LastError | undefined,
  },
  storage: {
    local: {
      get: vi.fn((_key: string, callback: (result: Record<string, unknown>) => void) => {
        callback({});
      }),
      set: vi.fn((_items: object, callback?: () => void) => {
        callback?.();
      }),
    },
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    captureVisibleTab: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onRemoved: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  // Cookie jar — used by the crawler to seed auth cookies (the Cookie request
  // header is forbidden, so cookies must be set in the jar instead).
  cookies: {
    set: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue([]),
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([{ result: '<html></html>' }]),
  },
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(),
    onEvent: { addListener: vi.fn(), removeListener: vi.fn() },
    onDetach: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  sidePanel: {
    open: vi.fn(),
    setPanelBehavior: vi.fn(),
  },
  alarms: {
    onAlarm: {
      addListener: vi.fn(),
    },
  },
};

// The mock covers only the surface the tests exercise, so it is deliberately
// not a full `typeof chrome`. Cast rather than suppress: a suppression hides
// any OTHER error on the line too, and this one only needs the shape widened.
globalThis.chrome = chromeMock as unknown as typeof chrome;

// Mock IndexedDB
const idbMock = {
  open: vi.fn(),
};
globalThis.indexedDB = idbMock as unknown as IDBFactory;

// Mock crypto.subtle.digest if needed
const originalCrypto = globalThis.crypto;
if (originalCrypto && !originalCrypto.subtle?.digest) {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...originalCrypto,
      subtle: {
        digest: vi.fn(async () => new ArrayBuffer(32)),
      },
    },
    writable: true,
    configurable: true,
  });
}

// jsdom does not implement `CSS.escape`, which every browser has. Selector
// generation in the content script calls it for each element, and the caller
// caught the resulting ReferenceError and skipped the element — so DOM detection
// silently returned nothing under test and could never be covered. Supplying the
// real semantics here rather than a stub, so tests exercise production behaviour.
if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
  Object.defineProperty(globalThis, 'CSS', {
    value: {
      escape: (value: string): string =>
        String(value).replace(/[^\w-]/g, (ch) => `\\${ch}`),
    },
    writable: true,
    configurable: true,
  });
}
