# Changelog

## [0.3.0] — El ojo crítico UI/UX

El tool deja de ser un "snapshotter que persiste por default" y pasa a ser un
**inspector UI/UX efímero**: el ojo del agente, no su archivero. Lee texto
estructurado (layout SVG + heurísticas), no píxeles.

### Added
- **Efímero por default**: cada corrida vive en un dir temporal (`os.tmpdir()`)
  y se borra al salir (incluye SIGINT/SIGTERM/uncaughtException). Ya no se crea
  `.visual-debug/` en el CWD salvo que lo pidas.
- **Layout SVG** (`<name>.layout.svg`): representación vectorial del layout
  interactuable, generada del page map + bounding boxes (sin rasterizar). Un
  `<rect>` por interactuable con `data-ref`/`data-role`/`data-name`, color por
  familia de rol, landmarks de fondo, headings con label, y borde rojo punteado
  + `data-issue` en los elementos flaggeados por las heurísticas. Función pura
  exportada `renderLayoutSvg(pageMap, uxReport, viewport)`.
- **uxReport** (heurísticas) en cada snapshot. Geometría: `overflow`,
  `offscreen`, `tinyTapTargets` (WCAG 2.5.5), `overlaps`, `truncatedText`.
  Accesibilidad: `unlabeledInputs`, `unnamedButtons`, `headingOrderJumps`,
  `missingLandmarks`, `imagesWithoutAlt`, `lowContrastPairs` (cálculo WCAG de
  luminancia relativa inline, sin libs). Cada collector corre en try/catch;
  los fallos van a `uxReport.errors[]` y nunca rompen la corrida.
- **Persistencia opt-in y semántica**: `--persist` (auto-nombrado por
  timestamp, con retención `--keep <N>`, default 1), `--persist-as <name>`
  (nombrado; sobreescribe si existe).
- **`--emit-manifest`**: el manifest completo va a stdout y el resumen humano a
  stderr. Permite pipelines: `... --emit-manifest | visual-debug --diff-against base.json -`.
- **`--diff-against <baseline> <candidate>`**: alias de `--diff` más natural en
  pipelines. El candidate (o cualquier manifest del diff) puede ser `-` (stdin).
- **Screenshots opt-in**: apagados por default. `--screenshots` (todos),
  `--screenshot-on-issue` (solo si hay un finding `severity:'error'`), y por
  step `{ "snapshot": "x", "screenshot": true }`. Formato default WebP
  (`--screenshot-format png|webp|jpeg`; WebP cae a JPEG q70 en Playwright 1.x).
- **Subcomando `runs`** (destructivo, vive aparte a propósito): `--list`
  (con chequeo fresh/stale/unknown re-snapshoteando la URL del manifest),
  `--prune-stale`, `--prune-older-than <7d|12h|30m>`, `--clean`. Confirmación
  interactiva salvo `--yes`.
- **Diff: categorías `layout` y `ux`**. `layout` compara geometría embebida
  (added/removed/moved por ref + deltas de área >10%). `ux` cuenta findings
  nuevos (regresión) vs resueltos (mejora). `--fail-on layout` y `--fail-on ux`
  son triggers válidos; `--fail-on any` ahora los cubre.

### Changed
- El manifest de snapshot ahora embebe `layout` (geometría self-contained para
  diffear) y `uxReport`. El de flow promueve el `layout`/`uxReport`/`outputs`
  del snapshot final para ser diffeable directo.
- `package.json`: descripción, keywords y `version` a 0.3.0.
- README reescrito agent-first (en español): decision tree, qué leer / qué
  ignorar, efímero vs persistente, tabla de contratos JSON, costos de tokens.
- SKILL.md actualizado con los nuevos triggers y anti-patrones.

### Deprecated
- Nada.

### Removed
- Nada. Totalmente backwards-compatible: `--out <dir>` sigue funcionando y se
  trata como corrida persistente (comportamiento v0.2). Todos los flags de v0.2
  siguen válidos.

### Fixed
- N/A.

### Migration (para agentes que ya conocen v0.2)
- Por default **no se escribe nada en el repo**. La ruta del run temporal se
  imprime en **stderr**; para pipear el manifest usá `--emit-manifest` (va a
  stdout). Para conservar un run usá `--persist-as <nombre>`.
- Los PNG ya **no se generan por default**. Pedilos solo con `--screenshots` o
  `--screenshot-on-issue`. Para juzgar layout/UX, leé el `.layout.svg` y el
  `uxReport` del manifest — son texto y cuestan una fracción de tokens.
- El JSON viejo no cambió: los campos de v0.2 siguen iguales, solo se agregaron
  `layout`, `uxReport`, `layoutSvg` y las categorías `layout`/`ux` del diff.

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
