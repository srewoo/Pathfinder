# Pathfinder

**AI Autonomous QA Engineer in your browser.** Crawl, explore, learn, generate, and execute tests — automatically.

Pathfinder is a Chrome extension that turns any web application into a fully tested product. Point it at your app, let it explore, and it generates and runs real end-to-end tests — no test scripts, no infrastructure, no Selenium grid.

---

## Objective

Eliminate the manual effort of writing, maintaining, and debugging browser-based end-to-end tests. Pathfinder gives every team — from solo developers to enterprise QA departments — an autonomous testing agent that lives in the browser, understands the application it's testing, and heals its own tests when the UI changes.

---

## The Problem

End-to-end testing is broken:

- **Writing tests is slow.** A single E2E test takes 30-60 minutes to author — locating selectors, handling async waits, managing test data, writing assertions.
- **Tests are fragile.** A single CSS class rename or layout change breaks dozens of tests. Teams spend more time fixing tests than writing features.
- **Infrastructure is heavy.** Playwright, Cypress, and Selenium require CI pipelines, Docker containers, headless browsers, and dedicated DevOps effort to run reliably.
- **Coverage is sparse.** Most teams only automate 10-20% of their test cases because the cost of writing and maintaining E2E tests is too high. The rest stays in spreadsheets as manual QA.
- **No application awareness.** Traditional tools record or script against raw DOM — they don't understand what the app does, what forms exist, or how pages connect.

The result: teams ship with either insufficient test coverage or unsustainable maintenance costs.

---

## The Solution

Pathfinder is an **AI-native testing agent** that runs entirely inside Chrome. It:

1. **Crawls your documentation** to understand your product (Knowledge Base)
2. **Explores your application** autonomously to map pages, forms, navigation, and modals (Explorer)
3. **Learns user workflows** from the exploration data and documentation (Flow Learning)
4. **Generates test cases** — positive, negative, and edge — grounded in real application data (Test Generation)
5. **Executes tests** against live pages with retry logic and self-healing selectors (Execution Engine)
6. **Reports results** with detailed step-by-step breakdowns, screenshots, and CI/CD-compatible exports (Results)

No backend. No cloud infrastructure. No test scripts. Just a Chrome extension and an LLM API key.

---

## Features

### Knowledge Base
- Automated site crawling with configurable depth (1-5 levels) and page limits
- Content extraction, semantic chunking (512-1024 tokens with overlap), and vector embedding
- **Local embeddings (free)** via Transformers.js all-MiniLM-L6-v2 — no API cost for indexing
- Optional vision LLM analysis of screenshots and images in documentation
- RAG-powered context injection into every AI operation
- Export/import knowledge bases as JSON for team sharing

### Explorer
- Autonomous breadth-first exploration of any web application
- Discovers pages, forms, modals, navigation paths, and interactive elements
- Captures form field metadata: types, constraints (required, minLength, maxLength, pattern), options, and CSS selectors
- **Read-only by default** — maps forms and fields without submitting. Form/modal submission (which mutates the live app with test data) is opt-in via `submitForms`; use only against a sandbox account.
- Records form submission outcomes — success messages, error messages, validation states (when `submitForms` is enabled)
- Builds an **Interaction Graph** (pages as nodes, navigation as edges) used by all downstream features
- Runs in a **dedicated background tab** so your active tab stays usable
- On a mid-run auth-wall, attempts session recovery via an execution preset instead of aborting
- Configurable depth (1-5 levels), max pages, and per-page exploration budget (default 90s, configurable)

### Flow Learning
- AI-powered extraction of user workflows from exploration data + documentation
- Classifies flows as exploration-sourced, documentation-sourced, or hybrid
- Infers start URLs with confidence scoring (high/medium/low)
- One-click test generation from any learned flow

### Test Generation

**One-Line Runner** — paste natural language test descriptions, one per line:
```
User can sign in with valid credentials
Login shows an error for wrong password
Admin can create a new project
```
Pathfinder expands each line into a detailed, executable test plan with real selectors, real URLs, and realistic test data — all grounded in the application map and knowledge base.

**Flow-Based Generation** — generates 5+ test cases per workflow (positive, negative, edge cases) with field-constraint-aware test data.

**Structured Import** — import test cases from JSON files with schema validation.

