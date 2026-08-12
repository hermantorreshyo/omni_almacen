# REQUERIMIENTO A [1003] — Sustitución de producto en el picking

**Origen:** OMNI API CORE — funcionalidad ya implementada, pendiente de integración en [1003]
**Prioridad:** Media
**Estado:** ✅ INTEGRADA en [1003] (v6.32) — lápiz junto al nombre en cada ítem del picking → buscador de SKUs (GET /catalog/skus?q=) → PUT .../items/{itemRowId}/substitute con motivo opcional. Tras sustituir se recarga el alistado (cantidades reiniciadas por el core; el ítem queda pendiente de pickear). Ventana EN_PICKING/LISTO_DESPACHO; 409 en EN_RUTA y validaciones del core manejadas.

---

## 1. Necesidad de negocio

Durante el picking, a veces el producto pedido **no es el correcto**, o hace
falta **sustituirlo por otro** para cumplir el requerimiento (ej. se agotó
la presentación pedida y hay un equivalente, o se detecta un error en el
pedido original). Hoy no hay forma de cambiar *qué producto* es un ítem —
solo se puede ajustar su cantidad.

## 2. Lo que se pide en la pantalla

Junto al **nombre del producto** en cada tarjeta del picking, un ícono de
**lápiz** — pequeño, discreto (es una acción poco frecuente). Al tocarlo:

1. Se despliega un buscador de productos (usar `GET /catalog/skus?q=...`,
   ya existente — mismo criterio de búsqueda que ya usan en otras pantallas).
2. Al elegir un producto, se confirma la sustitución con el nuevo endpoint
   (abajo). Recomendamos pedir un motivo breve, opcional, para quedar
   registrado en la auditoría.
3. Tras confirmar, refrescar la tarjeta del ítem — el producto, su
   categoría/área, y sus cantidades (que se reinician, ver más abajo)
   cambian.

## 3. Endpoint — ya implementado

```
PUT /inventory/transfers/{id}/items/{itemRowId}/substitute
{ "new_item_id": 55, "new_item_type": "sku", "reason": "Se agotó la presentación pedida, se sustituye por la de 1kg" }
```

`itemRowId` es el `id` propio de la fila del ítem (viene en
`data.items[].id` de `GET /inventory/transfers/{id}`) — no confundir con
`item_id` (el ID del producto).

`new_item_type` es opcional, por defecto `"sku"` — casi siempre será este
caso.

`batch_id` es opcional — el core resuelve automáticamente el lote del
producto nuevo (FEFO), no hace falta que la pantalla lo pida salvo que la
sede tenga `inventory_restriction` activo (poco común).

### 3.1 Qué pasa con las cantidades — importante para la pantalla

- **`quantity_requested` se mantiene** — la tienda sigue necesitando esa
  cantidad, solo cambia qué producto la cumple.
- **`quantity_picked`/`quantity_dispatched` se reinician a `null`** —
  aplicaban al producto anterior. Después de sustituir, hay que volver a
  marcar cuánto se pickeó/despachó del producto nuevo, con los mismos
  flujos que ya usan (`PATCH /picking-items`).

**Recomendación de pantalla:** después de sustituir, dejar el ítem visible
como "pendiente de pickear de nuevo" (igual que un ítem recién agregado),
no como ya confirmado — para que el operario no se olvide de volver a
marcar la cantidad real del producto sustituto.

### 3.2 Ventana — cuándo se puede sustituir

Igual que el ajuste de cantidades que ya integraron: **`EN_PICKING` o
`LISTO_DESPACHO`**. En `EN_RUTA` en adelante, el endpoint rechaza
(`409 ERR_STATE`) — ya se cargó a la ruta, no se permite cambiar el
producto.

### 3.3 Validaciones que ya aplica el core

- El producto sustituto debe estar activo (`status='active'`) — si no,
  rechaza con `409`.
- Si el producto+lote resultante ya tiene su propia fila en el mismo
  traspaso, rechaza (`409`) — evita duplicar una fila que ya existía.
- Mismos permisos que el resto del picking (Jefe/Operario de Almacén) —
  no hace falta ningún permiso nuevo de su lado.

## 4. Resumen

> Lápiz junto al nombre del producto en cada ítem del picking → buscador
> de productos → `PUT .../items/{itemRowId}/substitute`. Reinicia las
> cantidades del ítem (hay que volver a pickearlo/despacharlo), mantiene
> la cantidad solicitada. Misma ventana que el ajuste de cantidades
> (`EN_PICKING`/`LISTO_DESPACHO`, cierra en `EN_RUTA`).

---
*Contrato de datos definido y mantenido desde OMNI API CORE [1001]. Documento
permanente — vive en `docs/requerimientos/` junto al resto de REQs.*
