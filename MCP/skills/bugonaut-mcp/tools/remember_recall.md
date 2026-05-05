---
description: remember / recall — Store and retrieve cross-run test memory
---

# `remember` and `recall`

A persistent key-value memory system for storing insights across test runs.
The AI and tools can store selector fixes, timing quirks, and test outcomes — and retrieve
them in future runs to improve reliability.

---

## `remember`

Store a value under a key in a named category.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `key` | `string` | Unique memory key |
| `value` | `string` | The value to store |
| `category` | enum | One of: `selector_heal`, `step_pattern`, `tenant_quirk`, `timing_profile`, `test_outcome` |

### Categories

| Category | Use |
|----------|-----|
| `selector_heal` | Record a selector that was healed, so it can be preferred in future |
| `step_pattern` | Record a working sequence for a common action (e.g. "filling date pickers") |
| `tenant_quirk` | Quirks specific to a tenant/environment (e.g. "this org disables SSO") |
| `timing_profile` | Slower/faster page load times for a specific environment |
| `test_outcome` | Record that a known edge case always fails or is expected to behave a certain way |

---

## `recall`

Search memories by key or category.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `string` | Search term or category name |

### Returns

Matching memory entries with their keys, values, and categories.

---

## Example

```json
// Store a known good selector
{
  "key": "login_submit_button",
  "value": "[data-testid='submit-login']",
  "category": "selector_heal"
}

// Recall later
{
  "query": "selector_heal"
}
```
