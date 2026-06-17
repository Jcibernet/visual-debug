# Ejemplo: baseline persistente para un refactor grande

Caso de uso de `--persist-as`: vas a hacer un refactor grande de la UI y querés
un baseline nombrado para comparar al final (o en cada iteración). Esto es lo
único para lo que conviene persistir — **no persistas "por las dudas".**

## 1. Establecé el baseline ANTES de tocar nada

```bash
visual-debug http://localhost:3000/settings --persist-as settings-baseline
```

Queda en `.visual-debug/settings-baseline/`. Si la corrés de nuevo con el mismo
nombre, **sobreescribe** (vos la nombraste, vos sos dueño).

## 2. Hacés el refactor (varias iteraciones)

(tus cambios acá)

## 3. Comparás el estado actual contra el baseline persistido

```bash
visual-debug http://localhost:3000/settings --emit-manifest \
  | visual-debug --diff-against .visual-debug/settings-baseline/*.manifest.json - \
      --fail-on layout,ux
```

## 4. Al terminar, limpiá

```bash
# Borra runs cuyo DOM ya no matchea el baseline guardado.
visual-debug runs --prune-stale --yes

# O borrá todo lo persistido cuando ya no lo necesitás.
visual-debug runs --clean --yes
```

## Variante: capturar un estado roto reproducible para un bug report

```bash
visual-debug "http://localhost:3000/broken-page" \
  --persist-as bug-1234 --screenshot-on-issue
```

`--screenshot-on-issue` agrega un raster **solo si** alguna heurística disparó un
finding `severity:'error'`, así el bug report tiene la evidencia visual sin
generar PNGs al pedo en los casos sanos.
