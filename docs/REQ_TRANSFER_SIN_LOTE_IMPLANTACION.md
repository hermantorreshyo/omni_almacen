# SOLICITUD AL OMNI API CORE — Registrar traspaso sin lote cuando el control de inventario está deshabilitado

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint afectado:** `POST /api/v1/inventory/transfers`
**Prioridad:** Alta — bloquea el arranque de la implantación (Paso 2)
**Consolida:** esta solicitud + la anterior (`batch_id` auto-resuelto en traspasos)

---

## 1. Requisito de negocio

Durante la implantación (`inventory_restriction = false`) el operario debe poder
**registrar una solicitud de insumos de cualquier SKU**, incluso si ese SKU:

- no tiene stock (lote con `quantity_available = 0`), o
- **no tiene ningún lote** todavía (nunca recibido ni cargado por inventario inicial).

El objetivo es dejar registrado lo que se pidió, para atenderlo cuando haya
existencias. Es el mismo criterio que ya se aplicó a `POST /inventory/scrap`.

## 2. Estado actual (bloqueante)

`POST /inventory/transfers` exige `batch_id` en cada ítem:

```json
{ "ok": false, "error": "Cada ítem requiere: item_id, batch_id, quantity_requested.", "code": "ERR_VALIDATION" }
```

Como para esos SKUs no existe lote, el cliente no tiene un `batch_id` que enviar y
**el pedido no puede registrarse**, aunque el control de inventario esté deshabilitado.

## 3. Cambio solicitado

Aplicar a `POST /inventory/transfers` el **mismo comportamiento que a `scrap`**:

1. Hacer `batch_id` **opcional** por ítem.
2. Si se omite y **hay lotes** del SKU → tomar el **FEFO** (caducidad más próxima),
   incluso con `quantity_available = 0`.
3. Si se omite y **no hay ningún lote** y `inventory_restriction = false` →
   **crear un lote automático** (p. ej. `INV-PENDIENTE-YYYYMMDD-{id}`) y registrar
   la solicitud.
4. Si `inventory_restriction = true` (producción) → mantener la validación estricta
   (exigir lote con stock suficiente; bloquear en caso contrario).

### Payload que enviará [1003] (sin `batch_id` cuando no hay lote)

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

## 4. Matriz de comportamiento esperada

| `inventory_restriction` | Lote / stock del SKU | Resultado |
|---|---|---|
| `false` (implantación) | con lote (aunque stock 0) | ✅ Registrar con ese lote (FEFO) |
| `false` (implantación) | sin ningún lote | ✅ Registrar; el API crea lote automático |
| `true` (producción) | stock ≥ solicitado | ✅ Registrar |
| `true` (producción) | stock < solicitado / sin lote | ❌ Bloquear con mensaje |

## 5. Estado en [1003] (ya preparado)

El cliente ya está ajustado para este contrato:

- Resuelve el lote FEFO con `GET /inventory/batches?item_id=&location_id=&include_empty=1`.
- Si hay lote → envía `batch_id`.
- Si **no** hay lote y el control está deshabilitado → **omite** `batch_id` y registra
  igualmente (a la espera de que el API lo acepte según esta solicitud).
- En producción exige lote/stock.

No se requiere ningún cambio adicional en [1003] cuando el API adopte este cambio,
ni afecta a otros subsistemas.

---

*[1003] — Indicación para el hilo del API CORE. Consolida las dos solicitudes
relacionadas con la resolución de `batch_id` en traspasos.*
