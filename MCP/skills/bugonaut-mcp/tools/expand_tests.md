---
description: expand_tests — Expand one-liner test descriptions into structured test cases (dry run, no execution)
---

# `expand_tests`

Like `run_one_liners` but **without executing the tests**. Useful for reviewing and validating
the AI's interpretation of your test descriptions before committing to a full run.

---

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `test_cases` | `string[]` | required | Plain-English test descriptions |
| `target_url` | `string` | — | Optional base URL (used as context for step generation) |
| `batch_size` | `number` | `3` | Number of tests to expand in parallel (1–5) |

---

## Returns

A list of expanded `TestCase` objects, each containing:
- `title` — refined test title
- `description` — what the test validates
- `steps` — ordered list of natural-language execution steps
- `type` — `positive`, `negative`, or `edge_case`
- `startUrl` — inferred starting page URL

---

## When to Use

- To preview and sanity-check AI-generated test plans
- As a design step before automating a suite
- To export and review test cases for manual QA

---

## Example

```json
{
  "test_cases": [
    "User can reset their password via email",
    "Invalid login shows error message"
  ],
  "target_url": "https://staging.app.com"
}
```

**Example output for first test case:**
```json
{
  "title": "User can reset password via email",
  "type": "positive",
  "steps": [
    "Navigate to /login",
    "Click 'Forgot password?'",
    "Enter registered email address",
    "Click 'Send reset link'",
    "Assert confirmation message is visible"
  ],
  "startUrl": "https://staging.app.com/login"
}
```
