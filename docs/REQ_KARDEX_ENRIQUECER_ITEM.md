# REQUERIMIENTO AL OMNI API CORE — Enriquecer `analytics/kardex` con datos del ítem

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint afectado:** `GET /api/v1/analytics/kardex`
**Prioridad:** Media — no bloquea, pero mejora eficiencia y beneficia a varios subsistemas
**Estado:** ✅ ATENDIDA (2026-07) — el core enriquece `GET /analytics/kardex` con `item_name`, `sku_final_code`, `category_name`, `unit_of_measure` en todos los movimientos (sin opt-in, join sin exclusión por item_type). [1003] lee estos campos directo y eliminó el cruce de 6 consultas al catálogo (función skuNameMap removida).
**Alcance:** transversal (cualquier subsistema que genere reportes o consulte movimientos
de inventario: [1002], [1003], [1004], [1006], [1007]…)

---

## 1. Situación actual

`GET /analytics/kardex` devuelve, por movimiento, campos como:

```json
{
  "id": 1338,
  "movement_category": "RECEPCION",
  "movement_type": "Merma",
  "quantity": "-1.0000",
  "resulting_balance": "-2.0000",
  "reason": "PARA_PROMOCION",
  "reference_document": null,
  "created_at": "2026-07-31 06:35:13.796",
  "username": "mauricio.rojas",
  "item_id": 1290,
  "item_type": "sku",
  "qr_code_uid": "LEG-MER-A0-0",
  "area_type": "zona_mermas",
  "interlocutor_name": "LEGANES",
  "batch_reference": "MERMA-20260726-344F",
  "expiration_date": "2027-07-26"
}
```

**Trae `item_id` pero NO el nombre ni el código del producto.** Para mostrar un reporte
legible (Historial de Mermas, por ejemplo) hay que **cruzar cada `item_id` contra
`GET /catalog/skus`** en el cliente.

## 2. Problema

El cruce en cliente es costoso y frágil:

- **Múltiples llamadas al catálogo.** El endpoint `GET /catalog/skus` excluye por defecto
  ciertos `item_type` según el subsistema (para [1003] excluye `PT` y `PV`). Para no perder
  ningún nombre hay que pedir **todos los tipos por separado** (general + PT + PV + MP + CD
  + PN) y fusionar — 6 consultas solo para resolver nombres de un reporte.
- **Caso real detectado:** un producto `item_type = "PV"` (ej. `item_id 1290`,
  "Roscon arequipe") no aparecía en la consulta general y salía "sin nombre" hasta añadir
  la consulta explícita de PV. Cada tipo nuevo que se agregue al maestro repite el problema.
- **No escala.** Con catálogos grandes, traer 1000+ SKUs por tipo para resolver un puñado
  de nombres es ineficiente. Y **todo subsistema que haga reportes de kardex tendrá que
  reimplementar este mismo cruce**.

## 3. Lo que se solicita

Incluir en cada movimiento de `GET /analytics/kardex` los datos identificativos del ítem,
ya resueltos por el core (que tiene el join directo, sin exclusiones por `item_type`):

| Campo | Tipo | Descripción |
|---|---|---|
| `item_name` | string | Nombre legible del producto (ej. "Roscon arequipe") |
| `sku_final_code` | string | Código SKU (ej. "PV-SIN-SIN-001290") |
| `category_id` | int | Categoría del ítem |
| `category_name` | string | Nombre de la categoría |
| `unit_of_measure` | string | `g` · `ml` · `ud` (para mostrar la unidad correcta) |

Ejemplo de respuesta deseada (mismo movimiento de arriba, enriquecido):

```json
{
  "id": 1338,
  "movement_type": "Merma",
  "quantity": "-1.0000",
  "reason": "PARA_PROMOCION",
  "item_id": 1290,
  "item_type": "sku",
  "item_name": "Roscon arequipe",
  "sku_final_code": "PV-SIN-SIN-001290",
  "category_id": 286,
  "category_name": "Sin Clasificar",
  "unit_of_measure": "ud",
  "interlocutor_name": "LEGANES",
  "created_at": "2026-07-31 06:35:13.796"
}
```

Notas:

- El join debe resolver el nombre **sin importar el `item_type`** (que no aplique la
  exclusión de `PT`/`PV` que sí tiene `GET /catalog/skus`): el kardex es un reporte
  histórico, no una lista de ítems solicitables.
- Si el ítem no es un SKU de catálogo (`item_type` distinto de `sku`), estos campos pueden
  venir `null` — el cliente ya contempla el fallback.
- Idealmente el enriquecimiento se aplica a **todo** `GET /analytics/kardex`
  (independiente de `movement_type`), no solo a mermas, para que sirva a cualquier reporte.

## 4. Beneficio

- Elimina 6 consultas de catálogo por apertura de reporte en [1003].
- **Un solo lugar** (el core) resuelve el nombre correctamente; ningún subsistema tiene que
  reimplementar el cruce ni conocer las reglas de exclusión por `item_type`.
- Reportes consistentes en [1002]/[1003]/[1004]/[1006]/[1007] y cualquier consulta futura
  de inventario/movimientos.

## 5. Comportamiento provisional en [1003]

Mientras tanto, [1003] resuelve los nombres cruzando contra `GET /catalog/skus` pidiendo
todos los `item_type` y fusionando, con reintento por `item_id`. Funciona, pero es el
workaround que este REQ busca eliminar. Cuando el kardex incluya `item_name`, [1003] leerá
ese campo directamente y quitará el cruce.

## 6. Pregunta al core

¿Prefieren enriquecer siempre (todos los movimientos) o exponer un parámetro opt-in
(ej. `?include_item=1`) para no aumentar el payload en consultas que no lo necesiten?
Para [1003] cualquiera de las dos sirve; sugerimos "siempre" por simplicidad de consumo.

---
*[1003] — Requerimiento para el hilo del API CORE.*
