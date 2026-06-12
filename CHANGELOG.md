# Changelog

## v0.2.0 — Loops de agente

### Agregado
- **Modo Flow** (`--flow <file|->`): recetas declarativas multi-step que el
  agente puede escribir inline y pipear por stdin. Soporta `navigate`,
  `click`, `fill`, `type`, `press`, `select`, `hover`, `scroll`, `eval`,
  `snapshot`, `wait`, `pause`. Los resultados de cada step quedan loggeados
  en el flow manifest con status, ms y error.
- **Page map** en cada snapshot (`<name>.map.json` + array `actions`
  embebido en el manifest): inventario estructurado de cada interactuable
  con `ref` estable, rol, nombre accesible, value, bbox, y un selector CSS
  robusto. Permite al agente navegar sin ver la pantalla.
- **Targeting flexible**: los steps pueden apuntar por `ref`, `role` +
  `name`, `text`, `testId`, o selector CSS crudo.
- **Modo Diff** (`--diff <baseline> <candidate>`): compara dos manifests y
  emite un veredicto (`neutral` / `changed` / `regression`) con flags por
  categoría para screenshot, DOM, console, network, perf.
- **Exit codes**: modo flow devuelve 1 al primer step uncaught que falle;
  modo diff devuelve 1 cuando se dispara alguna categoría de `--fail-on`
  (default `console,network`).
- **Fallback de a11y**: árbol de accesibilidad basado en DOM construido a
  mano para versiones de Playwright que removieron la API nativa.

### Cambiado
- `package.json` con descripción y keywords actualizados al nuevo scope.
- README reescrito alrededor del loop de agente (en español).

### Compatibilidad
- Modo URL es completamente backwards-compatible con v0.1.

## v0.1.0
Release inicial. Sólo modo URL.
