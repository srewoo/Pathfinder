---
description: Pathfinder MCP — AI-powered browser test execution server
---

# Pathfinder MCP

An AI-powered browser testing server that implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).
It lets you write tests in plain English and executes them autonomously against any web environment using Playwright.

---

## Setup

1. Copy `.env.example` → `.env` and fill in your API key, AI provider, and MySQL credentials
2. Run `npm run setup` to install dependencies and Playwright browsers
3. Start the server: `npm run dev`
4. Add the server to your MCP client (e.g. Claude Desktop, Cursor)

---

## Recommended Workflow

```
explore_app  →  learn_flows  →  crawl_knowledge
                    ↓
              run_one_liners   (any environment)
                    ↓
              get_results
```

---

## Tool Reference

| Tool | Purpose |
|------|---------|
| [`run_one_liners`](tools/run_one_liners.md) | Expand + execute plain-English test cases |
| [`explore_app`](tools/explore_app.md) | Crawl a web app to build an interaction graph |
| [`learn_flows`](tools/learn_flows.md) | Extract named user flows from exploration data |
| [`crawl_knowledge`](tools/crawl_knowledge.md) | Index documentation for RAG test planning |
| [`expand_tests`](tools/expand_tests.md) | Expand test cases without running them |
| [`get_results`](tools/get_results.md) | Fetch results for a past run |
| [`get_graph`](tools/get_graph.md) | Inspect the stored interaction graph |
| [`get_flows`](tools/get_flows.md) | View all learned user flows |
| [`remember` / `recall`](tools/remember_recall.md) | Store and retrieve cross-run memory |
| [`clear_graph`](tools/clear_data.md) | Wipe the interaction graph |
| [`clear_knowledge`](tools/clear_data.md) | Wipe the RAG knowledge base |
| [`export_graph`](tools/import_export_graph.md) | Export graph as portable JSON |
| [`import_graph`](tools/import_export_graph.md) | Import a graph snapshot for cross-env runs |

---

## Environment-Agnostic Testing

You can explore on staging and run on production:

```
1. explore_app(url: "https://staging.app.com")
2. export_graph()                         # save the JSON
3. import_graph(graph_json: <saved JSON>) # on any machine / env
4. run_one_liners(target_url: "https://prod.app.com", ...)
```

URLs are automatically rewritten from the graph's original origin to the target.
