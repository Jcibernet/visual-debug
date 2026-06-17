---
name: visual-debug
description: |
  El ojo crítico UI/UX del agente. Inspector de layout y accesibilidad sobre una
  app web corriendo, sin el costo de contexto de un MCP de Playwright. Usá esta
  skill cuando: estés por modificar código de UI/frontend, acabes de modificar UI
  y quieras verificar que no rompiste el layout, debuguees un problema de
  layout/accesibilidad reportado por el usuario, o estés revisando un PR que toca
  archivos de frontend. También aplica cuando el usuario diga "mirá cómo se ve",
  "fijate el front en localhost", "se rompió el layout", "revisá accesibilidad",
  "comparemos antes vs después", "hay errores en esta página". Orquesta el CLI
  `visual-debug` (URL / flow / diff / runs) que corre via Execute con cero tokens
  de contexto. La salida principal es texto (layout SVG + uxReport), no píxeles.
license: MIT
metadata:
  version: v2
  publisher: jcibernet
---

# visual-debug — el ojo crítico UI/UX del agente

`visual-debug` es un CLI (no un MCP, no consume contexto) que te da ojos sobre una
app web corriendo. v0.3.0 es **efímero por default** y su salida estrella es un
**layout SVG** (vector) + un **uxReport** (heurísticas) — texto estructurado, no
píxeles. Tres modos: **URL** (one-shot), **flow** (multi-step) y **diff**
(regresión), más el subcomando **runs** (mantenimiento).

Repo: https://github.com/Jcibernet/visual-debug
Launcher: `~/.factory/bin/visual-debug` (o `visual-debug` si está en el PATH).

## Cuándo invocar (triggers)

Disparate sola, sin que el usuario lo pida explícito, cuando:

1. **Estás por modificar código de UI/frontend** → tomá un baseline efímero
   primero, para entender la vista antes de tocarla.
2. **Acabás de modificar UI** → snapshot + diff contra el baseline para verificar
   que no rompiste el layout ni metiste findings de accesibilidad.
3. **El usuario reporta un problema de layout/accesibilidad** → snapshot y leé el
   `uxReport` y el layout SVG para localizarlo.
4. **Estás revisando un PR que toca archivos de frontend** → snapshot de las
   vistas afectadas y reportá con evidencia (qué dice el uxReport, qué cambió el
   diff).

## Invocación default: EFÍMERA

Por default no escribís nada en el repo. La ruta del run temporal va a stderr;
para parsear el manifest pedí `--emit-manifest` (va a stdout):

```bash
visual-debug http://localhost:3000/app --emit-manifest | jq '.summary, .uxReport | keys'
```

Leé, en este orden:
1. **manifest** (`--emit-manifest` → stdout): `summary`, `actions`, `uxReport`.
2. **layout SVG** (`outputs.layoutSvg`): leelo con Read. Es texto. Buscá
   `data-issue=` para saltar a los elementos flaggeados (borde rojo punteado).
3. **uxReport**: heurísticas de geometría y a11y, cada una con `severity`.

## Antes de empezar: chequeos rápidos

1. **¿El binario está?** Probá `visual-debug --help`. Si "command not found", usá
   `~/.factory/bin/visual-debug`.
2. **¿La app está corriendo?** Necesitás una URL viva. Si no la levantaron,
   detectá el dev server (`package.json` → `dev`/`start`; `next dev`, `vite`,
   etc.), levantalo en background (Execute fireAndForget) y esperá a que responda.
3. **¿Qué puerto?** Default suele ser 3000 (Next), 5173 (Vite), 8000 (FastAPI).

## Qué leer y qué IGNORAR (regla central)

- **LEÉ**: el manifest, el layout SVG y el uxReport. Te dan el layout y los
  problemas en texto, a una fracción del costo en tokens.
- **NO cargues el PNG/JPEG en contexto** salvo que vos hayas pedido
  `--screenshot-on-issue` y se haya generado uno para un finding
  `severity:'error'` puntual. Por default no se genera ningún raster.

## Modo URL — inspección puntual

```bash
visual-debug http://localhost:3000/app --emit-manifest | jq '.uxReport.lowContrastPairs, .uxReport.tinyTapTargets'
```

Flags: `--viewport 375x812` o `--device "iPhone 14"` (mobile), `--dark`,
`--wait "[selector]"`, `--auth-storage <storageState.json>` (login).

## Modo flow — cuando hay que navegar/interactuar

Armá el flow JSON inline y pipealo por stdin:

