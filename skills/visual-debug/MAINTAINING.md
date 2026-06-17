# SKILL Maintenance Guide

> Para el agente que USA `visual-debug` y nota algo que la skill no le anticipó.
> Esto NO te dice qué cambiar — te da los criterios y herramientas para decidirlo.

Ubicación sugerida: `skills/visual-debug/MAINTAINING.md`.

---

## Principios invariantes

Toda mejora al `SKILL.md` debe respetar estos cuatro principios. Si una edición propuesta viola alguno, descartala o reformulala.

1. **Agent-first, no FYI.** Cada línea del SKILL.md tiene que cambiar lo que vas a hacer. Si una sección "es bueno saberlo" pero no cambia ninguna decisión, no va. Va en el README, en `--help`, o en ningún lado.

2. **Una sola fuente de verdad por tipo de conocimiento.**
   - Comportamiento del binario → código + `--help`.
   - Decisiones del agente (cuándo, cómo, qué leer) → SKILL.md.
   - Ejemplos largos → `examples/`.
   Si estás por copiar texto de `--help` al SKILL.md, parate: linkealo, no lo dupliques. La duplicación es el principal vector de drift.

3. **Concreto sobre abstracto.** "No leas el PNG salvo que `uxReport` tenga severity:error" es una regla. "Sé eficiente con el contexto" no es una regla, es un slogan. Las reglas tienen condición observable + acción.

4. **El silencio es una decisión.** No documentar algo es elegir que el agente lo resuelva por instinto. Eso está bien cuando el caso es raro o cuando los principios generales alcanzan. Si una sección crece más allá de ~150 líneas, el problema probablemente no es que falten reglas — es que sobran.

---

## Señales de que el SKILL.md necesita una actualización

Disparadores concretos. Si reconocés uno durante tu trabajo, abrí el ciclo de mejora.

- **Tuviste que improvisar.** Hiciste un judgment call que el SKILL.md no cubría, y la decisión no es obvia desde los principios generales. Anotalo.
- **Releíste la misma sección 2+ veces en una tarea.** Síntoma de que la información existe pero está mal ubicada o ambigua.
- **Una corrección del usuario implica una falla de skill.** Si el usuario te dice "no, hacelo así", revisá si la skill te llevaba a la opción equivocada. Si sí, es bug de skill, no error tuyo.
- **Un flag o comportamiento del tool cambió** y la skill sigue diciendo lo viejo. Esto es drift puro.
- **Repetiste un anti-patrón documentado.** Esto significa que el anti-patrón está mal ubicado (debería estar más cerca del trigger) o mal redactado (no era reconocible en contexto).
- **Otro agente (en otra sesión, otro proyecto) tomó una decisión peor con la misma skill.** Si tenés acceso a esa evidencia, vale como señal.
- **Encontraste un patrón project-specific que se repite.** Si en este proyecto la URL siempre es `localhost:5173` y no `3000`, eso no va al SKILL.md global, va a un override local (ver "Capas").

Si **no** estás viendo ninguna de estas señales, no edites. Las skills se degradan más por agregado oportunista que por estar incompletas.

---

## El ciclo de mejora

Cuando una señal dispara, seguí estos cinco pasos. No saltes el paso 2: la reproducción es lo que separa una regla útil de una superstición.

### 1. Observar
Anotá literal:
- Qué estabas tratando de hacer
- Qué dijo el SKILL.md
- Qué hiciste vos
- Qué pasó

### 2. Reproducir
¿Pasaría de nuevo en otra sesión con otro agente leyendo el mismo SKILL.md? Si no podés argumentar que sí, probablemente fue ruido. Frecuencia mínima sugerida para promover a regla: **2 ocurrencias independientes**, o **1 ocurrencia con costo alto** (rompiste algo, perdiste tiempo significativo, llevaste al usuario a un dead-end).

### 3. Generalizar
La regla debe aplicar a una clase de casos, no a tu instancia específica. "No leer PNG cuando uxReport está limpio" es una clase. "No leer PNG en el proyecto Antü" es una instancia — va a override local, no al SKILL.md.

Test rápido: si tu propuesta de edit empieza con un nombre propio de proyecto, URL hardcoded, o "en este caso particular", reformulala.

