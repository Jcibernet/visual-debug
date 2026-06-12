<p align="center">
  <img src=".github/banner.svg" alt="visual-debug" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Jcibernet/visual-debug/releases"><img src="https://img.shields.io/github/v/release/Jcibernet/visual-debug?style=flat-square&color=2d5bff&label=release" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2d5bff?style=flat-square" alt="license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-2d5bff?style=flat-square" alt="node">
  <img src="https://img.shields.io/badge/MCP_context_cost-0_tokens-2d5bff?style=flat-square" alt="zero context">
  <img src="https://img.shields.io/badge/agent--first-%E2%9C%93-2d5bff?style=flat-square" alt="agent first">
</p>

> Snapshots de navegador headless, flujos multi-step y diffs entre corridas — pensado para agentes de IA y workflows de CLI.

`visual-debug` es un CLI de un solo archivo que permite a un agente de IA (Claude Code, Droid, Cursor, etc.) **ver y operar** una app web corriendo, sin necesidad de un servidor Playwright MCP (y los ~3.500 tokens de contexto que cuesta).

Tres modos en un mismo binario:

1. **Modo URL** — snapshot one-shot de cualquier URL: screenshot + DOM + console + network + a11y + perf + page map.
2. **Modo Flow** — recetas declarativas multi-step que el agente puede escribir inline (`--flow -`). Cada paso apunta a elementos por **ref estable**, rol, texto, testId o selector. Los snapshots se pueden tomar en cualquier paso.
3. **Modo Diff** — compara dos manifests y devuelve un veredicto (`regression` / `changed` / `neutral`) con exit codes propios para loops de CI.

Diseñado alrededor de un principio: **darle al agente todo lo que necesita para navegar autónomamente, sin overhead de MCP.**

---

## ¿Por qué?

Los servidores MCP de navegador se comen el contexto. Un agente que carga Playwright MCP paga ~3.500 tokens de schema por sesión. Para la mayoría de los loops — "mirá la página", "clickeá esto", "comparar antes vs después" — ese overhead es desperdicio.

`visual-debug` resuelve el mismo problema en shell, con todo el estado en disco:

- Cada snapshot escribe un **page map** que lista todos los elementos interactuables con un `ref` estable. El agente puede planear su siguiente paso sin ver la pantalla.
- Los flows son **JSON que el agente arma inline** y pipea por stdin.
- Los diffs devuelven **exit codes** para que el agente (o CI) sepa si seguir iterando.

También funciona perfectamente como herramienta para humanos: regresión visual, triage de perf, o inspección rápida de a11y.

---

## Instalación

Requiere **Node 18+**.

```bash
git clone https://github.com/Jcibernet/visual-debug.git
cd visual-debug
npm install
```

(Opcional) hacerlo invocable globalmente:

```bash
npm link
# o
ln -s "$(pwd)/visual-debug.js" ~/.local/bin/visual-debug
chmod +x visual-debug.js
```

La primera corrida descarga Chromium vía Playwright (~170MB). Si ya tenés un Playwright instalado, apuntá `--executable` o `VISUAL_DEBUG_CHROMIUM` a tu binario existente.

---

## Quick start

```bash
# Modo URL (one-shot)
visual-debug https://example.com

# Modo Flow (multi-step)
visual-debug --flow flows/checkout.json

# Flow inline desde stdin — lo que hace típicamente un agente de IA:
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

# Diff entre dos corridas
visual-debug --diff before.manifest.json after.manifest.json
```

Cada corrida imprime un manifest JSON a stdout. Usá `--quiet` para imprimir sólo el manifest.

---

## El page map (feature clave para agentes)

Cada snapshot escribe `<name>.map.json` con un inventario estructurado de la página. El manifest además embebe los primeros 50 interactuables inline como `actions`, así el agente muchas veces no necesita abrir el archivo de map.

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

El `.map.json` completo además incluye:

