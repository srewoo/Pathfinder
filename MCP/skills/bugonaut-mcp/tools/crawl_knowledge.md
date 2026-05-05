---
description: crawl_knowledge — Index documentation into a RAG knowledge base for smarter test planning
---

# `crawl_knowledge`

Crawls a documentation website and builds a vector knowledge base.
During test planning, relevant documentation chunks are retrieved via semantic search
and injected into the AI prompt — making tests more accurate for your specific domain.

---

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | `string` | required | Starting URL for the documentation crawl |
| `depth` | `number` | `3` | Max crawl depth (1–5) |
| `max_pages` | `number` | `50` | Max pages to index (1–200) |

---

## Returns

A summary of how many pages were crawled and how many vectors were stored:
```
Crawled 42 pages, 318 vectors. Skipped: 3. Errors: 0
```

---

## How It Works

1. Follows links from the starting URL up to the given depth
2. Extracts and cleans text content from each page
3. Chunks the content into overlapping segments
4. Generates embeddings (local via `@xenova/transformers`, or via OpenAI)
5. Stores vectors in MySQL for cosine similarity lookup at test-plan time

---

## When to Use

- Before running tests on a complex domain (e-commerce, SaaS, fintech, etc.)
- After major documentation updates
- To give the AI knowledge of business rules, form field expectations, or navigation flows

---

## Clearing Knowledge

Use `clear_knowledge` before re-crawling a different docs site or when switching projects.

---

## Example

```json
{
  "url": "https://docs.myapp.com",
  "depth": 3,
  "max_pages": 100
}
```
