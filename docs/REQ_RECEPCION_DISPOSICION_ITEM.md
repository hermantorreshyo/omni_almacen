# REQUERIMIENTO AL OMNI API CORE — Disposición por ítem en la recepción

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint afectado:** `PUT /api/v1/inventory/transfers/{id}/close`
**Prioridad:** Alta — afecta la exactitud del inventario en origen y destino
**Estado:** ✅ ATENDIDA (2026-07) — el core implementó `disposition` por ítem. `devuelto` reingresa a origen; `no_recibido` se registra como merma en tránsito (no reingresa). [1003] ya envía el campo correcto; sin cambios de envío pendientes.

---

## 1. Necesidad de negocio

Al recibir un traspaso, cada ítem puede terminar en uno de tres estados, con efectos
de inventario distintos:

| Disposición | Inventario ORIGEN (quien envía) | Inventario DESTINO (quien recibe) |
|---|---|---|
| **Recibido** | queda descontado (salió) | **suma** lo recibido |
| **No recibido** | **NO debe quedar descontado** (se revierte) | no suma |
| **Devuelto a bodega** | **NO debe quedar descontado** (regresa a origen) | no suma |

Hoy el stock se descuenta del origen en `PUT /route` y se acredita al destino en `close`
con `quantity_received`. Con eso, enviar `quantity_received = 0` cubre "no sumar al
destino", **pero NO revierte el descuento del origen**: la mercancía queda "desaparecida"
(descontada de origen y no ingresada en destino). Eso contradice las reglas de arriba
para *No recibido* y *Devuelto*.

## 2. Cambio solicitado

Aceptar en cada ítem del `close` un campo **`disposition`**:

```json
PUT /api/v1/inventory/transfers/{id}/close
{
  "reception_date": "2026-07-27",
  "items": [
    { "item_id": 101, "batch_id": 55, "quantity_received": 8, "disposition": "recibido" },
    { "item_id": 88,  "batch_id": 7,  "quantity_received": 0, "disposition": "no_recibido" },
    { "item_id": 90,  "batch_id": 9,  "quantity_received": 0, "disposition": "devuelto" }
  ]
}
```

Efectos esperados por disposición:

- **`recibido`** → acreditar `quantity_received` al destino (comportamiento actual).
- **`no_recibido`** → no acreditar al destino y **revertir en el origen** la cantidad
  despachada de ese ítem (devolver el stock que había salido). Opcional: registrar un
  movimiento de kardex tipo "Ajuste/No recibido" para trazabilidad.
- **`devuelto`** → no acreditar al destino y **reingresar la cantidad en la bodega de
  origen** (lote original). Kardex tipo "Devolución a bodega".

Valores: `recibido` | `no_recibido` | `devuelto`. Si el campo no llega, asumir `recibido`
(compatibilidad con el comportamiento actual).

## 3. Estado provisional en [1003]

Mientras el core no lo soporte, [1003] ya envía `disposition` por ítem y
`quantity_received = 0` en los no recibidos/devueltos, además de la nota
(`NO RECIBIDO` / `DEVUELTO A BODEGA`). **Limitación:** sin el cambio, esa cantidad
**no se reintegra al origen** — queda descontada. Es decir, el inventario de origen
quedará corto hasta que el core procese la disposición.

## 4. Pregunta abierta

¿`no_recibido` y `devuelto` deben tener el mismo efecto de inventario (revertir a origen)
y distinguirse solo por el tipo de movimiento de kardex, o `no_recibido` debería
registrarse como merma de tránsito en vez de reingresar a origen? Indíquennos la regla
contable preferida.

---
*[1003] — Requerimiento para el hilo del API CORE.*