- `forms` — cada formulario con sus fields, action, method.
- `landmarks` — `main`, `nav`, `header`, `footer`, etc.
- `headings` — h1/h2/h3 con su texto.

El agente lee el map, elige un `ref` y actúa.

---

## Flow recipes

Los flows son JSON. Cada step soporta una forma corta o la forma completa.

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

### Acciones soportadas

| Acción | Forma | Notas |
|---|---|---|
| `navigate` | `{ "navigate": "/path" }` | Las rutas relativas se resuelven contra `baseUrl` |
| `wait` | `{ "wait": "selector" }` o `{ "wait": 500 }` | Espera por selector o por ms |
| `snapshot` | `{ "snapshot": "name", "fullPage": true }` | Dump completo de devtools + page map |
| `click` | `{ "click": { "ref": 7 } }` | O por `role`, `text`, `testId`, selector crudo |
| `fill` | `{ "fill": { "[name=x]": "value" } }` | Multi-field por mapa selector→valor |
| `type` | `{ "type": { "ref": 3, "value": "hi" } }` | Caracter por caracter |
| `press` | `{ "press": "Enter" }` | Tecla del teclado |
| `select` | `{ "select": { "ref": 5, "value": "ar" } }` | Dropdown |
| `hover` | `{ "hover": { "ref": 7 } }` | |
| `scroll` | `{ "scroll": "selector" }` o `{ "scroll": { "y": 800 } }` | |
| `eval` | `{ "eval": "() => location.pathname" }` | Devuelve el resultado en la entrada del step |
| `pause` | `{ "pause": 300 }` | ms |

### Targeting (en orden de preferencia para el agente)

```jsonc
{ "click": { "ref": 7 } }                                  // por índice del page map
{ "click": { "role": "button", "name": "Pay" } }           // por rol + nombre accesible
{ "click": { "text": "Continue", "exact": false } }        // por texto visible
{ "click": { "testId": "submit" } }                        // por data-testid
{ "click": "[data-action=pay]" }                           // selector CSS crudo
{ "click": { "target": "[data-action=pay]", "button": "right" } } // forma completa
```

`ref` se recalcula contra el estado **actual** de la página en el momento del step, así que sigue siendo válido incluso después de cambios dinámicos del DOM.

### Optional / continue-on-error

- A nivel de step: `{ "click": "...", "optional": true }` — si falla queda como `skipped`.
- A nivel de flow: `"continueOnError": true` — todo step que falla queda como `skipped`.

Si un step no-opcional falla y `continueOnError` es false, el flow para, sale con exit code `1`, y la timeline parcial queda persistida.

---

## Modo Diff

```bash
visual-debug --diff <baseline-manifest> <candidate-manifest> \
  [--out ./.visual-debug] [--name <basename>] \
  [--fail-on console,network,perf,dom,screenshot,any]
```

Escribe `<name>.diff.json`:

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

**Exit code:** `1` si alguna de las categorías en `--fail-on` está flaggeada, sino `0`. Default `--fail-on console,network`. Usá `--fail-on any` para modo estricto.

Este es el primitive del loop "¿mi cambio rompió algo?".

---

## Todas las opciones

```
Modo URL:
  visual-debug <url> [opciones]

Modo Flow:
  visual-debug --flow <file|->                  Lee el flow JSON de archivo o stdin

Modo Diff:
  visual-debug --diff <baseline> <candidate>    Compara dos manifests JSON

Opciones compartidas:
  --out <dir>            Directorio de salida (default: ./.visual-debug)
  --name <basename>      Basename para los outputs (default: timestamp)
  --viewport <WxH>       Default 1440x900
  --device <name>        Descriptor de device de Playwright (ej. "iPhone 14")
  --wait <selector>      Espera por selector antes del primer snapshot
  --wait-ms <ms>         Espera extra después del load (default 500)
  --full-page            Screenshots full-page
  --dark                 colorScheme oscuro
  --no-screenshot --no-dom --no-console --no-network --no-a11y --no-perf
  --no-page-map          Saltea el inventario de interactuables
  --script <path>        Corre un archivo JS dentro de la página
  --auth-storage <path>  storageState JSON
  --user-agent <str>     Override del UA
  --executable <path>    Binario de Chromium
  --slow                 250ms de slowMo
  --quiet                Sólo emite JSON
  --fail-on <kinds>      Categorías para exit code del diff (default: console,network)
```

