---
description: get_results — Retrieve test results for a past run by run ID
---

# `get_results`

Fetch the stored results for a previously completed test run. Returns per-test pass/fail status,
step-level results, error messages, healing attempts, and screenshot references.

---

## Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `run_id` | `string` | The run ID returned by `run_one_liners` |

---

## Returns

A structured list of `TestResult` objects, each containing:
- `testCaseTitle` — name of the test
- `status` — `passed`, `failed`, or `error`
- `duration` — total execution time in ms
- `steps` — per-step results with status, duration, and any error
- `errorMessage` — the last failure message if the test failed
- `healingAttempts` — any self-healing that was attempted
- `screenshot` — base64 screenshot of the failure state (if any)

---

## When to Use

- After a `run_one_liners` call to retrieve the full structured result (not just HTML)
- For programmatic post-processing or reporting integration
- To review healing attempts and understand flakiness patterns

---

## Example

```json
{
  "run_id": "run_abc123xyz"
}
```
