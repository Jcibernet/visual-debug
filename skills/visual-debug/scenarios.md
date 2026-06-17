# scenarios — casos canónicos para smoke-testear el SKILL.md

Cada escenario es un caso real de uso. Para validar la skill: leé el SKILL.md
como si fuera la primera vez, predecí tu secuencia de acciones, y compará contra
"Acción esperada". Si difieren, o el escenario está mal o la skill está mal.

Ver `MAINTAINING.md` → "Smoke test" y "Self-test prompt".

Notas de forma (valen para todos los escenarios):
- `uxReport` está en la **raíz** del manifest, no en `.snapshots[]`.
- Los runs efímeros imprimen su ruta en **stderr**; el manifest va a **stdout**
  solo con `--emit-manifest`.
- Por default **no se genera ningún PNG/JPEG**.

---

## Escenario 1: "se rompió el header después de mi último cambio"
Trigger: el usuario reporta un problema de layout tras un cambio.

Acción esperada:
  1. Verificar que la app esté corriendo (puerto del dev server).
  2. `visual-debug http://<url-local> --emit-manifest 2>/dev/null | jq '.uxReport, .summary.uxFindings'`
  3. Si hay findings → leer `outputs.layoutSvg` con Read, mirar solo los `<rect>`
     con `data-issue`.
  4. NO leer PNG.
Fundamento en skill: "Cuándo invocar" (trigger 3) + "Qué leer y qué IGNORAR".

---

## Escenario 2: "estoy por rediseñar la página de settings"
Trigger: el agente está por modificar UI y necesita un baseline para comparar.

Acción esperada:
  1. `visual-debug http://<url-local>/settings --persist-as settings-baseline`
     (persistente: es baseline de un trabajo largo).
  2. Leer el `uxReport` y el `.layout.svg` para entender la vista antes de tocarla.
  3. Editar el código.
  4. Comparar: `visual-debug http://<url-local>/settings --emit-manifest
     | visual-debug --diff-against .visual-debug/settings-baseline/*.manifest.json - --fail-on layout,ux`
  5. Leer `verdict`.
Fundamento en skill: "Cuándo invocar" (trigger 1) + "Cuándo persistir".

---

## Escenario 3: "verificá que mi fix no rompió nada" (loop efímero)
Trigger: el agente acaba de modificar UI y quiere verificar.

Acción esperada:
  1. Baseline efímero a archivo: `visual-debug http://<url-local> --emit-manifest > /tmp/baseline.json`
  2. (el cambio ya está hecho; si no, editar y esperar HMR)
  3. `visual-debug http://<url-local> --emit-manifest | visual-debug --diff-against /tmp/baseline.json - --fail-on layout,ux`
  4. `verdict: regression` → revertir/ajustar. `neutral`/`changed` → ok.
  5. NO `--persist` (no se va a comparar contra este run más tarde).
Fundamento en skill: "Modo diff" + "Anti-patrones" (no persistir por las dudas).

---

## Escenario 4: "revisá la accesibilidad de este form"
Trigger: debug de accesibilidad.

Acción esperada:
  1. `visual-debug http://<url-local>/form --emit-manifest 2>/dev/null
     | jq '.uxReport | {unlabeledInputs, unnamedButtons, lowContrastPairs, imagesWithoutAlt}'`
  2. Reportar con los `code`/`message`/`severity` concretos de cada finding.
  3. NO leer PNG (las heurísticas a11y son texto).
Fundamento en skill: "Qué leer y qué IGNORAR" + tabla de heurísticas (README).

---

## Escenario 5: hay que loguearse antes de ver la vista
Trigger: la vista objetivo requiere navegación/estado previo.

Acción esperada:
  1. Armar un flow inline con los steps de login + snapshot, pipearlo por stdin:
     ```
     echo '{"name":"x","baseUrl":"http://<url-local>","steps":[
       {"navigate":"/login"},
       {"fill":{"[name=email]":"a@b.com","[name=password]":"x"}},
       {"click":{"role":"button","name":"Log in"}},
       {"wait":"[data-page=dashboard]"},
       {"snapshot":"dashboard"}
     ]}' | visual-debug --flow - --emit-manifest
     ```
  2. Alternativa si ya hay sesión guardada: `--auth-storage <storageState.json>`.
Fundamento en skill: "Modo flow" + flag `--auth-storage`.

---

## Escenario 6: revisión de PR que toca archivos de frontend
Trigger: el agente revisa un PR con cambios de UI.

Acción esperada:
  1. Identificar las vistas afectadas por los archivos del diff.
  2. Snapshot efímero de cada una: `visual-debug http://<url-local>/<vista> --emit-manifest 2>/dev/null | jq '.uxReport, .summary'`
  3. Reportar con evidencia: qué findings UX hay, no impresiones.
  4. NO leer PNG salvo `--screenshot-on-issue` con un finding `severity:'error'`.
Fundamento en skill: "Cuándo invocar" (trigger 4) + "Output al usuario".

---

## Escenario 7 (anti-trigger): "¿cómo instalo visual-debug?"
Trigger: pregunta informativa, NO requiere correr el tool.

Acción esperada:
  - Responder desde el README (`npm i -g @jcibernet/visual-debug`). NO invocar la
    skill ni correr el binario.
Fundamento en skill: la skill cambia decisiones de inspección/verificación, no
responde preguntas de instalación. (Principio "Agent-first" de MAINTAINING.md.)
