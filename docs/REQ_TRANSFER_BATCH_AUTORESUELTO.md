# SOLICITUD AL OMNI API CORE — Auto-resolver `batch_id` en traspasos

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint afectado:** `POST /api/v1/inventory/transfers`
**Prioridad:** Alta — bloquea montar pedidos de SKUs sin lote durante la implantación
**Tipo:** Alineación con el comportamiento ya aplicado en `POST /inventory/scrap`

---

## 1. Contexto

En la pantalla **`solicitar`** el operario pide un traspaso indicando solo
**SKU + cantidad** (por requerimiento de negocio no se le pide el lote). El
cliente resuelve el lote por **FEFO** y lo envía como `batch_id`.

Recientemente el API simplificó `POST /inventory/scrap`: `location_id` y
`batch_id` dejaron de ser obligatorios y **el API los resuelve** (zona de la
sede + lote FEFO, creando uno si no existe).

## 2. Problema

`POST /inventory/transfers` **sigue exigiendo `batch_id` por ítem**:

```json
{ "ok": false, "error": "Cada ítem requiere: item_id, batch_id, quantity_requested.", "code": "ERR_VALIDATION" }
```

Durante la implantación hay SKUs que **aún no tienen ningún lote** (no se han
recibido ni cargado por inventario inicial). Para esos SKUs el cliente no tiene
un `batch_id` que enviar, y el pedido **no puede montarse**, aunque el negocio
quiere dejar registrada la solicitud para atenderla cuando haya existencias.

## 3. Solicitud

Aplicar a `POST /inventory/transfers` el **mismo criterio que a `scrap`**:

- Hacer `batch_id` **opcional** por ítem.
- Si se omite, el API resuelve el lote **FEFO** del SKU en la ubicación de origen
  y, **si no existe ningún lote**, crea uno automático (p.ej.
  `INV-PENDIENTE-YYYYMMDD-{id}` o el que corresponda) para poder registrar la
  solicitud.
- Mantener el comportamiento actual cuando el `batch_id` **sí** se envía.

### Payload deseado (batch_id opcional)

```json
{
  "location_id_origin": 1,
  "location_id_destination": 5,
  "notes": "Reposición tienda centro",
  "items": [
    { "item_id": 111, "item_type": "sku", "quantity_requested": 10 }
  ]
}
```

## 4. Comportamiento esperado según parámetros

| `inventory_restriction` | Lote/stock | Comportamiento |
|---|---|---|
| `false` (implantación) | sin lote o stock 0 | ✅ Registrar; API resuelve/crea lote |
| `true` (producción) | stock ≥ solicitado | ✅ Registrar |
| `true` (producción) | stock < solicitado | ❌ Bloquear |

## 5. Impacto en [1003]

Mínimo y ya preparado: cuando el API acepte `transfers` sin `batch_id`, el cliente
volverá a omitirlo cuando no haya lote (ya se hizo esa lógica y se revirtió al
detectar que el endpoint aún lo exige). No se requiere cambio de contrato en el
resto del workflow de traspasos.

---

*[1003] — Solicitud generada para el hilo del API CORE. No afecta a otros subsistemas.*
