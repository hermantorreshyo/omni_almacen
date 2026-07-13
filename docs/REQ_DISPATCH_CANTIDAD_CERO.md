# REQUERIMIENTO AL OMNI API CORE — Permitir `quantity_dispatched = 0` en el despacho

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint afectado:** `PUT /api/v1/inventory/transfers/{id}/dispatch`
**Prioridad:** Alta — bloquea el picking real durante la implantación
**Tipo:** Relajar validación según `inventory_restriction`

---

## 1. Requisito de negocio

En el **picking** es habitual que un SKU solicitado **no tenga existencias**. El
operario debe poder despacharlo **en cero**, dejando constancia de que ese ítem
se revisó y no se pudo atender. Esa cifra es la que permite medir el
**pedido no atendido** (`quantity_requested − quantity_dispatched`).

Un `quantity_dispatched = 0` **no es lo mismo** que `NULL` (ítem sin revisar):
el cero es información de negocio.

## 2. Estado actual (bloqueante)

```json
{ "ok": false, "error": "quantity_dispatched debe ser > 0.", "code": "ERR_PARAM" }
```

El API rechaza el despacho completo si algún ítem va con 0, de modo que el
operario no puede cerrar el picking cuando falta stock de un producto.

## 3. Cambio solicitado

Aceptar `quantity_dispatched = 0` (>= 0), al menos cuando el control de
inventario está **desactivado**, coherente con el resto de la implantación:

| `inventory_restriction` | `quantity_dispatched` | Comportamiento |
|---|---|---|
| `false` (implantación, actual) | `0` | ✅ Aceptar — el ítem queda como no atendido |
| `false` | `> 0` | ✅ Aceptar |
| `true` (producción) | `0` | ✅ Aceptar (es una decisión del almacén, no un problema de stock) |
| `true` | `> stock disponible` | ❌ Bloquear |

> Si se prefiere ser conservador, basta con permitir `0` cuando
> `inventory_restriction = false`; [1003] ya lee `GET /system/params` y adapta su UI.

### Payload que enviará [1003]

```json
{
  "items": [
    { "item_id": 111, "batch_id": 19, "quantity_dispatched": 8 },
    { "item_id": 88,  "batch_id": 7,  "quantity_dispatched": 0 }
  ],
  "notes": "SIN STOCK (0 despachado): Azúcar refinada"
}
```

Efectos esperados con `0`: no se genera movimiento de stock para ese ítem, se
persiste `quantity_dispatched = 0` en `transfer_items` y el traspaso avanza a
`LISTO_DESPACHO` con normalidad.

## 4. Comportamiento provisional en [1003]

Mientras la validación siga activa, [1003] **excluye del payload** los ítems con
0 y los registra en las notas del traspaso (`SIN STOCK (0 despachado): …`), para
que el despacho no falle. Es un apaño: la cifra 0 no queda en `transfer_items`,
por lo que **el indicador de "pedido no atendido" pierde precisión**.

Cuando el API acepte `0`, [1003] volverá a enviar todos los ítems con su cantidad
real (incluido 0) y se eliminará el apaño.

## 5. Impacto

- Ningún otro subsistema envía `dispatch`; el cambio no les afecta.
- El caso "todos los ítems en cero" puede seguir rechazándose o, mejor, permitirse
  y cerrar el traspaso como no atendido. Indíquennos qué prefieren.

---

*[1003] — Requerimiento generado para el hilo del API CORE.*
