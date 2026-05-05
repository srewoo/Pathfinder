---
description: export_graph / import_graph — Port interaction graph data between environments
---

# `export_graph` and `import_graph`

These two tools make exploration data **portable**. Explore once on staging, export the graph,
then import it on any machine or environment to run tests against production (or any other origin)
without re-exploring.

URLs are automatically rewritten from the graph's original origin to the `target_url`'s origin
at both test expansion time and plan execution time.

---

## `export_graph`

Returns the full interaction graph as a JSON string.

### Parameters
None.

### Returns
```
Exported interaction graph: 47 pages, 92 navigation edges.
Explored at: 2026-03-22T09:30:00.000Z

JSON snapshot (copy this to use with `import_graph`):
{ "nodes": [...], "edges": [...], "createdAt": "...", "updatedAt": "..." }
```

### When to Use
- Before clearing the graph (`clear_graph`)
- To share exploration data across team members or CI machines
- To snapshot staging data before a major UI refactor

---

## `import_graph`

Replaces the stored interaction graph with the provided JSON snapshot.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `graph_json` | `string` | JSON returned by `export_graph` |

### Returns
```
Graph imported successfully.
  Pages: 47
  Navigation edges: 92
  Originally explored: 2026-03-22T09:30:00.000Z

You can now run `run_one_liners` against any environment — URLs will be automatically rewritten to match the target URL's origin.
```

---

## Cross-Environment Testing Flow

```
# On staging machine (or once per sprint):
explore_app(url: "https://staging.app.com", depth: 3)
export_graph()   →  copy the JSON

# On any machine / for production runs:
import_graph(graph_json: <copied JSON>)
run_one_liners(
  test_cases: ["User can log in", "Cart persists across sessions"],
  target_url: "https://prod.app.com"
)
# All staging URLs (staging.app.com) rewritten → prod.app.com automatically
```

---

## How URL Rewriting Works

When `target_url` differs from the imported graph's origin:

1. **Expansion time** (`batch-expander`): `startUrl` and step text are rewritten
2. **Plan time** (`test-planner`): graph node and edge URLs are rewritten before test step grounding
3. **Navigation grounding**: `resolveTrustedNavigateUrl` trusts both original and rewritten URLs

This 3-layer rewrite ensures tests work correctly regardless of which environment they were explored on.