```bash
echo '{
  "name": "verify",
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "navigate": "/app" },
    { "snapshot": "inicial" },
    { "click": { "ref": 7 } },
    { "wait": "[data-step=detail]" },
    { "snapshot": "detalle" }
  ]
}' | visual-debug --flow - --emit-manifest
```

Targeting (preferencia): `ref` → `role`+`name` → `text` → `testId` → selector CSS.
Los `ref` salen del array `actions` del snapshot anterior. Acciones disponibles:
`navigate`, `wait`, `snapshot`, `click`, `fill`, `type`, `press`, `select`,
`hover`, `scroll`, `eval`, `pause`.

## Modo diff — regresión / loop de mejora continua

El primitive para "cambié algo, ¿mejoré o rompí?". Pipeable:

```bash
# 1. baseline ANTES de tocar nada
visual-debug http://localhost:3000/app --emit-manifest > /tmp/baseline.json
# 2. EDITÁS EL CÓDIGO, esperás rebuild/HMR
# 3. comparás
visual-debug http://localhost:3000/app --emit-manifest \
  | visual-debug --diff-against /tmp/baseline.json - --fail-on layout,ux
echo "exit=$?"
```

- `verdict: neutral` → sin cambio. `changed` → delta esperado. `regression` →
  errores de consola/red o findings UX nuevos.
- Categorías de `--fail-on`: `console`, `network`, `perf`, `dom`, `screenshot`,
  `layout`, `ux`, `any`. Exit `1` si dispara alguna.

## Cuándo persistir (y cuándo NO)

Persistí SOLO en estos casos, con `--persist-as <nombre>`:

- **Baseline para un refactor grande**: querés comparar al final de varias
  iteraciones.
- **Capturar un estado roto reproducible** para un bug report (sumá
  `--screenshot-on-issue` para tener la evidencia visual solo cuando hay error).

```bash
visual-debug http://localhost:3000/settings --persist-as settings-baseline
```

Mantenimiento de lo persistido:

```bash
visual-debug runs --list                      # estado fresh/stale/unknown
visual-debug runs --prune-stale --yes         # borra lo que ya no matchea el DOM
visual-debug runs --clean --yes               # borra todo
```

## Anti-patrones (NO hagas esto)

- **No uses `--persist` "por las dudas".** El default es efímero por algo. Si no
  vas a comparar contra ese run más tarde, no lo guardes.
- **No leas el PNG/JPEG** salvo que `--screenshot-on-issue` te haya generado uno
  para un error concreto. Para juzgar layout, leé el `.layout.svg`.
- **No corras en cada save de archivo.** Snapshot cuando tenés algo que verificar
  (antes/después de un cambio), no en loop ciego.
- **No asumas el puerto ni que la app está viva** — verificá primero.

## Reglas de uso

- **Cero costo de contexto**: corre por Execute. No pidas habilitar ningún MCP.
- **Preferí visual-debug antes que el MCP de Playwright** para inspección,
  navegación por flow, regresión y auditoría UX. Solo sugerí el MCP de Playwright
  si necesitás una sesión interactiva viva paso a paso dentro del mismo turno.
- Si persistís, `.visual-debug/` ya debería estar en `.gitignore` (no lo
  commitees).

## Gotcha: redirects del lado del cliente (geo / auth / i18n)

Si la página hace un **redirect por JS** al cargar (geo por país, i18n `/` →
`/es/`, guard de auth → `/login`), el headless sigue el redirect y capturás otra
página. Verificá siempre que capturaste lo correcto: chequeá `finalUrl` en el
manifest, o un texto único de la página esperada.

Cómo evitarlo:

1. **Seteá el estado que apaga el redirect ANTES de navegar**, vía un flow con
   `eval` (cookie / localStorage), y recién después navegá a la ruta real:
   ```bash
   echo '{
     "name": "en", "baseUrl": "http://localhost:8888",
     "steps": [
       { "navigate": "/es/" },
       { "eval": "() => { document.cookie = \"pref_lang=en; path=/\"; }" },
       { "navigate": "/index.html" },
       { "wait": "#main" },
       { "snapshot": "en" }
     ]
   }' | visual-debug --flow - --emit-manifest
   ```
2. **Para auth**, preferí `--auth-storage <storageState.json>` en vez de pasar
   por el login.

## Output al usuario

Sé concreto y con evidencia del uxReport y el diff: "El form tiene 2 inputs sin
label (uxReport.unlabeledInputs) y un botón con nombre accesible vacío. El diff
no muestra regresión de layout (verdict=neutral)." Mostrá el resultado, no el
proceso.
