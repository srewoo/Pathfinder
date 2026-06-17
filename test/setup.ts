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
      get: vi.fn((key: string, callback: (result: Record<string, unknown>) => void) => {
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

// @ts-ignore
globalThis.chrome = chromeMock;

// Mock IndexedDB
const idbMock = {
  open: vi.fn(),
};
// @ts-ignore
globalThis.indexedDB = idbMock;

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