### Test Execution Engine
- Converts plain-text test steps into executable browser actions via AI planning
- **Supported actions:** click, type, select, check/uncheck, scroll, hover, drag-drop, file upload, keyboard shortcuts, dialog handling, conditional logic, loops, value capture
- **Dual execution modes:** Content script events (fast) or Chrome DevTools Protocol trusted events (reliable)
- **Three-attempt retry:** original plan → doubled timeouts → fresh re-plan
- **Self-healing selectors:** DOM similarity matching → attribute-based generation → AI regeneration
- **Authentication management:** Cookie capture/injection, session verification, auto-re-login
- **Preflight checks:** Tab availability, content script health, auth state, cross-origin detection
- Concurrent execution (1-4 tests in parallel, each in its own tab)

### Execution Presets
- Reusable personas with auth context (e.g., "Admin User", "Free Tier Customer")
- Captured auth cookies for session restoration
- Setup steps executed before every test in the preset
- Bind any test to a preset for consistent execution context

### Record and Replay
- Capture real user interactions directly in the browser
- Generates reliable CSS selectors (data-testid > id > aria-label > name > DOM path)
- Converts recorded actions to executable test steps

### Results and Reporting
- Pass/fail/error dashboard with duration and healing metrics
- Step-by-step execution timeline with error messages and screenshots
- **Export formats:** JSON, HTML (viewable in browser), JUnit XML (CI/CD compatible)
- Webhook notifications for CI/CD integration (per-test or per-suite)

### AI Provider Support
| Provider | Chat Models | Embedding |
|----------|------------|-----------|
| **OpenAI** | GPT-4o, GPT-4 Turbo | text-embedding-3-small/large |
| **Anthropic** | Claude 3.5 Sonnet, Claude 3 Opus | API fallback |
| **Google** | Gemini 2.0 Flash, Gemini Pro | text-embedding-004 |
| **Local** | — | all-MiniLM-L6-v2 (free, offline) |

---

## How to Use

### Installation
1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Build the extension:
   ```bash
   npm run build
   ```
3. Open Chrome → `chrome://extensions` → Enable Developer Mode → **Load unpacked** → select the `dist/` folder.

### Setup
1. Click the Pathfinder icon in Chrome to open the side panel.
2. Go to **Settings** (gear icon) and configure:
   - **AI Provider:** Choose OpenAI, Anthropic, or Google
   - **API Key:** Enter your LLM API key
   - **Embedding:** Local (free) is selected by default — no extra config needed

### Workflow

**Step 1: Build Knowledge (optional but recommended)**
- Navigate to your product's documentation site
- Open the **Knowledge** tab → enter the docs URL → click **Crawl**
- Pathfinder indexes the content for RAG-powered test generation

**Step 2: Explore Your App**
- Navigate to your application's landing page
- Open the **Explore** tab → set depth (2-3 is typical) → click **Start Exploration**
- Pathfinder autonomously clicks through the app, mapping pages, forms, and navigation

**Step 3: Learn Flows**
- Open the **Flows** tab → click **Learn Flows**
- Pathfinder extracts user workflows from the exploration data and documentation

**Step 4: Generate Tests**

*Option A — One-Line Runner:*
- Open the **Tests** tab → switch to **One-Line Runner**
- Type test descriptions (one per line) → click **Expand and Run**

*Option B — From Flows:*
- Open the **Flows** tab → click **Generate Tests** on any flow

*Option C — Import:*
- Open the **Tests** tab → click **Import** → paste or upload a JSON file

**Step 5: Run Tests**
- Open the **Tests** tab → select tests → click **Run Selected** (or **Run All**)
- Watch live step-by-step execution in the **Results** tab

**Step 6: Review Results**
- Open the **Results** tab for pass/fail dashboard and detailed failure analysis
- Export as JSON, HTML, or JUnit XML for CI/CD

---

## Who Benefits from Pathfinder

| Role | How Pathfinder Helps |
|------|-------------------|
| **Solo developers / indie hackers** | Get E2E test coverage without writing test code or setting up CI infrastructure. Just explore and generate. |
| **Startup engineering teams** | Ship faster with confidence. Generate tests from one-liners during sprint planning, run them before every deploy. |
| **Manual QA engineers** | Convert your spreadsheet test cases into automated tests instantly. Paste your manual checks into the One-Line Runner. |
| **QA leads and managers** | Increase automation coverage from 10-20% to 80%+ without hiring more automation engineers. |
| **Frontend developers** | Catch regressions in minutes, not days. Self-healing selectors mean tests survive your CSS refactors. |
| **Product managers** | Write test cases in plain English ("User can create a project") and have them execute as real browser tests. |
| **DevOps / Platform teams** | JUnit XML export and webhook notifications integrate directly into existing CI/CD pipelines. |
| **Enterprise QA departments** | Reduce test maintenance costs by 60-80%. Self-healing eliminates the #1 cost driver: brittle selectors. |

