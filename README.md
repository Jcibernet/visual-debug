# visual-debug

> Agent-first headless browser snapshots, multi-step flows, and run-vs-run diffs — designed for AI coding agents and CLI workflows.

`visual-debug` is a single-file CLI that lets an AI agent (Claude Code, Droid, Cursor, etc.) **see and operate** a running web app without needing a Playwright MCP server (and the ~3.5k context tokens it costs).

Three modes in one binary:

1. **URL mode** — one-shot snapshot of any URL: screenshot + DOM + console + network + a11y + perf + page map.
2. **Flow mode** — declarative multi-step recipes the agent can write inline (`--flow -`). Each step targets elements by **stable ref**, role, text, testId, or selector. Snapshots can be taken at any step.
3. **Diff mode** — compare two manifests and get a verdict (`regression` / `changed` / `neutral`) with proper exit codes for CI loops.

Designed around one principle: **give the agent everything it needs to navigate autonomously, with zero MCP overhead.**

---

## Why?

Browser MCP servers eat context. An agent loading Playwright MCP pays ~3,500 tokens of tool schema per session. For most loops — "look at the page", "click this thing", "compare before vs after" — that overhead is wasted.

`visual-debug` solves the same problem in shell, with all state on disk:

- Every snapshot writes a **page map** listing every interactable element with a stable `ref`. The agent can plan its next step without seeing the screen.
- Flows are **JSON the agent can build inline** and pipe via stdin.
- Diffs return **exit codes** so the agent (or CI) knows whether to keep iterating.

It also doubles as a perfectly fine human tool for visual regression, perf triage, or quick a11y inspection.

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

First run downloads Chromium via Playwright (~170MB). Already have a Playwright install? Point `--executable` or `VISUAL_DEBUG_CHROMIUM` at your existing binary.

---

## Quick start

```bash
# URL mode (one-shot)
visual-debug https://example.com

# Flow mode (multi-step)
visual-debug --flow flows/checkout.json

# Inline flow from stdin — what an AI agent typically does:
echo '{
  "name": "smoke",
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "navigate": "/" },
    { "snapshot": "home" },
    { "click": { "text": "Sign in" } },
    { "wait": "[data-step=login]" },
    { "fill": { "[name=email]": "x@y.com" } },
    { "snapshot": "login-filled" }
  ]
}' | visual-debug --flow -

# Diff two runs
visual-debug --diff before.manifest.json after.manifest.json
```

Every run prints a manifest JSON to stdout. Use `--quiet` to print only that.

---

## The page map (key feature for agents)

Each snapshot writes `<name>.map.json` with a structured inventory of the page. The manifest also embeds the first 50 interactables inline as `actions`, so the agent often doesn't need to open the map file at all.

```json
{
  "actions": [
    { "ref": 1, "role": "link",         "name": "Home",            "selector": "[data-testid=\"nav-home\"]" },
    { "ref": 2, "role": "button",       "name": "Sign in",         "selector": "button[aria-label=\"Sign in\"]" },
    { "ref": 3, "role": "input:email",  "name": "Email",           "selector": "[name=\"email\"]" },
    { "ref": 4, "role": "input:password","name": "Password",       "selector": "[name=\"password\"]" },
    { "ref": 5, "role": "button",       "name": "Continue",        "selector": "[data-action=\"submit\"]" }
  ]
}
```

The full `.map.json` adds:

- `forms` — every form with fields, action, method.
- `landmarks` — `main`, `nav`, `header`, `footer`, etc.
- `headings` — h1/h2/h3 with text.

The agent reads the map, picks a `ref`, and acts.

---

## Flow recipes

Flows are JSON. Steps support a sugared shorthand or a full form.

```json
{
  "name": "checkout",
  "baseUrl": "http://localhost:3000",
  "viewport": "1440x900",
  "continueOnError": false,
  "finalSnapshot": true,
  "steps": [
    { "navigate": "/checkout" },
    { "wait": "[data-step=address]" },
    { "snapshot": "address-form" },
    { "fill": { "[name=email]": "x@y.com", "[name=zip]": "1414" } },
    { "click": { "ref": 7 } },
    { "wait": "[data-step=payment]" },
    { "fill": { "[name=card]": "4242 4242 4242 4242" } },
    { "snapshot": "payment-filled", "fullPage": true },
    { "click": { "role": "button", "name": "Pay" } },
    { "wait": "[data-step=success]" },
    { "snapshot": "success" },
    { "eval": "() => document.querySelector('[data-order-id]')?.textContent" }
  ]
}
```

