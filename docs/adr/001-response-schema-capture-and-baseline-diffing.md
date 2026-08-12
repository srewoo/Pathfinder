# ADR 001 — Response schema capture and baseline diffing

**Status:** accepted — phases 1–4 implemented
**Context:** API Contracts can only validate against an uploaded OpenAPI spec. Without
one it now compares traffic against itself (`observed-contract.ts`), but cannot check
field names, types or required-ness, because response bodies are never captured.

---

## The decision that shapes everything else

**Persist inferred schemas, not bodies.**

Bodies are read transiently in memory, converted to a schema, and dropped. Only the
schema is stored.

This is not a storage optimisation — it is what makes the feature shippable:

- **Privacy.** A baseline cannot leak what it never stored. Response bodies contain
  session tokens, email addresses, salary figures, customer records. CLAUDE.md §12.2
  forbids persisting exactly that, and the state-diff oracles already set the
  precedent by never capturing password or hidden-input values.
- **Storage.** A schema for a 400KB employee list is a few hundred bytes. Results
  already carry screenshots and screencast frames; adding raw bodies would multiply
  result size by the payload of every API the tests touch.
- **Diffability.** Two bodies differ on every run (ids, timestamps, ordering). Two
  schemas differ only when the *contract* changed, which is the signal we want.

Raw-body retention becomes a separate, explicitly opt-in debug mode (Phase 4), off by
default, with redaction and a short TTL.

---

## What already exists (verified, not assumed)

| Fact | Location | Consequence |
|---|---|---|
| **Request** bodies ARE captured, 10KB cap | `cdp-client.ts` → `Network.enable { maxPostDataSize: 10240 }` → `HAREntry.requestBody` | Request-side schema diffing is nearly free |
| …and are **discarded at persistence** | `test-executor.ts:168` projects `HAREntry` onto a 7-field `CapturedNetworkEntry` | The loss is a projection decision, not a capture gap |
| Response bodies are **not** captured | `Network.loadingFinished` is unhandled; only `loadingFailed` is | Additive change, nothing to rework |
| A Response-stage interceptor is **already installed** | `cdp-safety.ts` → `Fetch.enable` with `requestStage: 'Response'` | An alternative capture point exists at zero extra interception cost |
| Traffic analysis without a spec already works | `observed-contract.ts` | Schemas plug into an existing report, not a new tab |

---

## Capture point: two options

### Option A — `Network.loadingFinished` + `Network.getResponseBody` (recommended)

Handle the event that is currently ignored, then fetch the body by `requestId`.

- Keeps `cdp-safety` single-purpose. Safety decides whether a request may proceed;
  it should not also be an evidence collector.
- A failed or slow body fetch cannot stall the page — the response has already been
  delivered to the renderer.
- Costs one async CDP round trip per response we choose to read.
- Risk: the body must be fetched before the session is torn down or the buffer is
  evicted. Mitigated by fetching on the event rather than at teardown.

### Option B — `Fetch.getResponseBody` at the paused Response stage

- No new interception: the pause already happens for the origin policy.
- But the response is **held** until we continue it, so a slow body read delays the
  page under test — turning an analysis feature into a source of flake.
- And it couples the safety gate to schema capture, which is the coupling §7 was
  written to avoid.

**Recommendation: A.** B trades correctness of the thing under test for a saving we
do not need.

---

## Scope by phase

### Phase 1 — Capture and infer (no user-visible change)

- `cdp-client.ts`: handle `Network.loadingFinished`; fetch the body when the entry
  qualifies (see filters); attach `responseSchema` to `HAREntry`.
- New `src/core/analysis/schema-infer.ts` (pure, testable):
  - JSON → schema: `object` with per-key types, `array` with a unified element type,
    primitives, `null` → nullable.
  - Union types where a key varies across samples (`string | null`).
  - Required-ness: a key is required if present in **every** sample of that endpoint.
  - Enum candidates: ≤8 distinct primitive values across samples.
  - Depth cap 6, key cap 200 per object — a pathological payload must not produce a
    pathological baseline.
- `schemas.ts`: `CapturedNetworkEntry.responseSchema?: InferredSchema` — the schema,
  never the body.