---

## Cost Analysis

### Pathfinder vs. Traditional E2E Tools

| Dimension | Pathfinder | Playwright / Cypress | Selenium Grid | Cloud Testing (BrowserStack, LambdaTest) |
|-----------|---------|---------------------|---------------|------------------------------------------|
| **Test authoring** | AI-generated from one-liners or exploration. Minutes per test. | Hand-written code. 30-60 min per test. | Hand-written code. 30-60 min per test. | Hand-written or recorded. 20-45 min per test. |
| **Infrastructure** | None. Runs in Chrome. | Local or CI runner. Docker for parallelism. | Selenium Hub + browser nodes. Significant DevOps. | Cloud-hosted. Managed but vendor-locked. |
| **Maintenance** | Self-healing selectors. Near-zero maintenance. | Manual selector updates on every UI change. | Same as Playwright + grid maintenance. | Manual selector updates + vendor dashboard management. |
| **CI/CD integration** | JUnit XML export + webhooks. Drop-in. | Native. Excellent CI support. | Native but complex to configure. | API-based. Good but vendor-specific. |
| **Learning curve** | Paste one-liner. Click run. | Learn Playwright API, async patterns, selectors. | Learn Selenium API + grid setup + Docker. | Learn vendor API + dashboard + plan limits. |
| **Parallel execution** | 1-4 concurrent tabs (local). | Unlimited with CI workers. | Unlimited with grid nodes. | Unlimited (pay per parallel session). |
| **Application awareness** | Full — knows pages, forms, fields, navigation, docs. | None — works against raw DOM. | None. | None (some offer AI selectors but no app model). |

### Cost Breakdown

| Cost Category | Pathfinder | Playwright MCP / Playwright | Selenium | Cloud Testing |
|--------------|---------|---------------------------|----------|---------------|
| **Tool license** | Free (open source) | Free (open source) | Free (open source) | $29-$499+/month |
| **LLM API cost** | ~$0.01-0.05 per test generation (GPT-4o). ~$0.002 per healing attempt. Local embeddings are free. | N/A (no AI) or ~$0.01-0.10 per MCP call if using AI | N/A | Included or N/A |
| **Infrastructure** | $0 (runs in browser) | $0 local / $50-500/mo CI runners | $100-1000/mo for grid | $29-499/mo per plan |
| **Engineering time (authoring)** | ~5 min/test (one-liner + review) | ~45 min/test (code + debug) | ~45 min/test | ~30 min/test |
| **Engineering time (maintenance)** | ~0 (self-healing) | ~15 min/test/month (selector fixes) | ~15 min/test/month | ~10 min/test/month |
| **Headcount** | 0 dedicated automation engineers needed | 1-3 automation engineers | 1-3 + DevOps for grid | 1-2 automation engineers |

### Example: 200 Test Cases

| Metric | Pathfinder | Playwright | Selenium Grid | BrowserStack |
|--------|---------|-----------|---------------|-------------|
| **Initial authoring** | ~17 hours | ~150 hours | ~150 hours | ~100 hours |
| **Monthly maintenance** | ~2 hours | ~50 hours | ~50 hours + infra | ~33 hours |
| **Monthly infra cost** | ~$5 (LLM API) | ~$200 (CI runners) | ~$500 (grid) | ~$199 (plan) |
| **Annual total cost** | ~$84 (API) + 41 eng-hours | ~$2,400 (infra) + 750 eng-hours | ~$6,000 (infra) + 750 eng-hours | ~$2,388 (license) + 496 eng-hours |

*Engineering hour costs not included — multiply by your loaded rate ($75-200/hr) for full comparison.*

### Pathfinder vs. Playwright MCP (AI-Assisted)

Playwright MCP adds AI capabilities to Playwright via Model Context Protocol. Key differences:

