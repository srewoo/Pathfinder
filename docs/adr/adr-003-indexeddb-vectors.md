# ADR-003: IndexedDB for Vector Storage with Cosine Similarity

**Status**: Accepted
**Date**: 2026-03-01

## Context

pathfinder requires a vector store to persist embeddings generated from crawled documentation and perform similarity search when assembling AI prompt context. The store must run entirely client-side inside a Chrome extension (no native binaries, no WebAssembly-heavy libraries that inflate bundle size).

## Decision

Store vectors in **IndexedDB** and compute **cosine similarity in pure JavaScript** at query time.

## Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **IndexedDB + JS cosine similarity** | Zero dependencies, works in extension context, no WASM, simple | O(n) scan, limited scale (~10 k vectors) |
| vectra (WASM) | Fast ANN search | Large bundle (~1 MB+), WASM in extension context has CSP issues |
| sqlite-wasm | SQL + vector extension | Heavy, complex CSP exemptions needed |
| chrome.storage.local | Simple key-value | 10 MB limit, not designed for large arrays |
| In-memory only | Fastest reads | Lost on extension reload/update |

## Consequences

- **Scale ceiling**: Cosine similarity over IndexedDB is O(n). Performance degrades past ~10 000 vectors. Acceptable for typical doc sites (100–500 pages → ~500–2 000 vectors). A progress indicator is shown during crawling to set expectations.
- **No ANN**: No approximate nearest-neighbour indexing (HNSW, IVF). For the expected scale this is fine; full scan completes in <200 ms.
- **Persistence**: Vectors survive browser restarts and extension updates. Users do not need to re-crawl on every session.
- **Testability**: `fake-indexeddb` provides a drop-in replacement for unit and integration tests.
- **Future path**: If scale requirements grow, the `vectorDB` interface is intentionally thin — it can be swapped for a WASM-based store without changing caller code.
