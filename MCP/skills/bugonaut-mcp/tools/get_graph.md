---
description: get_graph — Inspect the currently stored interaction graph
---

# `get_graph`

Returns a human-readable representation of the stored interaction graph built by `explore_app`.
Useful for verifying what the AI knows about your application before running tests.

---

## Parameters

None.

---

## Returns

A formatted text summary of the interaction graph:
- Total pages discovered and navigation edges recorded
- Per-page: title, URL, headings, breadcrumb, form fields, modal details
- Navigation paths between pages (click sequences and selectors)
- Form submission outcomes

---

## When to Use

- To verify `explore_app` ran correctly
- To understand what context the AI uses during test planning
- To debug unexpected navigation behavior in test execution

---

## Related Tools

- `export_graph` — get the raw JSON for portability
- `clear_graph` — reset exploration data
- `explore_app` — rebuild the graph
