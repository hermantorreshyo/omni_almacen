# REQUERIMIENTO AL OMNI API CORE — Cambio de estado administrativo de traspasos

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint(s) afectado(s):** nuevo, administrativo, sobre `inventory/transfers`
**Prioridad:** Media-Alta — necesario para destrabar pedidos atorados en producción
**Estado:** ✅ ATENDIDA (v6.29) — PUT /inventory/transfers/{id}/admin-state (solo superadmin). Cambia solo la cabecera; devuelve stock_warning cuando el salto cruza /route o /close (se muestra al SuperAdmin). Estados válidos: SOLICITADO, EN_PICKING, LISTO_DESPACHO, EN_RUTA, PENDIENTE_RECEPCION, CERRADO, CANCELADO (BORRADOR excluido). Auditoría en transfer_log con prefijo [ADMIN]. [1003] exige motivo obligatorio.

---

## 1. Necesidad de negocio

Se requiere un módulo **"Maestro de Pedidos"** en [1003], **visible solo para el
SuperAdministrador**, para supervisar y **destrabar** pedidos (traspasos) que por
alguna razón quedan atorados en un estado y no avanzan por el flujo normal.

El flujo normal usa transiciones controladas (`/picking` → `/dispatch` → `/route` →
`/deliver` → `/close`), cada una válida solo desde el estado inmediatamente anterior.
Eso está bien para la operación diaria, pero **no permite corregir** un pedido que se
quedó, por ejemplo, en `EN_RUTA` sin haberse entregado, o en `EN_PICKING` tras un
error. Hoy no hay forma de moverlo sin pasar por toda la cadena.

## 2. Lo que se solicita

Un endpoint **administrativo** que permita fijar el estado de un traspaso a
**cualquier** valor válido, saltándose la validación de transición normal:

```
PUT /api/v1/inventory/transfers/{id}/admin-state
{ "state": "LISTO_DESPACHO", "reason": "Pedido atorado por corte de red; reposicionado manualmente" }
```

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `state` | string | Sí | Nuevo estado destino (cualquiera del ciclo de vida del traspaso). |
| `reason` | string | Recomendado | Motivo del cambio manual, para auditoría. |

**Requisitos:**
- **Permiso restringido a SuperAdministrador** (o un permiso específico tipo
  `inventory.admin_state`) — no debe estar al alcance de roles operativos.
- Debe **registrar en auditoría** quién hizo el cambio, desde qué estado, a qué estado
  y el motivo (para trazabilidad — es una operación sensible).
- Idealmente devolver el traspaso actualizado para refrescar la vista.

### 2.1 Preguntas al core

1. ¿Prefieren un endpoint dedicado (`/admin-state`) o un parámetro de fuerza
   (`?force=1`) sobre las transiciones existentes? Para [1003] es indiferente;
   sugerimos el dedicado por claridad y por poder restringir el permiso.
2. ¿Hay **efectos colaterales** al saltar estados que el core deba manejar (p. ej.
   movimientos de inventario/kardex ya generados al despachar/entregar)? Es decir:
   si un pedido pasó a `LISTO_DESPACHO` y generó movimientos, y se le regresa a
   `EN_PICKING`, ¿el core revierte esos movimientos, o el cambio de estado es solo
   de la cabecera? Necesitamos saberlo para advertir al SuperAdmin en la UI.
3. ¿Qué lista de estados válidos debe ofrecer el desplegable? Confírmennos el
   catálogo exacto del ciclo de vida (`BORRADOR`, `SOLICITADO`, `EN_PICKING`,
   `LISTO_DESPACHO`, `EN_RUTA`, `PENDIENTE_RECEPCION`, `CERRADO`, …) y si alguno no
   debe permitirse como destino manual.

## 3. Lo que [1003] hará (para su referencia)

- **Ya (sin esperar):** módulo "Maestro de Pedidos" visible solo para SuperAdmin, que
  lista **todos los pedidos no cerrados** (`GET /transfers` filtrando estados ≠ CERRADO)
  con su estado actual, y permite ver el **detalle** (`GET /transfers/{id}`).
- **Al recibir este endpoint:** añadir en cada pedido un selector de estado destino que
  llame a `PUT .../admin-state` con el motivo, y refrescar la lista. Mostraremos una
  confirmación y, si el core lo indica, la advertencia sobre efectos colaterales.

## 4. Resumen

> Se necesita un endpoint administrativo (solo SuperAdmin, con auditoría) para fijar el
> estado de un traspaso a cualquier valor, y así destrabar pedidos atorados desde el
> "Maestro de Pedidos" de [1003]. La vista de solo lectura ya se construye; falta la
> acción de escritura, que depende de este endpoint.

---
*[1003] — Requerimiento para el hilo del API CORE. La acción de cambio de estado no se
implementa hasta la respuesta.*
