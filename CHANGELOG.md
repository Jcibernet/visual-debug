# Changelog

## [0.4.0] — Hardening + device-aware

Dos ejes: reducir la superficie de ataque (Chromium abre contenido web no
confiable) y hacer las heurísticas conscientes del dispositivo.

### Added — Devices
- **`--device-matrix [mobile,tablet,desktop]`**: corre la misma URL en varios
  form factors en una sola invocación y emite un manifest `type:"device-matrix"`
  con `deviceSpecificFindings` (heurísticas que disparan en algunos devices y no
  en otros — la señal de bug responsive) y `summary.worstDevice`.
- **Heurísticas device-aware**: el umbral de tap target ahora depende del
  puntero — 44px en touch (WCAG 2.5.5, `severity:error`), 24px en puntero fino
  (`warn`). El overflow horizontal es `error` en touch y `warn` en desktop. El
  `uxReport` incluye `device:{label,pointer,minTap}` y el manifest un `profile`.
- **`hoverOnlyOnTouch`**: nueva heurística que marca interactuables ocultos
  hasta hover (sin equivalente en touch) cuando el perfil es coarse.
- Presets `mobile` (390x844, iPhone 13), `tablet` (820x1180, iPad), `desktop`
  (1440x900). El puntero también se infiere de un `--viewport` angosto (≤600px).

### Added — Security
- **Sandbox de Chromium ON por default**, con auto-desactivado solo donde no
  puede arrancar (root / CI / contenedor), avisando por stderr. `--sandbox`
  fuerza ON, `--no-sandbox` fuerza OFF. Si un launch sandboxeado falla, hay un
  retry automático sin sandbox (con aviso). Antes `--no-sandbox` estaba
  hardcodeado siempre.
- **`--no-eval`**: deshabilita los steps `eval` del modo flow (RCE en el
  contexto de la página si el flow viene de fuente no confiable).
- **Guard de navegación**: `file://` bloqueado salvo `--allow-file`; esquemas no
  http/https rechazados; hosts de **cloud-metadata** (169.254.169.254, etc.)
  siempre bloqueados; **LAN privada** bloqueada salvo `--allow-private`.
  `localhost`/loopback siempre permitidos (caso dev server).

### Changed
- `--device` ahora también ajusta las heurísticas (no solo el viewport).

### Migration
- Si corrías contra `file://` directo, agregá `--allow-file`. Los ejemplos del
  README/SKILL ya usaban URLs http; los flujos locales necesitan el flag.
- En root/CI/Docker el sandbox se desactiva solo (igual que antes), así que no
  hay cambio operativo ahí. En tu máquina de dev el sandbox ahora va ON.

## [0.3.1] — Portabilidad y deprecaciones

### Fixed
- **Ruta de Chromium ya no está hardcodeada.** Antes el default apuntaba a un
  home dir y build fijos (`/home/<user>/.cache/.../chromium-1217/...`), lo que
  rompía en cualquier otra máquina y al actualizar Playwright. Ahora
  `defaultChromium()` resuelve vía `chromium.executablePath()` y, si esa build
  no está instalada (drift de versión: Playwright actualizado sin re-correr
  `playwright install`), escanea el cache de `ms-playwright` y usa el Chromium
  más nuevo que encuentre. Sigue respetando `VISUAL_DEBUG_CHROMIUM` y
  `--executable`.
- **`locator.type()` (deprecado) → `locator.pressSequentially()`** en el step
  `type` del modo flow.

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
