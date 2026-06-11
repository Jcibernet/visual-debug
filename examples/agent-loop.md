# Agent loop recipe

This is the canonical loop an AI agent runs with `visual-debug`. Every step is
either an Execute shell call or a JSON read — no MCP context required.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. SNAPSHOT current state                                              │
│     $ visual-debug http://localhost:3000/$URL --name baseline --quiet   │
│                                                                         │
│  2. READ manifest + actions                                             │
│     $ cat .visual-debug/baseline.manifest.json | jq '.actions, .summary'│
│                                                                         │
│  3. PLAN next action against a ref / role / text                        │
│     → agent decides: click ref 7, fill ref 3, navigate /foo, etc.       │
│                                                                         │
│  4. EXECUTE via inline flow                                             │
│     $ echo '{...steps...}' | visual-debug --flow - --name attempt-1     │
│                                                                         │
│  5. DIFF baseline vs result                                             │
│     $ visual-debug --diff baseline.manifest.json \                      │
│         attempt-1-final.manifest.json --fail-on console,network         │
│                                                                         │
│  6. ROUTE by verdict                                                    │
│       neutral    → agent revises plan (no effect)                       │
│       changed    → expected delta; continue                             │
│       regression → revert / iterate                                     │
│                                                                         │
│  7. GOTO 2                                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

The agent only needs to read three small files per iteration:
- `.manifest.json` (~5–15 KB)
- `.diff.json` (~1–3 KB)
- Occasionally `.map.json` when the inline `actions` array doesn't have enough.

The heavy assets (screenshot, DOM, network) are kept on disk and only fetched
when explicitly needed for debugging — never spent against context.
