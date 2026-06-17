# Ejemplo: pipeline efímero → emit-manifest → diff-against

El loop default de v0.3.0. **No escribe nada en el repo.** Capturás un baseline
en una variable/archivo temporal, hacés tu cambio, y comparás — todo por stdout
y stdin.

## 1. Baseline a un archivo temporal

```bash
# --emit-manifest manda el manifest completo a stdout; el resumen va a stderr.
visual-debug http://localhost:3000/dashboard --emit-manifest > /tmp/baseline.json
```

Lo único que toca el disco persistente es ese `/tmp/baseline.json` que vos
elegiste. El run en sí (map, layout SVG, uxReport) vivió en un tmp dir y ya se
borró.

## 2. Editás el código y esperás el rebuild/HMR

(tu cambio acá)

## 3. Comparás el estado nuevo contra el baseline, en un solo pipe

```bash
visual-debug http://localhost:3000/dashboard --emit-manifest \
  | visual-debug --diff-against /tmp/baseline.json - --fail-on layout,ux
echo "exit=$?"
```

- El `-` significa "leé el candidate del stdin".
- `--fail-on layout,ux` hace que el comando salga con código `1` si el layout
  se movió o aparecieron findings UX nuevos.
- Leé el `verdict` del diff: `neutral` (sin cambio), `changed` (delta esperado),
  `regression` (errores de consola/red o findings UX nuevos).

## 4. (opcional) Mismo loop con un flow multi-paso

```bash
echo '{
  "name": "dash",
  "baseUrl": "http://localhost:3000",
  "steps": [
    { "navigate": "/login" },
    { "fill": { "[name=email]": "a@b.com", "[name=password]": "x" } },
    { "click": { "role": "button", "name": "Log in" } },
    { "wait": "[data-page=dashboard]" },
    { "snapshot": "dashboard" }
  ]
}' | visual-debug --flow - --emit-manifest > /tmp/baseline.json
```

El flow manifest promueve el `layout` y `uxReport` del snapshot final, así que
es diffeable directo contra otro flow manifest con `--diff-against`.