### Supported actions

| Action | Shape | Notes |
|---|---|---|
| `navigate` | `{ "navigate": "/path" }` | Relative paths resolve against `baseUrl` |
| `wait` | `{ "wait": "selector" }` or `{ "wait": 500 }` | Selector wait or ms |
| `snapshot` | `{ "snapshot": "name", "fullPage": true }` | Full devtools dump + page map |
| `click` | `{ "click": { "ref": 7 } }` | Or by `role`, `text`, `testId`, raw selector |
| `fill` | `{ "fill": { "[name=x]": "value" } }` | Multi-field by selector map |
| `type` | `{ "type": { "ref": 3, "value": "hi" } }` | Character-by-character |
| `press` | `{ "press": "Enter" }` | Keyboard key |
| `select` | `{ "select": { "ref": 5, "value": "ar" } }` | Dropdown |
| `hover` | `{ "hover": { "ref": 7 } }` | |
| `scroll` | `{ "scroll": "selector" }` or `{ "scroll": { "y": 800 } }` | |
| `eval` | `{ "eval": "() => location.pathname" }` | Returns result in step entry |
| `pause` | `{ "pause": 300 }` | ms |

### Targeting (in order of agent preference)

```jsonc
{ "click": { "ref": 7 } }                                  // by page-map index
{ "click": { "role": "button", "name": "Pay" } }           // by role + accessible name
{ "click": { "text": "Continue", "exact": false } }        // by visible text
{ "click": { "testId": "submit" } }                        // by data-testid
{ "click": "[data-action=pay]" }                           // raw CSS selector
{ "click": { "target": "[data-action=pay]", "button": "right" } } // full form
```

`ref` is recomputed against the **current** page state at the moment of the step, so it stays valid even after dynamic DOM changes.

### Optional / continue-on-error

- Step-level: `{ "click": "...", "optional": true }` — failure becomes `skipped`.
- Flow-level: `"continueOnError": true` — every failing step becomes `skipped`.

If a non-optional step fails and `continueOnError` is false, the flow stops, exits with code `1`, and the partial timeline is preserved.

---

## Diff mode

```bash
visual-debug --diff <baseline-manifest> <candidate-manifest> \
  [--out ./.visual-debug] [--name <basename>] \
  [--fail-on console,network,perf,dom,screenshot,any]
```

Writes `<name>.diff.json`:

```json
{
  "type": "diff",
  "baseline": "before",
  "candidate": "after",
  "flags": { "screenshot": false, "dom": true, "console": true, "network": false, "perf": false, "any": true },
  "screenshot": { "baselineBytes": 80123, "candidateBytes": 79988, "sizeDeltaPct": 0.17 },
  "dom":        { "added": 3, "removed": 1, "mutated": 12 },
  "console":    { "newErrors": ["TypeError: cannot read x of undefined"], "fixed": [] },
  "network":    { "newFailures": [], "totalDelta": 0 },
  "perf":       { "fcpDelta": 18, "loadDelta": -42 },
  "verdict": "regression",
  "summaryLine": "verdict=regression | +1 console errors | dom +3/-1"
}
```

**Exit code:** `1` if any of the categories in `--fail-on` are flagged, else `0`. Default `--fail-on console,network`. Use `--fail-on any` for strict mode.

This is the loop primitive for "did my change break something?".

---

## All options

```
URL mode:
  visual-debug <url> [options]

Flow mode:
  visual-debug --flow <file|->                  Read JSON flow from file or stdin

Diff mode:
  visual-debug --diff <baseline> <candidate>    Compare two manifest JSONs

Shared options:
  --out <dir>            Output directory (default: ./.visual-debug)
  --name <basename>      Basename for outputs (default: timestamp)
  --viewport <WxH>       Default 1440x900
  --device <name>        Playwright device descriptor (e.g. "iPhone 14")
  --wait <selector>      Wait for selector before first snapshot
  --wait-ms <ms>         Extra wait after load (default 500)
  --full-page            Full-page screenshots
  --dark                 Dark colorScheme
  --no-screenshot --no-dom --no-console --no-network --no-a11y --no-perf
  --no-page-map          Skip interactable inventory
  --script <path>        Run JS file inside page
  --auth-storage <path>  storageState JSON
  --user-agent <str>     Override UA
  --executable <path>    Chromium binary
  --slow                 250ms slowMo
  --quiet                Only emit JSON
  --fail-on <kinds>      Diff exit code categories (default: console,network)
```