- Filters (all must pass to read a body):
  - content type is JSON (`application/json`, `+json`)
  - `bodySize` ≤ 256KB
  - status is 2xx (a 500's HTML error page is not a contract)
  - endpoint is on the project allowlist — never read a third party's payload

**Files:** 3 changed, 1 new, ~250 lines. **Tests:** ~25 (inference, unions,
required-ness, caps, malformed JSON).

### Phase 2 — Baseline and diff

> **Implemented deviation:** baselines live in `chrome.storage.local`, not IndexedDB.
> Same reasoning as `checkpoint-storage.ts` — IndexedDB is reserved for entities, and a
> baseline is one small, frequently-overwritten record per origin. It also avoids a
> schema migration for a store with one row per app.
- Baseline record: `{ origin, capturedAt, label, endpoints: Record<'METHOD /path', { requestSchema?, responseSchema, statuses, sampleCount }> }`.
  Path normalisation reuses `normalizePath` from `observed-contract.ts`.
- **GraphQL:** one URL, many shapes. Key by `operationName` from the request body —
  which we already capture — falling back to a hash of the query string. Without this,
  a GraphQL app produces one meaningless merged schema.
- New `src/core/analysis/schema-diff.ts` (pure):

  | Change | Class | Rationale |
  |---|---|---|
  | Field removed | **breaking** | A consumer reading it now gets `undefined` |
  | Type changed (`string` → `number`) | **breaking** | Parsing or arithmetic breaks silently |
  | Required → optional / nullable introduced | **breaking** | Callers stop being able to rely on it |
  | Enum value removed | **breaking** | A branch becomes unreachable |
  | New optional field | additive | Safe; still reported |
  | New enum value | additive | Safe; worth knowing |
  | Endpoint disappeared | **breaking** | Either removed, or the test stopped reaching it — the report must not guess which |

**Files:** 2 new, 1 changed. **Tests:** ~30 (each class, nested objects, arrays,
GraphQL keying, empty-array ambiguity).

### Phase 3 — Surface it

- API Contracts tab: **Capture baseline** / **Compare with baseline** / **Clear**,
  plus a table of breaking vs additive changes reusing the markdown-table renderer.
- Verdict integration: a breaking change on an endpoint a test exercised downgrades
  that result `PASS → NEEDS_REVIEW`, the same mechanism `verdictWithOracles` already
  uses. A test whose assertions pass while the API's shape broke underneath it is
  exactly the case the oracle work exists for.

**Files:** 2 changed. **Tests:** ~10.

### Phase 4 — Optional raw-body retention (debug only)

Off by default. When enabled: redact by key name (`/token|auth|password|secret|ssn|email|phone/i`)
and by value shape (JWT, long base64, card-like digit runs); cap 32KB per body, 50 bodies
per run; TTL 24h with a hard purge on run delete. Never included in an export.

---

## Risks and honest limits

- **An empty array teaches nothing.** `[]` gives no element type. The schema must
  record `array<unknown>` and the diff must not report `unknown → object` as breaking
  — otherwise the first run with data flags a false break. This is the most likely
  source of noise and needs a dedicated test.
- **Sampling bias.** A schema inferred from one call reflects one code path. Required-ness
  in particular needs several samples to mean anything; below 3 the report should say
  "inferred from 1 sample" rather than assert required-ness.
- **A diff cannot tell removal from non-coverage.** If a test stops reaching an
  endpoint, the endpoint vanishes from the new run. Report as "not observed in this
  run", never as "removed from the API".
- **Non-JSON, streaming, SSE, protobuf** are out of scope and must be stated as such
  in the report, per the existing scope-declaration pattern.
- **`getResponseBody` fails for some responses** (redirects, cached 304s, already-evicted
  buffers). Count and report the misses; a silent skip would let a partial baseline
  look complete.

## Cost

~7 files, ~800 lines, ~65 tests. Phases 1–2 are the substance; Phase 3 is small; Phase 4
is independent and can be dropped entirely.

## Alternatives rejected

- **Persist raw bodies and diff those.** Bodies differ on every run, so every diff is
  noise; and it stores PII to solve a schema problem.
- **Require an OpenAPI spec.** Already the status quo, and the reason this ADR exists:
  most teams either lack a current spec or have one that has drifted from the service.
- **Generate a spec file from traffic.** More moving parts and a file to keep in sync,
  for the same information a stored schema already holds.
