---
description: run_one_liners — Expand and execute plain-English test cases against a web app
---

# `run_one_liners`

The primary tool for running tests. Accepts one-liner descriptions, expands each into a full
step-by-step test case using AI, then executes them concurrently in Playwright browsers.
Returns a summary and full HTML report.

---

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `test_cases` | `string[]` | required | Array of plain-English test descriptions |
| `target_url` | `string` | required | Base URL of the app under test |
| `batch_size` | `number` | `3` | How many tests to expand in parallel (1–5) |
| `headless` | `boolean` | `true` | Whether to show the browser UI |
| `concurrency` | `number` | `3` | Max parallel browser tabs during execution (1–4) |
| `shared_context` | `string` | — | Optional extra context injected into every test expansion |

---

## Returns

- A plain-text summary: `Run <id>: X/Y passed, Z failed, N errors`
- A full HTML report with per-test step-level results and failure screenshots

---

## How It Works

1. Each one-liner is expanded by the AI into a structured `TestCase` (steps, assertions, start URL)
2. If exploration data exists, it enriches planning with known pages, form fields, and flows
3. If crawled documentation exists, relevant chunks are retrieved via RAG
4. Each test runs in its own Playwright browser tab with up to 2 automatic retries
5. Failed selectors trigger the 3-strategy self-healer before marking a step failed

---

## Environment URL Rewriting

If the stored interaction graph was explored on a different origin than `target_url`,
all graph URLs (used during test planning) are automatically rewritten to match `target_url`'s origin.
No manual changes needed.

---

## Example

```json
{
  "test_cases": [
    "User can log in with valid credentials",
    "Logged-out user is redirected to login page when accessing /dashboard"
  ],
  "target_url": "https://prod.app.com",
  "concurrency": 2,
  "headless": true
}
```
