---
description: clear_graph / clear_knowledge — Wipe exploration or documentation data
---

# `clear_graph` and `clear_knowledge`

Two tools for resetting stored data. Use them before re-exploring a new application or
switching documentation sources.

---

## `clear_graph`

Wipes the stored interaction graph (all discovered pages, navigation edges, and form data).

### Parameters
None.

### Returns
```
Interaction graph cleared. Removed 47 pages and 92 navigation edges. Run `explore_app` to rebuild.
```

### When to Use
- Before exploring a completely different application
- When exploration data is stale after major UI changes
- Before importing a graph from a different environment (`import_graph`)

---

## `clear_knowledge`

Wipes the RAG vector knowledge base (all crawled documentation chunks and embeddings).

### Parameters
None.

### Returns
```
Knowledge base cleared. Removed 318 vectors. Run `crawl_knowledge` to rebuild.
```

### When to Use
- Before crawling a different documentation site
- When documentation has been significantly updated
- When switching projects

---

> **Note**: These operations are immediate and irreversible. Use `export_graph` first
> if you want to preserve exploration data before clearing.