| Aspect | Pathfinder | Playwright MCP |
|--------|---------|---------------|
| **Setup** | Install extension. Enter API key. Done. | Install Playwright + MCP server + configure AI provider + write connection code. |
| **Application model** | Builds a persistent graph of your app (pages, forms, nav). Reuses across test runs. | No persistent app model. Each session starts fresh. |
| **Knowledge integration** | Crawls your docs, indexes them, uses RAG in every AI call. | No documentation awareness. Relies on prompt context only. |
| **Self-healing** | Three-strategy pipeline (DOM similarity → attribute selectors → AI). Runs automatically on failure. | Depends on MCP implementation. Typically requires re-prompting. |
| **Test persistence** | Tests saved in IndexedDB. Re-run anytime. Export to JUnit XML. | Tests are ephemeral prompts unless you save them as code. |
| **Execution presets** | Auth personas, setup steps, cookie management built-in. | Manual session management per test. |
| **Cost per test run** | ~$0.01-0.05 (planning + healing if needed). Cached plans are free. | ~$0.05-0.20 per run (every run requires AI planning — no caching). |

---

## Future Scope

### Near-Term
- **Visual regression testing** — pixel-diff screenshots between test runs to catch unintended UI changes
- **API contract testing** — leverage the OpenAPI parser to validate API responses alongside UI tests
- **Test case prioritization** — AI-powered risk scoring to run the most important tests first
- **Scheduled test runs** — cron-based execution with automatic result notifications

### Mid-Term
- **Multi-browser support** — extend beyond Chrome to Firefox and Edge via WebDriver BiDi
- **Team collaboration** — shared knowledge bases, test libraries, and execution presets via cloud sync
- **Natural language test editing** — modify existing tests by describing changes in plain English
- **Flaky test detection** — statistical analysis of test results to identify and quarantine unreliable tests
- **Performance metrics capture** — Core Web Vitals (LCP, INP, CLS) measured during test execution

### Long-Term
- **Autonomous regression agent** — continuous background testing that detects regressions as code is deployed
- **Test impact analysis** — map code changes to affected test cases using git diff + application graph
- **Cross-application testing** — test workflows that span multiple services (e.g., admin panel + customer portal)
- **Self-improving test suite** — feedback loops where test failures refine the application model and generate better tests over time
- **On-premise LLM support** — run with local models (Llama, Mistral) for organizations that cannot send data to external APIs

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Chrome Extension (Manifest V3) |
| **Language** | TypeScript (ES2023, strict mode) |
| **UI** | React 18, Zustand, TailwindCSS |
| **Build** | Vite 5 + @crxjs/vite-plugin |
| **AI** | OpenAI, Anthropic, Google (multi-provider) |
| **Local ML** | Transformers.js (all-MiniLM-L6-v2) |
| **Storage** | IndexedDB (8 stores), Chrome Storage API |
| **Browser Automation** | Content Scripts + Chrome DevTools Protocol |
| **Testing** | Vitest, Playwright |

---

## Project Structure

```
pathfinder/
├── src/
│   ├── background/       # Service worker — orchestrates all operations
│   ├── content/          # Content scripts — DOM actions, element detection
│   ├── core/
│   │   ├── ai/           # LLM providers (OpenAI, Anthropic, Google, local)
│   │   ├── knowledge/    # Crawler, extractor, chunker, embedder, vector search
│   │   ├── explorer/     # Autonomous UI exploration, interaction graph
│   │   ├── flow/         # Workflow learning and persistence
│   │   ├── test-gen/     # Test generation, import, expansion
│   │   ├── planner/      # Test → execution plan conversion with caching
│   │   ├── executor/     # Test runner, auth manager, preflight, webhooks
│   │   ├── healing/      # Self-healing selectors (3-strategy pipeline)
│   │   ├── cdp/          # Chrome DevTools Protocol client
│   │   ├── recorder/     # User interaction recording
│   │   └── openapi/      # API spec parsing
│   ├── storage/          # IndexedDB, Chrome Storage, schemas
│   ├── messaging/        # Type-safe IPC between extension components
│   ├── sidepanel/        # React UI (components + Zustand stores)
│   └── utils/            # Logging, hashing, reporting, DOM utilities
├── test/                 # Unit, integration, and E2E tests
├── manifest.json         # Extension configuration
├── vite.config.ts        # Build configuration
└── package.json
```

---

## License

[Add your license here]
