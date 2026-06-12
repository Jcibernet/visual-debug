# Receta del loop de agente

Éste es el loop canónico que corre un agente de IA con `visual-debug`. Cada
paso es o un Execute de shell o una lectura de JSON — sin contexto MCP
requerido.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. SNAPSHOT del estado actual                                          │
│     $ visual-debug http://localhost:3000/$URL --name baseline --quiet   │
│                                                                         │
│  2. LEER manifest + actions                                             │
│     $ cat .visual-debug/baseline.manifest.json | jq '.actions, .summary'│
│                                                                         │
│  3. PLANEAR siguiente acción contra un ref / role / text                │
│     → el agente decide: click ref 7, fill ref 3, navegar /foo, etc.     │
│                                                                         │
│  4. EJECUTAR vía flow inline                                            │
│     $ echo '{...steps...}' | visual-debug --flow - --name attempt-1     │
│                                                                         │
│  5. DIFF baseline vs resultado                                          │
│     $ visual-debug --diff baseline.manifest.json \                      │
│         attempt-1-final.manifest.json --fail-on console,network         │
│                                                                         │
│  6. RUTEAR por veredicto                                                │
│       neutral    → el agente revisa el plan (no hubo efecto)            │
│       changed    → delta esperado; continúa                             │
│       regression → revertir / iterar                                    │
│                                                                         │
│  7. GOTO 2                                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

El agente sólo necesita leer tres archivos chicos por iteración:
- `.manifest.json` (~5–15 KB)
- `.diff.json` (~1–3 KB)
- Ocasionalmente `.map.json` cuando el array `actions` inline no alcanza.

Los assets pesados (screenshot, DOM, network) quedan en disco y sólo se
abren cuando hace falta debuggear puntualmente — nunca se gastan contra el
contexto.