### 4. Patchar
Encontrá la sección existente más cercana al lugar donde el agente futuro va a estar leyendo cuando enfrente esta decisión. Pista: no es donde está más "ordenado" — es donde va a estar **mirando**.

Reglas de redacción:
- Imperativo, no descriptivo. "Leé X" no "Es útil leer X".
- Una decisión por bullet. Si tu bullet tiene "y/o", probablemente son dos.
- Condición observable al frente: "Si `uxReport.errors[]` no está vacío..." no "En casos donde puede haber problemas...".
- Si necesitás más de 3 líneas para explicar la regla, la regla probablemente sea ambigua.

### 5. Validar
Ver sección "Validación" abajo. Si no la podés validar, no la mergees.

---

## Herramientas concretas

### Drift check: ¿la skill describe el tool actual?

```bash
# El regex incluye dígitos ([a-z0-9-]) para no partir flags como --no-a11y.
# Flags documentados en SKILL.md
grep -oE '\-\-[a-z][a-z0-9-]+' skills/visual-debug/SKILL.md | sort -u > /tmp/skill-flags.txt

# Flags reales del tool
visual-debug --help 2>&1 | grep -oE '\-\-[a-z][a-z0-9-]+' | sort -u > /tmp/tool-flags.txt

# Solo lo documentado que NO existe en --help (el caso que importa: drift puro).
echo "--- documentado pero inexistente: ---"
comm -23 /tmp/skill-flags.txt /tmp/tool-flags.txt
```

Lo que aparece ahí → flag documentado que ya no existe (eliminar del SKILL.md).

Para el caso inverso (flag nuevo no documentado), mirá `comm -13`. **No asumas
que todo flag nuevo necesita doc**: el SKILL.md documenta decisiones, no el
catálogo completo de flags (eso es `--help`). Es esperable y correcto que `--help`
tenga muchos flags que el SKILL.md no menciona.

Corré esto cuando bumpeás versión del tool, o cuando una decisión basada en la skill falló por flag inexistente.

### Smoke test: ¿la skill te lleva a la acción correcta?

Tené un archivo `skills/visual-debug/scenarios.md` con casos canónicos. Formato:

```
## Escenario: usuario dice "se rompió el header después de mi último cambio"
Acción esperada:
  1. visual-debug http://<url-local> --emit-manifest 2>/dev/null | jq '.uxReport'
  2. Si hay findings en uxReport → leer .layout.svg (outputs.layoutSvg), solo los <rect> con data-issue
  3. NO leer PNG
Fundamento en skill: sección "Qué leer y qué IGNORAR".
```

> Nota de forma: `uxReport` vive en la **raíz** del manifest (tanto en snapshot
> como en flow — el flow promueve el del snapshot final). En `.snapshots[]` solo
> hay `name`/`summary`/`manifestPath`/`layoutSvg`. No apuntes a
> `.snapshots[].uxReport`.

Periódicamente (o cuando hacés cambios al SKILL.md), tomá un escenario, leé el SKILL.md como si fuera la primera vez, y predecí qué harías. Si tu predicción difiere de la "acción esperada", o el escenario está mal, o la skill está mal. Investigá cuál.

### Self-test prompt (para correr en otra sesión limpia)

Pegále esto a otra instancia del mismo modelo, con la skill cargada:

```
Te paso un escenario. Decime exactamente qué comandos correrías, en qué orden, y
qué archivos leerías del output. NO ejecutes nada. NO me preguntes aclaraciones.
Respondé solo con la secuencia de acciones, fundamentada por la skill.

Escenario: <pegá uno de scenarios.md>
```

Compará la respuesta contra la acción esperada. Las desviaciones señalan ambigüedad en la skill — más útil que tu propio juicio porque no tenés sesgo de "yo ya sé lo que quiero que diga".

### Manifest archeology

Si tenés runs persistidos en `.visual-debug/`, son evidencia de decisiones pasadas:

