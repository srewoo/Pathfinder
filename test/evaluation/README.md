# Evaluation

Does Pathfinder find the bug, and does it keep quiet when there isn't one?

The unit and integration suites answer "is the code correct". This answers a
different question, and it is deliberately a separate command because the two
should not be confused: a run that reports **7 of 7 defects detected, 0 false
positives** is a measurement, not a pass.

## Commands

| Command | Tier | Needs |
|---|---|---|
| `npm run evaluate` | `deterministic-dom` | Nothing — runs anywhere |
| `npm run evaluate:browser` | `real-browser` | Playwright + Chromium, and a **display** |
| — | `live-model` | Not built. See below. |

No production access is needed for either. The fixtures are local files served
on `127.0.0.1`; no outbound network is used.

The browser tier cannot run headless: a persistent context is the only way to
load an unpacked MV3 extension, and headless Chrome does not start MV3 service
workers. On a headless CI box it needs `xvfb-run`. If it cannot launch, it
**fails** — a tier that did not run must never report success.

### The tier is the driver

Both tiers run the *same* `SCENARIOS` against the *same* fixtures. Only the
`Driver` implementation changes — `JsdomDriver` or `PlaywrightDriver` — and both
call the shipped `evaluateActionability`, so there is one implementation of
actionability across tiers. A different conclusion between them is therefore a
difference in what can be *observed*, never in what was tested.

## The tiers, and what each one entitles you to claim

This distinction is the point. A number is only as good as the tier it came
from, so every report states its tier and carries the caveat inline.

**`mocked`** — hand-built page models (`fake-driver.ts`), used by the unit
suite. Says something about internal consistency and nothing about real HTML.

**`deterministic-dom`** — real fixture HTML in jsdom **with the page scripts
executing**, and the engine under test unstubbed: locator resolution, the
actionability evaluator, the healing ladder, verdict computation. This is what
`npm run evaluate` runs.

It cannot see:

- **layout** — jsdom computes none, so visibility comes from attributes and
  inline styles. An element hidden by a stylesheet rule reads as visible, and
  occlusion and motion-stability cannot be evaluated at all.
- **trusted input** — actions dispatch synthetic events.
- **the real network** — `fetch` is stubbed per scenario.
- **the content script and CDP dispatch** — not exercised at all.

The full list lives in the header of `jsdom-driver.ts`, next to the code that
has the limitation.

**`real-browser`** — a real Chrome page with the built extension loaded,
against the served fixture. Adds what the deterministic tier structurally
cannot see:

- **real layout** — an element hidden by a stylesheet rule, collapsed to zero
  height, or scrolled out of the document is judged correctly;
- **trusted input** — real browser events, so a control that ignores synthetic
  ones behaves as it does for a user;
- **occlusion** — Playwright refuses a click on a covered element;
- **the real network** — requests leave the browser and are answered by the
  fixture server, so a failing response is observed rather than simulated;
- **request interception that actually blocks**, which the deterministic tier
  has to refuse rather than pretend to enforce.

It still does **not** drive the extension's side panel. It exercises the engine
through the `Driver` port against a real browser, and the extension is loaded
(so a manifest or service-worker failure surfaces), but no scenario clicks
through the panel's own UI.

**`live-model`** — a real model generating the tests. Not built. When it is, a
report must record the model id, temperature and relevant settings, the prompt
version identifiers, the fixture version, and the sample size — without those a
model measurement cannot be compared to another one. Unavailable credentials
must report as *skipped*, never as success.

## What is measured

Every scenario runs against **both** variants, so a detection and a false
positive are measured on the same code path. Counts always carry their
denominator; a rate with nothing to divide by is reported as absent, not as 0%
or 100%.

| Measure | Meaning |
|---|---|
| Detected | Flagged the seeded defect in `broken/` |
| Missed | Did not flag it |
| False positives | Flagged `correct/` — **always wrong**, whatever the recall |
| Inconclusive | Reached no conclusion; never counted as either |
| Unstable | Repeats of the same variant disagreed with each other |

Scenarios are tagged `defect-detection` or `healing`. Only the first kind is in
the detection denominator: a renamed selector that the locator ladder recovers
from is a *testability* regression, and the test still passed — counting it as a
missed defect would understate detection, and counting a flag as a detection
would reward crying wolf. Healing scenarios are scored on whether the ladder
reached the control and reported the tier drop.

## The gates

- **Zero false positives.** Never relaxed.
- **Zero scenario crashes.**
- **Zero false clean passes** on the T01/T02 verdict shapes — a stored pass with
  a failed step, a failed generated assertion, and a high-severity oracle
  finding. These are the defects P0 fixed; this is the gate that catches them
  coming back.
- **Detection ≥ the recorded baseline** (7 of 7 on fixtures 1.0.0). Measured,
  not chosen — an earlier draft guessed 8 and the first real run contradicted it
  immediately, which is exactly why the plan requires measuring first.
- **Five repeats minimum** on the timing, healing and session scenarios. This
  exposes gross instability. It does **not** prove flake freedom and is not
  reported as if it did.

## Fixture versioning

`FIXTURE_VERSION` in `harness.ts` is `1.0.0`. A measurement is comparable only
to another taken on the same fixtures, so changing a fixture's behaviour means
bumping it and re-measuring the baseline rather than editing the number to fit.

## Blind spots are excluded, not counted as misses

A scenario can declare `requiresTier`. On any other tier it is **excluded and
reported as excluded**, rather than run and scored as a missed defect — a known
blind spot must not degrade a number that is supposed to mean something.

`css-hidden-confirmation` is the worked example: the confirmation element is in
the DOM, has no `hidden` attribute and no inline style, and is collapsed purely
by a stylesheet rule. jsdom reads it as visible, so the deterministic tier would
report a *working* application as broken. A test asserts that deliberately —
with the exclusion disabled, the deterministic tier does get it wrong — which is
the standing evidence that the real-browser tier is not redundant.

## What remains

The side panel itself is not driven. Completing that needs:

1. Opening `chrome-extension://<id>/src/sidepanel/index.html` as an ordinary
   page — Playwright cannot focus the real panel. That exercises the panel's
   code and messaging while not being the panel's own surface, a difference any
   report produced that way must state.
2. Asserting on what the service worker broadcast. The worker is detected and
   its extension id reported, but nothing listens to it.
3. Re-expressing scenarios against the panel's UI, for the claims that are
   about the product rather than the engine.

The live-model tier is also not built. When it is, a report must record the
model id, temperature and relevant settings, the prompt version identifiers, the
fixture version, and the sample size — without those a model measurement cannot
be compared to another one. Unavailable credentials must report as *skipped*,
never as success.
