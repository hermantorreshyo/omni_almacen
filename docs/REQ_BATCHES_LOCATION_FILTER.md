# SOLICITUD AL OMNI API CORE — Filtro de ubicación en lotes (FEFO por origen)

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint afectado:** `GET /api/v1/inventory/batches`
**Prioridad:** Media — hay workaround en cliente, pero produce selección de lote imprecisa
**Tipo:** Mejora aditiva (no rompe contrato existente)

---

## 1. Contexto

En la pantalla **`solicitar`** de [1003] el operario pide un traspaso indicando
únicamente **SKU + cantidad** (por requerimiento de negocio, no se le pide el lote).

Sin embargo, `POST /inventory/transfers` **exige `batch_id` por ítem**:

```json
{ "item_id": 5, "item_type": "sku", "batch_id": 1, "quantity_requested": 2000 }
```

Para no pedir el lote al usuario, el cliente lo resuelve por **FEFO** consultando:

```
GET /api/v1/inventory/batches?item_id=5
```

y tomando el lote de caducidad más próxima.

---

## 2. Problema

`GET /inventory/batches?item_id=` devuelve los lotes del SKU **sin discriminar la
ubicación/sede donde tienen stock**. Sus campos actuales:

| Campo | Uso |
|---|---|
| `id` | `batch_id` |
| `batch_reference` | Código del lote |
| `expiration_date` | Caducidad (FEFO) |

En un traspaso el **origen es el OBRADOR** (interlocutor `fabrica`). El FEFO debería
calcularse **sobre el stock existente en esa ubicación de origen**, pero al no poder
filtrar por ubicación el cliente puede elegir un `batch_id` que:

- no tiene stock en el origen, o
- pertenece a otra sede,

provocando un posible `ERR_STOCK` o un picking incoherente aguas abajo.

---

## 3. Solicitud

Añadir un filtro **opcional** por ubicación (y, si es viable, por interlocutor) a
`GET /inventory/batches`, devolviendo solo lotes **con stock disponible** en esa
ubicación, **ordenados por FEFO** (caducidad ascendente):

```
GET /api/v1/inventory/batches?item_id=5&location_id=1
GET /api/v1/inventory/batches?item_id=5&interlocutor_id=2   (alternativa por sede)
```

Sería muy útil incluir además la **cantidad disponible** por lote, para validar en
cliente que el lote FEFO cubre la cantidad solicitada:

| Campo propuesto | Uso |
|---|---|
| `quantity_available` | Stock disponible del lote en esa ubicación (unidad base) |

### Comportamiento esperado

- **Sin** `location_id`/`interlocutor_id` → comportamiento actual intacto (compatibilidad total).
- **Con** filtro → solo lotes con stock en esa ubicación/sede, FEFO ascendente.
- Si no hay lotes con stock en el origen → array vacío `[]` (el cliente avisa "sin lotes en bodega").

---

## 4. Beneficio

- El FEFO de la solicitud de traspaso se calcula sobre el **stock real del OBRADOR**.
- Se evitan `ERR_STOCK` por elegir un lote sin existencias en el origen.
- Mantiene la UX acordada: el operario sigue indicando solo **SKU + cantidad**.

---

## 5. Impacto en [1003]

Mínimo y ya preparado: en cuanto el filtro esté disponible, el cliente pasará a
llamar `GET /inventory/batches?item_id=&location_id={origen}` y, si se expone
`quantity_available`, validará la cobertura del lote FEFO antes de añadir el ítem.
No se requiere cambio de contrato en los endpoints de traspaso.

---

*[1003] — Solicitud generada para el hilo del API CORE. No requiere cambios en otros subsistemas.*
