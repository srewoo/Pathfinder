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
    captureVisibleTab: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
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
