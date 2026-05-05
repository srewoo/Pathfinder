# Pathfinder MCP — Quick Start

## 1. Start MySQL

```bash
# First time — create the container
docker run -d \
  --name pathfinder-mysql \
  -e MYSQL_ROOT_PASSWORD=pathfinder \
  -e MYSQL_DATABASE=pathfinder \
  -e MYSQL_USER=pathfinder \
  -e MYSQL_PASSWORD=pathfinder \
  -p 3307:3306 \
  mysql:8.0

# Subsequent starts
docker start pathfinder-mysql
```

## 2. Configure environment

Create a `.env` file in this directory:

```env
# AI provider — pick one
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...

# or OpenAI
# AI_PROVIDER=openai
# OPENAI_API_KEY=sk-...

# MySQL (matches docker run above)
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3307
MYSQL_USER=pathfinder
MYSQL_PASSWORD=pathfinder
MYSQL_DATABASE=pathfinder

# Browser
HEADLESS=true

# Optional
# AI_MODEL=claude-sonnet-4-6
# EMBEDDING_MODEL=text-embedding-3-small
# TEST_CONCURRENCY=3
```

## 3. Build & run

```bash
npm install
npm run build
npm run dev        # watch mode
# or
node --env-file=.env dist/index.js
```

## 4. Connect to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pathfinder": {
      "command": "node",
      "args": [
        "--env-file=/Users/sharajrewoo/DemoReposQA/Pathfinder/MCP/.env",
        "/Users/sharajrewoo/DemoReposQA/Pathfinder/MCP/dist/index.js"
      ]
    }
  }
}
```

Restart Claude Desktop. You will see 19 Pathfinder tools available.

---

## 5. The 19 Tools at a glance

| # | Tool | What it does |
|---|------|-------------|
| 1 | `run_one_liners` | Expand + run plain-English test descriptions |
| 2 | `run_csv` | Run tests from CSV content |
| 3 | `expand_tests` | Preview expanded steps without running |
| 4 | `crawl_knowledge` | Index docs for RAG-augmented planning |
| 5 | `export_knowledge` | Export RAG knowledge base as JSON |
| 6 | `import_knowledge` | Import a saved knowledge base |
| 7 | `clear_knowledge` | Wipe all crawled docs and vectors |
| 8 | `explore_app` | Autonomously map app pages, forms, navigation |
| 9 | `export_explore` | Export the interaction graph as JSON |
| 10 | `import_explore` | Import a saved interaction graph |
| 11 | `clear_explore` | Wipe the interaction graph |
| 12 | `learn_flows` | Extract named user flows from the graph |
| 13 | `get_flows` | Show all learned flows |
| 14 | `get_graph` | Show the exploration graph |
| 15 | `get_results` | Fetch report for a past run by run ID |
| 16 | `capture_auth` | Open browser for manual login, save session to file |
| 17 | `import_chrome_cookies` | Import cookies from existing Chrome profile |
| 18 | `remember` | Write a persistent memory entry |
| 19 | `recall` | Search persistent memories |

See **SKILLS.md** for full parameter docs and copy-paste prompt examples for every tool.

---

## 6. Natural language prompt examples

You don't need to specify exact parameters — just describe what you want and the AI fills in the tool call.

### Explore & learn
```
Explore https://staging.myapp.com up to depth 3
```
```
Learn the user flows from the exploration you just did
```
```
Show me the interaction graph
```

### Run tests
```
Run these tests against https://staging.myapp.com:
- User can log in with valid credentials
- User can reset their password
- New user can complete signup
```
```
Run with headless=false so I can watch the browser
```
```
Get results for run_abc123
```

### Knowledge base
```
Crawl https://docs.myapp.com — depth 3, max 80 pages
```
```
Export the knowledge base so I can back it up
```
```
Clear the knowledge base and re-crawl https://docs.myapp.com
```

### Cross-environment portability
```
Export the exploration graph
```
*(save the JSON output to graph.json)*
```
Import this exploration graph: <paste graph.json contents>
```
```
Now run tests against https://prod.myapp.com using the imported graph
```

### Memory
```
Remember: key="login_submit", value="#submit-login", category=selector_heal
```
```
Recall any memories about selector_heal
```

---

## 7. Recommended workflow for a new app

```
1. crawl_knowledge   →  index your docs
2. explore_app       →  map the app structure
3. learn_flows       →  extract user flows
4. expand_tests      →  preview steps before running
5. run_one_liners    →  execute and get HTML report
6. get_results       →  fetch detailed run report
```

For subsequent runs, skip steps 1–3. The exploration graph and knowledge base persist in MySQL and are reused automatically.

---

## 8. Transferring data between machines

### Interaction graph
```
# Machine A — export
export_explore   →  save JSON to graph.json

# Machine B — import
import_explore: explore_json=<contents of graph.json>
```

### Knowledge base
```
# Machine A — export
export_knowledge →  save JSON to knowledge.json

# Machine B — import
import_knowledge: knowledge_json=<contents of knowledge.json>
```

Both exports include all data needed to run tests on a different environment without re-exploring or re-crawling.