---

## Continuous-iteration loop for AI agents

The intended agent loop:

```
1. visual-debug <url> --name baseline       # snapshot current state + page map
2. agent reads baseline.manifest.json       # picks ref or selector for next action
3. agent constructs a flow JSON inline      # actions targeting refs/roles/text
4. visual-debug --flow - --name attempt-1   # pipe via stdin, get new snapshots
5. visual-debug --diff baseline.manifest.json attempt-1-final.manifest.json
6. read diff.verdict
   - "neutral"     → no change; revise plan
   - "changed"     → expected delta; proceed
   - "regression"  → revert / iterate
7. goto 2
```

Everything is on disk. The agent reads JSON via `cat`/`jq` — no extra context tokens spent.

---

## Recipes

### One-shot inspection

```bash
visual-debug http://localhost:3000/checkout --full-page --wait "[data-step=payment]"
```

### Auth + inspect

```bash
visual-debug http://localhost:3000/dashboard --auth-storage ~/.auth/myapp.json
```

### Visual regression in CI

```bash
visual-debug http://staging/$URL --name baseline --quiet
deploy_my_change
visual-debug http://staging/$URL --name after --quiet
visual-debug --diff baseline.manifest.json after.manifest.json --fail-on any
# Job fails if anything regressed
```

### Mobile + perf gate

```bash
visual-debug http://staging --device "iPhone 14" --no-screenshot --no-dom --no-a11y --quiet \
  | jq -e '.summary.perf.fcp < 2000'
```

### Inline agent flow (typical Droid / Claude Code usage)

```bash
echo '{
  "name": "verify-feature",
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "navigate": "/admin" },
    { "fill": { "[name=user]": "admin", "[name=pass]": "$ADMIN_PASS" } },
    { "click": { "role": "button", "name": "Log in" } },
    { "wait": "[data-page=dashboard]" },
    { "snapshot": "post-login" },
    { "eval": "() => !!document.querySelector(\"[data-feature-flag=new-dashboard]\")" }
  ]
}' | visual-debug --flow - --quiet
```

---

## Comparison

|  | visual-debug | Playwright MCP | Puppeteer script | Lighthouse CLI |
|---|---|---|---|---|
| Context tokens (agent session) | **0** | ~3,500 | 0 | 0 |
| Screenshot | ✅ | ✅ | ✅ | ✅ |
| Console / network capture | ✅ | ✅ | manual | partial |
| Accessibility tree | ✅ | ✅ | manual | scores only |
| Perf metrics | ✅ | partial | manual | ✅ (richer) |
| Page map / interactable inventory | ✅ | partial | ❌ | ❌ |
| Declarative multi-step flows | ✅ | imperative | imperative | ❌ |
| Run-vs-run diff with exit code | ✅ | ❌ | manual | ❌ |
| Single file, zero config | ✅ | ❌ | ❌ | ✅ |

**It's not a replacement for Playwright MCP** in deeply interactive flows. It **is** the cheaper, faster default for snapshot + navigate + diff loops.

---

## How it works

`visual-debug.js` is a single ESM file using Playwright's headless Chromium. It forces `QT_QPA_PLATFORM=xcb` to survive Wayland desktops with missing Qt plugins. Collectors register before navigation, each capture is wrapped in try/catch (one failing asset never breaks the run), and every step in a flow is timed and journaled into the flow manifest.

Refs in the page map are derived from a fresh DOM walk at the moment of the step, so they don't get stale after re-renders.

---

## Contributing

PRs welcome. Constraints:

- Stay single-file (or add a `lib/` dir, but keep the entry minimal).
- Keep the only runtime dep `playwright`.
- Treat every agent-facing field as **stable API** once shipped — agents will read them.

---

## License

MIT © Juan Cibernet