---

## Loop de iteración continua para agentes de IA

El loop que está pensado para el agente:

```
1. visual-debug <url> --name baseline       # snapshot del estado actual + page map
2. el agente lee baseline.manifest.json     # elige ref o selector para la próxima acción
3. el agente arma un flow JSON inline       # acciones apuntando a refs/roles/text
4. visual-debug --flow - --name attempt-1   # pipea por stdin, obtiene nuevos snapshots
5. visual-debug --diff baseline.manifest.json attempt-1-final.manifest.json
6. lee diff.verdict
   - "neutral"     → no hubo cambio; revisa el plan
   - "changed"     → delta esperado; continúa
   - "regression"  → revertir / iterar
7. goto 2
```

Todo en disco. El agente lee JSON con `cat`/`jq` — cero tokens extra de contexto.

---

## Recetas

### Inspección one-shot

```bash
visual-debug http://localhost:3000/checkout --full-page --wait "[data-step=payment]"
```

### Auth + inspección

```bash
visual-debug http://localhost:3000/dashboard --auth-storage ~/.auth/myapp.json
```

### Regresión visual en CI

```bash
visual-debug http://staging/$URL --name baseline --quiet
deploy_my_change
visual-debug http://staging/$URL --name after --quiet
visual-debug --diff baseline.manifest.json after.manifest.json --fail-on any
# El job falla si algo se regresó
```

### Mobile + gate de perf

```bash
visual-debug http://staging --device "iPhone 14" --no-screenshot --no-dom --no-a11y --quiet \
  | jq -e '.summary.perf.fcp < 2000'
```

### Flow inline de un agente (uso típico desde Droid / Claude Code)

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

## Comparación

|  | visual-debug | Playwright MCP | Script de Puppeteer | Lighthouse CLI |
|---|---|---|---|---|
| Tokens de contexto (sesión de agente) | **0** | ~3.500 | 0 | 0 |
| Screenshot | ✅ | ✅ | ✅ | ✅ |
| Captura de console / network | ✅ | ✅ | manual | parcial |
| Árbol de accesibilidad | ✅ | ✅ | manual | sólo scores |
| Métricas de perf | ✅ | parcial | manual | ✅ (más rico) |
| Page map / inventario de interactuables | ✅ | parcial | ❌ | ❌ |
| Flows declarativos multi-step | ✅ | imperativo | imperativo | ❌ |
| Diff entre corridas con exit code | ✅ | ❌ | manual | ❌ |
| Single file, cero config | ✅ | ❌ | ❌ | ✅ |

**No reemplaza a Playwright MCP** en flujos profundamente interactivos. **Sí es** el default más barato y rápido para loops de snapshot + navigate + diff.

---

## Cómo funciona

`visual-debug.js` es un único archivo ESM usando Chromium headless de Playwright. Forza `QT_QPA_PLATFORM=xcb` para sobrevivir desktops Wayland con plugins Qt rotos. Los collectors se registran antes de la navegación, cada captura está envuelta en try/catch (un asset roto nunca rompe la corrida entera), y cada step de un flow se timea y se loguea en el manifest del flow.

Los refs del page map se derivan de un walk fresco del DOM en el momento del step, así que no quedan stale después de re-renders.

---

## Contribuir

PRs bienvenidas. Restricciones:

- Mantener un solo archivo (o agregar una carpeta `lib/`, pero que el entrypoint quede mínimo).
- La única dep de runtime sigue siendo `playwright`.
- Tratar cada campo expuesto al agente como **API estable** una vez shippeado — los agentes lo leen.

---

## Licencia

MIT © Juan Cibernet
