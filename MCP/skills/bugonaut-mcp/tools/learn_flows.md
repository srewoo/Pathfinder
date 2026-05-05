---
description: learn_flows — Extract named user workflows from exploration data using AI
---

# `learn_flows`

Analyzes the stored interaction graph and extracts named **user flows** (e.g. "checkout flow",
"login flow", "account setup"). These flows are stored and automatically used during test expansion
and planning to generate more structured, realistic test cases.

---

## Parameters

None — operates on the currently stored interaction graph.

---

## Returns

A list of extracted flows with their names, steps, and associated pages.

---

## How It Works

1. Loads the interaction graph built by `explore_app`
2. Sends page/edge data to the AI with a structured prompt
3. AI identifies meaningful user journeys and names them
4. Flows are stored in MySQL and injected into all future planning prompts

---

## Dependency

Requires a non-empty interaction graph. Run `explore_app` first.

---

## Example Flows Extracted

- `Login Flow` → navigate to `/login` → fill credentials → submit → assert dashboard visible
- `Create Project Flow` → click "New Project" → fill form → submit → assert project list updated
- `Checkout Flow` → add item → open cart → fill payment → confirm → assert order confirmation

---

## Usage

```
# Run after exploration:
explore_app(url: "https://app.example.com")
learn_flows()

# Then run tests — flows are automatically used:
run_one_liners(test_cases: ["User can complete checkout"], target_url: "...")
```
