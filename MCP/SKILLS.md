# Pathfinder MCP — Tool Reference & Examples

19 tools across 6 groups. Every example assumes the server is connected via Claude Desktop or any MCP client.

---

## Tool Groups

| # | Group | Count | Tools |
|---|-------|-------|-------|
| 1 | [Core Test Execution](#1-core-test-execution) | 3 | `run_one_liners`, `run_csv`, `expand_tests` |
| 2 | [Knowledge Base (RAG)](#2-knowledge-base-rag) | 4 | `crawl_knowledge`, `export_knowledge`, `import_knowledge`, `clear_knowledge` |
| 3 | [App Exploration](#3-app-exploration) | 4 | `explore_app`, `export_explore`, `import_explore`, `clear_explore` |
| 4 | [Flows & Results](#4-flows--results) | 4 | `learn_flows`, `get_flows`, `get_graph`, `get_results` |
| 5 | [Authentication](#5-authentication) | 2 | `capture_auth`, `import_chrome_cookies` |
| 6 | [Agent Memory](#6-agent-memory) | 2 | `remember`, `recall` |

---

## 1. Core Test Execution

### `run_one_liners`
Expand plain-English test descriptions into full execution plans and run them against a live app. Returns an HTML report.

```
Run these tests against https://app.example.com:
- User can log in with valid credentials
- User sees an error when entering a wrong password
- User can reset their password via email
- New user can complete signup and reach the dashboard
- User can update their profile name and save changes
```

**With auth (pre-authenticated session):**
```
Run these tests against https://app.example.com using the saved auth state at /tmp/auth.json:
- Admin can create a new user
- Admin can deactivate an existing account
- Admin can export the user list as CSV
```

**Watch the browser run (headless=false):**
```
Run this test against https://app.example.com with headless=false so I can watch:
- User completes the onboarding wizard
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `test_cases` | required | Array of one-liner test descriptions |
| `target_url` | required | Base URL of the app under test |
| `batch_size` | 3 | Tests expanded in parallel per AI batch (1–5) |
| `concurrency` | 3 | Max simultaneous browser contexts (1–4) |
| `headless` | true | Set false to watch the browser |
| `shared_context` | — | Extra context injected into every expansion prompt |
| `storage_state_path` | — | Path to a Playwright `storageState.json` for auth |

---

### `run_csv`
Run tests from CSV content — useful for importing test suites from spreadsheets or CI pipelines.

**Plain text (one test per line):**
```
Run this CSV against https://shop.example.com:

User can add a product to cart
User can apply a discount code
User can complete checkout with a credit card
Guest user can browse without logging in
```

**Structured CSV with headers:**
```
Run this CSV against https://shop.example.com:

title,type,start_url
User can filter products by category,positive,https://shop.example.com/products
Cart total updates when quantity changes,positive,https://shop.example.com/cart
Checkout fails when card number is invalid,negative,https://shop.example.com/checkout
```

**Expand only (preview steps without running):**
```
Expand this CSV against https://shop.example.com with mode=expand:

User can search for a product
User can sort results by price
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `csv_content` | required | Raw CSV text |
| `target_url` | required | Base URL |
| `mode` | `run` | `run` to execute, `expand` to generate steps only |
| `batch_size` | 3 | Expansion parallelism (1–5) |
| `concurrency` | 3 | Browser parallelism (1–4) |
| `headless` | true | Show/hide browser |
| `storage_state_path` | — | Path to auth state JSON |

---

### `expand_tests`
Generate detailed step-by-step test cases from one-liners without running them. Use to preview what the executor will do before committing to a full run.

```
Expand these tests for https://crm.example.com (don't run them):
- Sales rep can create a new lead
- Sales rep can convert a lead to a deal
- Manager can view the team pipeline report
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `test_cases` | required | One-liner descriptions |
| `target_url` | — | Provides URL context for expansion |
| `batch_size` | 3 | Expansion parallelism (1–5) |

---

## 2. Knowledge Base (RAG)

The knowledge base stores crawled documentation as vector embeddings. The planner queries it before generating test steps — better docs mean better plans.

### `crawl_knowledge`
Crawl a documentation site and index it for RAG-augmented test planning.

```
Crawl the docs at https://docs.example.com with depth=3 and max_pages=80
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | Starting URL to crawl |
| `depth` | 3 | Max link-follow depth (1–5) |
| `max_pages` | 50 | Page crawl limit (1–200) |

---

### `export_knowledge`
Export the full knowledge base as JSON. Use to back it up or transfer it to another environment.

```
Export the knowledge base
```

```
Export the knowledge base to /tmp/knowledge.json
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `file_path` | — | Absolute path to save the JSON file. If omitted, JSON is returned inline. |

---

### `import_knowledge`
Import a previously exported knowledge base. Replaces the current knowledge — useful for seeding a new environment without re-crawling.

```
Import knowledge base from /tmp/knowledge.json
```

```
Import this knowledge base: <paste JSON from export_knowledge>
```

**Parameters (provide one):**
| Parameter | Description |
|-----------|-------------|
| `file_path` | Absolute path to the exported JSON file — preferred for large exports |
| `knowledge_json` | Inline JSON string from `export_knowledge` |

---

### `clear_knowledge`
Wipe all crawled documents and vectors. Use before re-crawling a site that has changed significantly.

```
Clear the knowledge base
```

No parameters.

---

## 3. App Exploration

Exploration maps the app's pages, forms, navigation links, and modals by autonomously clicking through it. The resulting interaction graph powers smarter test planning.

### `explore_app`
Autonomously browse a web app and record everything: pages visited, forms found, navigation paths, modal triggers, form submission outcomes.

```
Explore https://app.example.com starting from the homepage with depth=3 and max_pages=40
```

**Watch it explore:**
```
Explore https://staging.example.com with headless=false so I can watch what it finds
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | Starting URL |
| `depth` | 3 | Max navigation depth (1–5) |
| `max_pages` | 50 | Max pages to visit (1–100) |
| `headless` | true | Set false to watch exploration |

---

### `export_explore`
Export the interaction graph as JSON. Use to reuse a staging exploration against production without re-exploring.

```
Export the exploration graph
```

```
Export the exploration graph to /tmp/graph.json
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `file_path` | — | Absolute path to save the JSON file. If omitted, JSON is returned inline. |

---

### `import_explore`
Import an exploration graph from another environment. Lets you run tests against production using a graph built from staging.

```
Import exploration graph from /tmp/graph.json
```

```
Import this exploration graph: <paste JSON from export_explore>
```

**Parameters (provide one):**
| Parameter | Description |
|-----------|-------------|
| `file_path` | Absolute path to the exported JSON file — preferred for large graphs |
| `explore_json` | Inline JSON string from `export_explore` |

---

### `clear_explore`
Delete the interaction graph. Use before re-exploring after a major UI redesign.

```
Clear the exploration graph
```

No parameters.

---

## 4. Flows & Results

### `learn_flows`
Analyse the exploration graph with AI to extract named user workflows — e.g. "User Registration", "Checkout Flow". These flows inform test expansion with realistic step sequences.

```
Learn flows from the current exploration data
```

No parameters. Requires a populated interaction graph (`explore_app` must have run first).

---

### `get_flows`
Retrieve all learned workflows in human-readable format.

```
Show me all the learned flows
```

No parameters. Returns each flow with its name, description, steps, and start URL.

---

### `get_graph`
Retrieve the exploration graph in human-readable format — pages visited, forms found, navigation edges, modals discovered.

```
Show me the exploration graph
```

No parameters.

---

### `get_results`
Retrieve the full results and HTML report for a past run by its run ID. Run IDs are returned by `run_one_liners` and `run_csv`.

```
Get results for run_abc123
```

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `run_id` | Run ID from a previous `run_one_liners` or `run_csv` response |

---

## 5. Authentication

Tests that require a logged-in user need a **Playwright storageState file** — a JSON snapshot of cookies and localStorage that Playwright injects into the browser before the test starts. There are two ways to create one:

### Which method should I use?

```
Are you already logged in to the app in Chrome right now?
│
├── YES → try import_chrome_cookies first (fastest, zero re-login)
│         If it reports "all cookies encrypted" → fall back to capture_auth
│
└── NO  → use capture_auth
          A browser window opens, you log in once, session is saved forever
```

---

### Step-by-step: `capture_auth`

Opens a **real visible browser window** on your screen. You log in manually — works with anything: SSO, OAuth, 2FA, CAPTCHA, magic links.

**Step 1 — Capture the session**

```
Capture auth for https://app.example.com/login
Save to /tmp/auth.json
Wait for URL containing "/dashboard"
```

What happens:
1. A Chrome window opens at `https://app.example.com/login`
2. You log in exactly as you normally would
3. Once the URL contains `/dashboard` the tool detects success
4. All cookies + localStorage are saved to `/tmp/auth.json`
5. The browser closes

**If your app doesn't redirect after login** (e.g. it uses a modal or token refresh), omit `wait_for_url` and set a generous timeout instead:

```
Capture auth for https://app.example.com/login
Save to /tmp/auth.json
Timeout: 180 seconds
```

The tool will wait for any URL change, or save whatever session exists when the timeout elapses.

**Step 2 — Use the session in test runs**

```
Run these tests against https://app.example.com
storage_state_path: /tmp/auth.json
- Admin can view all users
- Admin can create a new account
- Admin can export the billing report
```

The session file is reused across all concurrent test workers — each worker gets its own isolated copy of the cookies so tests cannot interfere with each other.

**Step 3 — Refresh the session when it expires**

Sessions expire. When tests start failing with "not logged in" errors, just re-run `capture_auth`:

```
Capture auth for https://app.example.com/login → /tmp/auth.json
Wait for "/dashboard"
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `url` | required | Login page URL |
| `save_path` | required | Absolute path to write the session JSON (e.g. `/tmp/auth.json`) |
| `wait_for_url` | — | URL substring that signals successful login (e.g. `/dashboard`). Omit to detect any URL change. |
| `timeout_seconds` | 120 | Seconds to wait for login before timing out (10–600) |

---

### Step-by-step: `import_chrome_cookies`

Reads cookies directly from your **existing Chrome/Brave/Arc profile** — no re-login at all. Useful when you are already logged in to the app in your browser.

**Step 1 — Close Chrome** (required on macOS/Windows to release the cookie database lock)

**Step 2 — Import cookies**

```
Import Chrome cookies for app.example.com and save to /tmp/auth.json
```

Or without a domain filter (imports all cookies from all sites):

```
Import all Chrome cookies to /tmp/auth.json
```

**Step 3 — Check the result**

The tool reports how many cookies were imported and how many were skipped due to encryption:

```
Chrome cookies imported: 12 cookies, 3 skipped (encrypted)
Saved to: /tmp/auth.json
```

If the count shows `0 imported, N skipped (encrypted)` — Chrome encrypted all the session cookies. Use `capture_auth` instead.

**Step 4 — Use the session exactly like capture_auth output**

```
Run these tests against https://app.example.com
storage_state_path: /tmp/auth.json
- User can view their dashboard
- User can update account settings
```

> **Why are cookies encrypted?** On macOS and Windows, Chrome protects session cookies (the ones that keep you logged in) with the OS keychain / DPAPI. This is a security feature — it means even if someone reads the cookie database file, they cannot steal your sessions. Persistent "remember me" cookies are usually unencrypted and will import successfully.

**Requires `better-sqlite3`** (not installed by default):
```bash
npm install better-sqlite3
```

**Parameters:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| `save_path` | required | Absolute path to write the session JSON |
| `domain_filter` | — | Only import cookies matching this domain (e.g. `example.com`). Omit for all. |
| `profile` | `Default` | Chrome profile folder name (check `chrome://version` → Profile Path) |

---

### Multiple roles / tenants

Save separate session files for each role and pass the right one per test run:

```
# Capture admin session
capture_auth: url=https://app.example.com/login, save_path=/tmp/admin.json
              wait_for_url=/admin/dashboard

# Capture regular user session
capture_auth: url=https://app.example.com/login, save_path=/tmp/user.json
              wait_for_url=/dashboard

# Run admin tests
run_one_liners: storage_state_path=/tmp/admin.json
  - Admin can manage users
  - Admin can view audit log

# Run user tests
run_one_liners: storage_state_path=/tmp/user.json
  - User can edit their profile
  - User cannot access admin settings
```

---

## 6. Agent Memory

The memory store persists facts across runs. The self-healer reads selector memories automatically (Strategy 0). You can also write and query it manually.

### `remember`
Store a persistent key/value memory entry tagged with a category.

**Record a known selector fix:**
```
Remember: key="login_submit_btn", value="#submit-login", category=selector_heal
```

**Record a known-slow page:**
```
Remember: key="https://app.example.com/reports/annual", value="load_time_p95=12000ms", category=timing_profile
```

**Record a tenant quirk:**
```
Remember: key="acme_tenant_auth", value="ACME tenant requires 2FA — use bypass header X-Test-OTP: 123456", category=tenant_quirk
```

**Record a known test outcome:**
```
Remember: key="checkout_guest_flow_v2", value="passes on Chrome, fails on Safari due to date picker", category=test_outcome
```

**Parameters:**
| Parameter | Options | Description |
|-----------|---------|-------------|
| `key` | any string | Lookup key |
| `value` | any string | Value to store |
| `category` | `selector_heal` `step_pattern` `tenant_quirk` `timing_profile` `test_outcome` | Tag for filtering |

---

### `recall`
Search stored memories by keyword or category name.

**Find all selector fixes:**
```
Recall: selector_heal
```

**Find everything about the login page:**
```
Recall: login
```

**Find tenant-specific quirks:**
```
Recall: tenant_quirk
```

**Parameters:**
| Parameter | Description |
|-----------|-------------|
| `query` | Free-text keyword or exact category name |

---

## End-to-End Workflow Examples

### Workflow A — Full onboarding for a new app
```
# 1. Index the docs for RAG-augmented planning
crawl_knowledge:
  url: https://docs.myapp.com
  depth: 3
  max_pages: 100

# 2. Map the app
explore_app:
  url: https://staging.myapp.com
  depth: 4
  max_pages: 60

# 3. Extract user flows from the graph
learn_flows

# 4. Preview what the executor will do
expand_tests:
  test_cases: ["User can sign up", "User can log in", "User can reset password"]
  target_url: https://staging.myapp.com

# 5. Run the suite
run_one_liners:
  test_cases: ["User can sign up", "User can log in", "User can reset password"]
  target_url: https://staging.myapp.com
  concurrency: 3
```

---

### Workflow B — CI regression run from CSV
```
# 1 (once, on staging). Export the exploration graph
export_explore  →  save output to graph.json

# 2. On CI: import the saved graph
import_explore:
  explore_json: <contents of graph.json>

# 3. Run the CSV regression suite
run_csv:
  csv_content: |
    title,type,start_url
    User can log in,positive,https://preview.myapp.com/login
    Cart checkout completes,positive,https://preview.myapp.com/cart
    Invalid card is rejected,negative,https://preview.myapp.com/checkout
  target_url: https://preview.myapp.com
  concurrency: 4

# 4. Fetch full HTML report
get_results:
  run_id: <run ID from step 3>
```

---

### Workflow C — Authenticated test run
```
# 1. Capture session (browser window opens, you log in manually)
capture_auth:
  url: https://app.myapp.com/login
  save_path: /tmp/admin.json
  wait_for_url: /dashboard

# 2. Run authenticated tests — no login step needed in the tests themselves
run_one_liners:
  test_cases:
    - Admin can create a new user account
    - Admin can view the billing dashboard
    - Admin can export audit logs as CSV
  target_url: https://app.myapp.com
  storage_state_path: /tmp/admin.json
  concurrency: 3

# 3. When the session expires, just re-run step 1
```

---

### Workflow D — Multi-role authenticated testing
```
# Capture admin session
capture_auth:
  url: https://app.myapp.com/login
  save_path: /tmp/admin.json
  wait_for_url: /admin

# Capture regular user session (open a fresh incognito-style window)
capture_auth:
  url: https://app.myapp.com/login
  save_path: /tmp/user.json
  wait_for_url: /dashboard

# Run admin tests
run_one_liners:
  storage_state_path: /tmp/admin.json
  test_cases:
    - Admin can view all user accounts
    - Admin can deactivate a user
    - Admin can access the billing section

# Run user tests
run_one_liners:
  storage_state_path: /tmp/user.json
  test_cases:
    - User can edit their profile
    - User cannot access /admin (gets 403)
    - User can view their own order history
```

---

### Workflow E — Portable knowledge and exploration across environments
```
# Build knowledge on staging once
crawl_knowledge: url=https://docs.myapp.com
explore_app: url=https://staging.myapp.com
learn_flows

# Export both artifacts
export_knowledge  →  save to knowledge.json
export_explore    →  save to graph.json

# Seed production environment without re-crawling
import_knowledge: knowledge_json=<knowledge.json>
import_explore:   explore_json=<graph.json>

# Run production tests — planner uses staging knowledge + graph
run_one_liners:
  test_cases: ["User can complete checkout", "User can cancel an order"]
  target_url: https://prod.myapp.com
```

---

### Workflow F — Inspect state without running tests
```
# What pages and forms did exploration find?
get_graph

# What workflows were extracted?
get_flows

# What does the agent already know?
recall: selector_heal
recall: tenant_quirk

# Check results from a previous run
get_results: run_id=run_20260323_abc123
```
