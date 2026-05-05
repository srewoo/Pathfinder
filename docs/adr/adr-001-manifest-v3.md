# ADR-001: Chrome Manifest V3 with Vite + CRXJS

**Status**: Accepted
**Date**: 2026-03-01

## Context

pathfinder is a Chrome extension that needs to inject content scripts, manage a persistent side panel, and run background orchestration. Chrome has deprecated Manifest V2 (MV2) and requires all new extensions published to the Chrome Web Store to use Manifest V3 (MV3).

MV3 introduces significant changes: background pages are replaced with service workers (ephemeral, 30 s idle timeout), blocking webRequest is removed, and CSP is stricter. A build toolchain capable of producing valid MV3 output is required.

## Decision

Use **Chrome Manifest V3** with **Vite + @crxjs/vite-plugin** as the build toolchain.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Vite + CRXJS** | Native MV3 support, HMR in dev, fast builds, small bundle | Beta plugin, smaller community than webpack |
| Webpack + webextension-webpack-plugin | Mature, large ecosystem | Slower builds, verbose config, MV3 support uneven |
| Plasmo Framework | Opinionated DX, good MV3 abstractions | Heavy abstraction hides details, harder to debug |
| Manual webpack | Full control | Massive boilerplate, slow iteration |

## Consequences

- **Service worker constraint**: Service workers have a 30 s idle timeout in MV3. Long-running tasks (crawling, test execution) must use `chrome.alarms` or chunked messaging to stay alive.
- **No persistent background**: State cannot be kept in a background variable; all state goes to `chrome.storage` or `IndexedDB`.
- **Faster development**: Vite HMR speeds up UI iteration significantly.
- **CSP restrictions**: No `eval()` or `new Function()` — all dynamic code execution is prohibited. All AI JSON parsing uses native `JSON.parse`.
