---
description: get_flows — View all learned user workflows extracted from exploration data
---

# `get_flows`

Returns all user flows stored in the database. Flows are extracted by `learn_flows` and
automatically injected into test planning to guide the AI in generating realistic step sequences.

---

## Parameters

None.

---

## Returns

A structured list of all flows, each with:
- Flow name (e.g. "Login Flow", "Checkout Flow")
- Ordered steps describing the user journey
- Associated page URLs

---

## When to Use

- To verify that `learn_flows` produced meaningful workflows
- To review what the AI understands as key user journeys
- Before running `run_one_liners` to ensure flows are correctly learned

---

## Related Tools

- `learn_flows` — generate flows from the stored graph
- `get_graph` — inspect the raw exploration data
