# visual-debug

> One-shot headless Chromium snapshots with a full devtools dump — built for AI coding agents and CLI workflows.

`visual-debug` is a single-file CLI that takes a URL and gives you back **everything you'd open the browser devtools for**, in one shot:

- 📸 Screenshot (viewport or full-page)
- 🧬 Complete DOM (`outerHTML`)
- 💬 Console messages + page errors
- 🌐 Network requests (URL, status, method, content-type, timing)
- ♿ Accessibility tree
- ⚡ Performance metrics (FCP, load, transfer sizes, JS heap)
- 📋 Manifest JSON indexing everything + a summary

Designed to be invoked from a single `Execute` shell call by AI agents (Claude Code, Droid, Cursor, etc.) so they can "see" a running app **without paying the context-token cost of a Playwright MCP server**.

---

## Why?

Browser MCP servers are useful but **expensive in context tokens** (a Playwright MCP loads ~3.5k tokens of tool schemas per session). For most "let me check what the page looks like" tasks, an agent only needs:

1. A screenshot
2. The DOM
3. Any console errors
4. Failed network requests

`visual-debug` does that in one shell command, writes every output to disk, and returns a JSON manifest the agent can `cat` selectively. **Zero MCP overhead. Works anywhere.**

It also works perfectly fine **as a human tool** for quick visual regression, perf triage, or accessibility checks.

---

## Install

Requires **Node 18+**.

```bash
git clone https://github.com/Jcibernet/visual-debug.git
cd visual-debug
npm install
```

(Optional) make it globally callable:

```bash
npm link
# or
ln -s "$(pwd)/visual-debug.js" ~/.local/bin/visual-debug
chmod +x visual-debug.js
```

The first run downloads Chromium via Playwright (~170MB). If you already have a Playwright install, point `--executable` or `VISUAL_DEBUG_CHROMIUM` at your existing binary to skip the download.

---

## Quick start

```bash
# Smoke check — outputs to ./.visual-debug/<timestamp>.*
visual-debug https://example.com

# Full page screenshot with selector wait
visual-debug http://localhost:3000/app \
  --full-page \
  --wait "[data-testid=cuotas-panel]"

# Mobile preview
visual-debug http://localhost:3000 --device "iPhone 14"

# Dark mode + named output
visual-debug https://staging.example.com --dark --name dark-home

# Authenticated session
visual-debug http://localhost:3000/dashboard \
  --auth-storage ~/.auth/myapp.json
```

Every run prints a manifest JSON to stdout. Use `--quiet` to print only that.

---

## Output structure

Files go to `<out>/<name>.*` (default `./.visual-debug/<ISO-timestamp>.*`):

| File | Equivalent devtools panel |
|---|---|
| `<name>.png` | Screenshot |
| `<name>.dom.html` | Elements (outer HTML) |
| `<name>.console.json` | Console (logs, warnings, errors, page errors) |
| `<name>.network.json` | Network (all responses with timing) |
| `<name>.a11y.json` | Accessibility |
| `<name>.perf.json` | Performance (paints, navigation, heap) |
| `<name>.manifest.json` | Index + summary (error count, failed requests, FCP, load time) |

The manifest summary is what an agent typically reads first:

```json
{
  "url": "http://localhost:3000/app",
  "title": "My App",
  "navMs": 842,
  "summary": {
    "console": { "total": 12, "errors": 1, "warnings": 2 },
    "network": { "total": 47, "failed": 0, "byType": { "document": 1, "script": 8, "stylesheet": 3, "fetch": 12, "image": 23 } },
    "perf": { "load": 1241.3, "fcp": 612.4 }
  },
  "outputs": { "screenshot": "...", "dom": "...", "console": "...", "network": "...", "a11y": "...", "perf": "..." }
}
```

---

## All options

```
visual-debug <url> [options]

  --out <path>          Output directory (default: ./.visual-debug)
  --name <basename>     Basename for outputs (default: timestamp)
  --viewport <WxH>      Viewport size (default: 1440x900)
  --device <name>       Playwright device descriptor (e.g. "iPhone 14")
  --wait <selector>     Wait for selector before capture
  --wait-ms <n>         Extra wait in ms after load (default: 500)
  --full-page           Capture full page
  --dark                Use dark color scheme
  --no-screenshot       Skip the PNG
  --no-console          Skip console capture
  --no-network          Skip network capture
  --no-dom              Skip DOM dump
  --no-a11y             Skip accessibility tree
  --no-perf             Skip performance metrics
  --script <path>       Run a JS file inside the page (post-load)
  --auth-storage <path> Load Playwright storageState JSON before navigation
  --user-agent <str>    Override user agent
  --executable <path>   Override chromium binary
  --slow                Add 250ms slowMo (helps with flicker)
  --quiet               Only print the manifest JSON
```

Environment variables:

- `VISUAL_DEBUG_CHROMIUM` — path to a pre-existing chromium binary
- `QT_QPA_PLATFORM` — auto-set to `xcb` to survive Wayland systems with broken Qt plugins

---

## Recipes for AI agents

### Claude Code / Droid / Cursor — "go look at this URL and tell me what's wrong"

```bash
visual-debug http://localhost:3000/checkout \
  --full-page \
  --wait "[data-step=payment]" \
  --quiet
```

The agent then `cat`s `<out>/<name>.manifest.json` (small) and only opens the heavier files (DOM, network) if the summary signals issues (errors > 0, failed > 0).

### Visual regression between two branches

```bash
git checkout main
visual-debug http://localhost:3000/app --full-page --name main-app
git checkout feature/new-layout
visual-debug http://localhost:3000/app --full-page --name feature-app
# Then diff main-app.png vs feature-app.png with any image diff tool
```

### Perf budget check in CI

```bash
visual-debug http://staging.example.com --no-screenshot --no-dom --no-a11y --quiet \
  | jq '.summary.perf.fcp'
# Fail the job if FCP > budget
```

### Console error gating

```bash
visual-debug http://localhost:3000 --quiet \
  | jq -e '.summary.console.errors == 0'
```

---

## Comparison

|  | visual-debug | Playwright MCP | Puppeteer script | Lighthouse CLI |
|---|---|---|---|---|
| Context tokens (in an AI agent session) | **0** | ~3,500 | 0 | 0 |
| Screenshot | ✅ | ✅ | ✅ | ✅ |
| Console capture | ✅ | ✅ | manual | partial |
| Network capture | ✅ | ✅ | manual | ✅ |
| Accessibility tree | ✅ | ✅ | manual | scores only |
| Perf metrics | ✅ | partial | manual | ✅ (richer) |
| Multi-step interaction | ❌ (use Playwright MCP for that) | ✅ | ✅ | ❌ |
| Single-file, zero-config | ✅ | ❌ | ❌ | ✅ |

`visual-debug` is **not** a Playwright MCP replacement for interactive flows. It's the cheaper, faster first stop.

---

## How it works

Single file (`visual-debug.js`), ~300 lines, ESM. Uses Playwright's headless Chromium. Forces `QT_QPA_PLATFORM=xcb` so it survives Wayland desktops with missing Qt plugins. Captures collectors are registered before navigation, then assets are dumped in parallel-friendly sequence. Each capture is wrapped in try/catch — one failing asset never breaks the run.

---

## Contributing

PRs welcome. Keep it single-file. Keep it dependency-light. Keep it agent-friendly.

If you have ideas for additional captures (CDP traces, coverage, cookie state, etc.) open an issue with the use case first — the goal is **breadth of one-shot visibility**, not full devtools parity.

---

## License

MIT © Juan Cibernet
