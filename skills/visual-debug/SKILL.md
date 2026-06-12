---
name: visual-debug
description: |
  Dale al agente visibilidad del navegador y capacidad de navegar/iterar sobre
  una app web, sin el costo de contexto de un MCP de Playwright. Usa esta skill
  cuando el usuario quiera: ver/inspeccionar cómo se ve una página o componente,
  tomar un screenshot, debuggear el frontend, revisar errores de consola o
  requests de red, chequear accesibilidad o performance, hacer regresión visual
  (comparar antes vs después de un cambio), o iterar sobre la UI con un loop de
  mejora continua. Tambien aplica cuando el usuario menciona "mirá", "fijate",
  "cómo se ve", "screenshot", "comparar UI", "se rompió el layout", "revisá el
  front en localhost". Orquesta el CLI `visual-debug` (URL / flow / diff) que
  corre via Execute con cero tokens de contexto.
license: MIT
metadata:
  version: v1
  publisher: jcibernet
---

# visual-debug — browser visibility para el agente

`visual-debug` es un CLI (no un MCP, no consume contexto) que le da al agente
ojos sobre una app web corriendo. Tiene tres modos: **URL** (snapshot one-shot),
**flow** (multi-step declarativo) y **diff** (regresión entre corridas).

Repo: https://github.com/Jcibernet/visual-debug
Launcher: `~/.factory/bin/visual-debug` (o `visual-debug` si `~/.factory/bin`
esta en el PATH).

## Antes de empezar: chequeos rápidos

1. **¿El binario está disponible?** Probá `visual-debug --help`. Si "command
   not found", usá la ruta completa `~/.factory/bin/visual-debug`.
2. **¿La app está corriendo?** visual-debug necesita una URL viva. Si el
   usuario no la levantó:
   - Detectá el dev server del proyecto (`package.json` → `dev`/`start`, o
     `npm run dev`, `pnpm dev`, `next dev`, `vite`, etc.).
   - Levantalo en background con Execute (fireAndForget) y esperá a que
     responda antes de hacer el snapshot.
3. **¿Qué puerto?** Default suele ser 3000 (Next), 5173 (Vite), 8000 (FastAPI).
   Confirmá con el output del dev server.

## Modo URL — el 80% de los casos

Para "mostrame cómo se ve X" o "hay algún error en esta página":

```bash
visual-debug http://localhost:3000/app --full-page --quiet
```

Después leé el manifest (chico) para decidir:

```bash
cat ./.visual-debug/<name>.manifest.json | jq '.summary, .actions'
```

- `summary.console.errors > 0` → abrí `<name>.console.json` para ver el detalle.
- `summary.network.failed > 0` → abrí `<name>.network.json`.
- Para juzgar lo visual, **leé el `<name>.png`** con la tool Read (podés ver
  imágenes). Ahí evaluás layout, jerarquía, color, spacing, etc.

Flags útiles:
- `--full-page` captura toda la página, no solo el viewport.
- `--wait "[selector]"` espera a que aparezca un elemento antes de capturar.
- `--device "iPhone 14"` o `--viewport 375x812` para mobile.
- `--dark` para dark mode.
- `--auth-storage <path>` si la página requiere login (storageState de Playwright).

## Modo Flow — cuando hay que navegar/interactuar

Cuando necesitás clickear, llenar formularios, o llegar a un estado puntual
antes de capturar. Construí el flow JSON inline y pipealo por stdin:

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
}' | visual-debug --flow - --quiet
```

**Targeting de elementos** (en orden de preferencia):
1. `{ "click": { "ref": 7 } }` — por índice del page map (lo más confiable).
   Los refs salen del array `actions` del snapshot anterior.
2. `{ "click": { "role": "button", "name": "Pay" } }` — semántico.
3. `{ "click": { "text": "Continuar" } }` — por texto visible.
4. `{ "click": { "testId": "submit" } }` — por data-testid.
5. `{ "click": "[data-action=pay]" }` — selector CSS crudo (último recurso).

Para descubrir los refs: hacé un snapshot primero, leé `actions` del manifest,
y de ahí elegís a qué `ref` apuntar.

Acciones disponibles: `navigate`, `wait`, `snapshot`, `click`, `fill`, `type`,
`press`, `select`, `hover`, `scroll`, `eval`, `pause`.

## Modo Diff — regresión / loop de mejora continua

Este es el primitive para "cambié algo, ¿mejoró o rompí?". Compara dos
manifests y devuelve un veredicto con exit code:

```bash
visual-debug --diff baseline.manifest.json after.manifest.json --fail-on console,network
echo "exit=$?"
```

- `verdict: neutral` → no hubo cambio relevante.
- `verdict: changed` → hubo delta (DOM/perf/screenshot) pero sin errores nuevos.
- `verdict: regression` → aparecieron errores de consola o requests fallidos.
- Exit code `1` si dispara alguna categoría de `--fail-on` (default
  `console,network`). Usá `--fail-on any` para modo estricto.

## El loop de mejora continua (el caso más potente)

Cuando el usuario pide iterar sobre la UI ("arreglá el hero", "alineá esto",
"que el panel ocupe todo el ancho"):

```
1. visual-debug <url> --name baseline --full-page   # estado actual
2. leé baseline.png + baseline.manifest.json        # entendé qué hay que cambiar
3. EDITÁ EL CÓDIGO                                   # tu cambio
4. (esperá rebuild/HMR del dev server)
5. visual-debug <url> --name after --full-page       # nuevo estado
6. visual-debug --diff baseline.manifest.json after.manifest.json
7. leé after.png + el verdict
   - mejoró y sin regresión → listo (o seguí iterando si falta)
   - regresión → revertí o ajustá
8. goto 3
```

Todo queda en `./.visual-debug/`. Leé los `.png` con Read para evaluar lo
visual vos mismo. Reportá al usuario con evidencia concreta (qué viste en el
screenshot, qué cambió el diff).

## Reglas de uso

- **Cero costo de contexto**: visual-debug corre por Execute. No pidas habilitar
  ningún MCP para esto.
- **Preferí visual-debug antes que el MCP de Playwright** para snapshots,
  navegación por flow, regresión y triage. Solo sugerí el MCP de Playwright si
  necesitás una sesión interactiva viva paso a paso dentro del mismo turno.
- **Limpiá si generás mucho**: `./.visual-debug/` puede crecer. Si el proyecto
  no lo ignora, agregá `.visual-debug/` al `.gitignore` (no lo commitees).
- **No asumas el puerto ni que la app está corriendo** — verificá primero.
- **Leé los PNG** con la tool Read para dar feedback visual real; no te quedes
  solo con el manifest JSON cuando la pregunta es sobre cómo se ve algo.

## Output al usuario

Sé concreto y con evidencia: "El hero quedó centrado (ver screenshot), el diff
no muestra regresión (verdict=neutral, 0 errores de consola nuevos)." Evitá
describir el proceso; mostrá el resultado.
