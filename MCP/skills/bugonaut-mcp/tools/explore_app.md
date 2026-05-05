---
description: explore_app — Autonomously crawl a web app to build an interaction graph
---

# `explore_app`

Launches a Playwright browser and autonomously navigates your web application.
Discovers pages, interactive elements, forms, navigation paths, and modals.
Stores the result as an **interaction graph** (nodes = pages, edges = click-paths between them).

The graph is stored in MySQL and reused by `run_one_liners` and `expand_tests` to make test planning more accurate.

---

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | required | Starting URL for the crawl |
| `depth` | `number` | `3` | Max navigation depth (1–5) |
| `max_pages` | `number` | `50` | Maximum number of pages to visit (1–100) |
| `headless` | `boolean` | `true` | Whether to show the browser UI |

---

## Returns

A text summary of the discovered graph, including:
- Number of pages and navigation edges found
- Page titles and URLs
- All form fields with types, labels, and selectors
- Navigation paths (click sequences between pages)

---

## What Gets Stored

After exploration, the following is persisted:
- All discovered page nodes with URLs, titles, headings, breadcrumbs, and form fields
- Navigation edges (which element on which page links to which page)
- Form submission outcomes (if a form was tried)
- Modal/dialog details

---

## Recommended Usage

Run `explore_app` once per environment before running tests. Then use `export_graph` to
save the result so you can `import_graph` it in other environments without re-exploring.

```
Step 1: explore_app(url: "https://staging.app.com", depth: 3)
Step 2: export_graph()   # save the JSON snapshot
Step 3: learn_flows()    # extract user workflows from the graph
```

---

## Example

```json
{
  "url": "https://staging.app.com",
  "depth": 3,
  "max_pages": 60,
  "headless": true
}
```
