# REQUERIMIENTO AL OMNI API CORE — Categoría por ítem para el picking ordenado

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoints afectados:** `GET /api/v1/inventory/transfers/{id}` (detalle) y
`GET /api/v1/catalog/skus`
**Prioridad:** Alta — habilita el alistamiento ordenado por zona del almacén
**Estado:** ✅ ATENDIDA (2026-07) — el core adoptó la opción B: `GET /transfers/{id}` devuelve por ítem `category_name`, `pick_sequence`, `family_id/name`. Nuevo `categories.pick_sequence` (menor = primero; null = alfabético). [1003] lee del detalle y ordena por pick_sequence; catálogo queda solo como fallback para supplier_item.

---

## 1. Necesidad de negocio

En el **picking**, el operario recorre el almacén por **categorías** (los productos
están físicamente agrupados por categoría en las estanterías). Para que el recorrido
sea eficiente, [1003] agrupa y ordena los ítems del traspaso por categoría antes de
mostrarlos. Un agrupamiento claro reduce el tiempo de alistamiento y los errores.

Hoy [1003] intenta resolver la categoría cruzando cada `item_id` del traspaso contra
`GET /catalog/skus`, pero **el catálogo no expone un campo de categoría estable** por
SKU (solo `item_type`: MP/CD/PN/PT, que es el *tipo*, no la *categoría comercial* con la
que se organiza la bodega). Resultado: el agrupamiento cae a "Sin categoría" o agrupa por
tipo, que no coincide con la disposición física real.

## 2. Lo que se solicita

### A) Exponer la categoría (y familia) en el SKU

En `GET /catalog/skus`, incluir por SKU:

| Campo | Tipo | Descripción |
|---|---|---|
| `category_id` | int | ID de la categoría comercial del SKU |
| `category_name` | string | Nombre legible de la categoría (p. ej. "Ingredientes fríos") |
| `family_id` | int | ID de la familia (nivel superior) |
| `family_name` | string | Nombre de la familia |

Recordatorio de jerarquía acordada: **familias → categorías → SKUs**. Para el picking nos
basta `category_name` (con `category_id` para orden estable); `family_*` es deseable para
un segundo nivel de agrupación si algún almacén lo requiere.

### B) Incluir la categoría en el detalle del traspaso (preferido)

En `GET /api/v1/inventory/transfers/{id}`, dentro de cada objeto de `data.items[]`,
devolver ya resuelta la categoría del ítem, para no tener que cruzar contra el catálogo:

```json
{
  "id": 1,
  "item_id": 101,
  "item_type": "sku",
  "sku_final_code": "MP-CAN-CAR-000111",
  "name": "Harina de trigo especial",
  "category_id": 12,
  "category_name": "Harinas y granos",
  "family_id": 3,
  "family_name": "Materia prima",
  "quantity_requested": 10,
  "quantity_picked": 8
}
```

Esto es lo ideal para el picking: [1003] agrupa directamente por `category_name` /
`category_id` sin llamadas extra.

### C) Orden de categorías para el recorrido (opcional pero muy útil)

Si el maestro de categorías tuviera un campo de **orden de recorrido** (p. ej.
`sort_order` o `pick_sequence`), exponerlo en `category` para que [1003] ordene las
categorías en el mismo orden en que están dispuestas físicamente en el almacén, en vez
de alfabéticamente. Si no existe, [1003] ordenará por `category_name` alfabético.

## 3. Comportamiento provisional en [1003]

Mientras no llegue la categoría fiable, [1003] agrupa por el mejor dato disponible
(`category_name` si aparece, si no `item_type`), con caída a "Sin categoría". El
agrupamiento visual ya está implementado (encabezados de categoría, tarjeta con
SKU · categoría y nombre destacado); solo necesita el dato correcto de origen.

## 4. Preguntas al core

1. ¿Prefieren exponerlo en el detalle del traspaso (opción B) o esperan que [1003] lo
   cruce siempre contra `GET /catalog/skus` con los nuevos campos (opción A)?
2. ¿Existe ya un orden de recorrido/secuencia de categorías en el maestro, o agrupamos
   alfabéticamente por ahora?

---
*[1003] — Requerimiento para el hilo del API CORE.*
