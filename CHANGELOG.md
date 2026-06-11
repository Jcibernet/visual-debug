# Changelog

## v0.2.0 — Agent loops

### Added
- **Flow mode** (`--flow <file|->`): declarative multi-step recipes the agent
  can write inline and pipe via stdin. Supports `navigate`, `click`, `fill`,
  `type`, `press`, `select`, `hover`, `scroll`, `eval`, `snapshot`, `wait`,
  `pause`. Step results journaled into a flow manifest with status, ms, error.
- **Page map** in every snapshot (`<name>.map.json` + embedded `actions` array
  in the manifest): structured inventory of every interactable with a stable
  `ref`, role, accessible name, value, bbox, and a robust CSS selector. Lets
  an agent navigate without seeing the screen.
- **Flexible targeting**: steps can target by `ref`, `role` + `name`, `text`,
  `testId`, or raw CSS selector.
- **Diff mode** (`--diff <baseline> <candidate>`): compares two manifests and
  emits a verdict (`neutral` / `changed` / `regression`) with category flags
  for screenshot, DOM, console, network, perf.
- **Exit codes**: flow mode returns 1 on uncaught step failure; diff mode
  returns 1 when any `--fail-on` category triggers (default
  `console,network`).
- **A11y fallback**: self-rolled DOM-based accessibility tree when Playwright
  drops the native API.

### Changed
- `package.json` description and keywords updated for the new scope.
- README rewritten around the agent loop.

### Compat
- URL mode is fully backwards-compatible with v0.1.

## v0.1.0
Initial release. URL mode only.
