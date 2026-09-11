# Evaluation fixture app

Paired variants of the same application. `correct/` behaves; `broken/` has one
seeded defect per page and nothing else changed.

Every page exists twice with the **same filename and the same selectors**, so a
scenario is driven identically against both and the only variable is the defect.
That is what makes a false positive measurable: a detector that flags the
`correct/` variant is wrong regardless of what it says about `broken/`.

## The rule that makes the measurement honest

Nothing under `test/evaluation/` may tell the code under test which variant it
is looking at. There are no `data-broken` attributes, no filename checks in the
harness's assertions, and no fixture ids in detector logic. The harness knows
which variant it loaded because it chose the directory; the executor, healer and
verdict logic do not.

## The seeded defects

| Page | Scenario | Seeded defect in `broken/` |
|---|---|---|
| `save.html` | Save persistence | The success banner appears; the value is never written to storage |
| `api.html` | Failed backend response | The request returns 500; the UI still shows "Saved" |
| `validate.html` | Invalid form submission | An invalid email is accepted and submitted |
| `delayed.html` | Delayed rendering | The content never arrives (the timer is never started) |
| `selector.html` | Changed selector | `#submit-order` was renamed to `#place-order` |
| `modal.html` | SPA modal | The modal opens but its form fields are never inserted |
| `session.html` | Session interruption | The session drops mid-flow and the app shows a success state anyway |
| `journey-*.html` | Multipage journey | Step 2 loses the value carried from step 1 |

## Serving it

The harness reads these files from disk; no server is required for the
deterministic tier. A real-browser tier serves the directory over plain HTTP —
see `test/evaluation/README.md`.