```bash
# ¿Qué heurísticas dispararon más seguido?
# (uxReport está en la raíz del manifest; los archivos son <name>.manifest.json)
jq -r '.uxReport | to_entries[]
        | select(.key != "errors" and (.value | type == "array") and (.value | length > 0))
        | .key' \
  .visual-debug/*/*.manifest.json | sort | uniq -c | sort -rn
```

Si una heurística dispara muy seguido pero la skill no la menciona en la sección "Qué leer", probablemente debería. Si una nunca dispara, capaz no merece su párrafo dedicado.

---

## Curación: cuándo agregar, cuándo NO, cuándo borrar

### Agregar al SKILL.md cuando:
- Hay evidencia de >=2 ocurrencias o 1 con costo alto.
- La regla aplica a una clase, no a una instancia.
- El comportamiento que la regla previene o promueve no es obvio desde los principios generales.
- Existe un lugar natural en la estructura actual donde insertarla.

### NO agregar al SKILL.md cuando:
- Es información sobre cómo funciona el tool internamente → va al README o a comentarios en código.
- Es una preferencia del usuario actual → va a memoria del agente o a override local, no a skill global.
- Es un error del tool que debería arreglarse en el código → abrí un issue, no documentes el workaround salvo que sea temporal y explícito.
- Es algo que `--help` ya dice → linkealo, no lo dupliques.
- Es un consejo de "buena práctica" sin condición observable → es slogan, no regla.

### Borrar cuando:
- La regla habla de un flag o comportamiento que ya no existe.
- El anti-patrón que documenta ya es imposible (porque el tool lo previene).
- Dos secciones dicen lo mismo con palabras distintas — borrá una, dejá la mejor ubicada.
- Una regla nunca matcheó en los smoke tests ni en uso real durante varias versiones.

Borrar es tan importante como agregar. Una skill larga es una skill que nadie lee entera.

---

## Capas: SKILL.md global vs override local

No todo va en el mismo archivo.

- **`skills/visual-debug/SKILL.md`** (del repo del tool): reglas universales, aplican a cualquier proyecto que use visual-debug.
- **`<proyecto>/.factory/skills/visual-debug.override.md`** (o equivalente del sistema de skills): overrides project-specific. URLs locales, comandos custom, atajos que solo tienen sentido acá.
- **Memoria del agente / preferencias del usuario**: cosas como "este usuario siempre quiere ver el PNG aunque no haya errors" — no es regla universal, es preferencia personal.

Antes de editar el SKILL.md global, preguntate: ¿esto le sirve a otro agente en otro proyecto? Si no, va a la capa local.

---

## Cómo proponer un cambio

1. Hacé el cambio en una rama o en un draft del SKILL.md.
2. Corré el drift check.
3. Corré el smoke test en una sesión limpia (no la tuya).
4. Documentá en el PR/commit: la señal que disparó el cambio, evidencia (2+ ocurrencias o ejemplo de alto costo), y qué smoke test agregás/modificás.
5. Bumpeá la versión del SKILL.md en su frontmatter si:
   - Removiste reglas (potential breaking change para agentes que dependían de ellas).
   - Cambiaste defaults documentados.
   No la bumpees por agregar aclaraciones.

---

## Validación antes de commitear

Checklist:

- [ ] Drift check: cero divergencia no intencional con `--help`.
- [ ] Smoke test: todos los escenarios siguen llegando a la acción esperada.
- [ ] Self-test en sesión limpia: el cambio resuelve la ambigüedad que motivó la edición.
- [ ] El SKILL.md no creció más de lo que se sumó en `scenarios.md`. Si agregaste 30 líneas de skill sin agregar ningún escenario, sospechá.
- [ ] Cada regla nueva tiene condición observable + acción imperativa.
- [ ] Ningún bullet contiene "y/o", "podrías considerar", "en general".
- [ ] Si borraste algo, anotaste por qué en el commit (no en el SKILL.md).

---

## Meta: cuándo editar este archivo

`MAINTAINING.md` también puede tener drift. Si encontraste una señal recurrente de que la skill falla pero ninguno de los "Signals" de arriba la captura, agregalo acá. Si una herramienta concreta (drift check, smoke test) dejó de servir, reemplazala.

Los mismos principios aplican: agent-first, una fuente de verdad, concreto sobre abstracto, el silencio es una decisión.
