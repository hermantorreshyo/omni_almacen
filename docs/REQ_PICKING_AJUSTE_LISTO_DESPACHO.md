# REQUERIMIENTO AL OMNI API CORE — Ajustes de picking en estado LISTO_DESPACHO

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoints afectados:** `PATCH /inventory/transfers/{id}/picking-items` y/o
`PUT /inventory/transfers/{id}/dispatch`
**Prioridad:** Alta — bloquea una corrección operativa real
**Estado:** ✅ ATENDIDA (v6.30) — Opción A: PATCH /picking-items acepta LISTO_DESPACHO; el core mapea a quantity_dispatched según estado. Sin efectos de inventario (el stock se mueve recién en /route). En EN_RUTA sigue rechazando. [1003] usa el PATCH unificado; quitado el re-dispatch y el mensaje de bloqueo.
**Estado:** PENDIENTE de implementación en [1001].

---

## 1. Necesidad de negocio

Un pedido puede alistarse y quedar en **`LISTO_DESPACHO`**, pero **todavía no ha
salido** — está esperando a que el Repartidor lo **cargue a la ruta** (transición a
`EN_RUTA`). Durante esa ventana, el personal de almacén necesita poder **ajustar el
picking**. Caso real:

> Un ítem se marcó **No despachado** (cantidad 0) porque no había stock. Más tarde,
> el mismo día, **llega mercancía**. El operario debe poder cambiar ese ítem a
> despachado con una **cantidad positiva** — pero el pedido ya está en `LISTO_DESPACHO`.

Hoy esto **falla**. Al intentar guardar el ajuste, el core responde:

```json
{ "ok": false, "code": "ERR_STATE",
  "error": "Estado inválido. Se requiere 'EN_PICKING', el traspaso está en 'LISTO_DESPACHO'." }
```

Tanto `PUT /picking` como `PATCH /picking-items` exigen `EN_PICKING`, y el flujo es
unidireccional (no existe `LISTO_DESPACHO → EN_PICKING`), así que no hay forma de
corregir el pedido una vez despachado, aunque no haya salido.

## 2. Lo que se solicita (cualquiera de estas opciones resuelve el caso)

**Opción A (preferida): permitir `PATCH /picking-items` en `LISTO_DESPACHO`.**
Que el ajuste de cantidades/notas por ítem se acepte también cuando el traspaso está
en `LISTO_DESPACHO` (no solo en `EN_PICKING`), actualizando `quantity_dispatched`
en consecuencia. La ventana se cierra cuando el pedido pasa a `EN_RUTA`.

**Opción B: transición de reapertura `LISTO_DESPACHO → EN_PICKING`.**
Un endpoint/transición que devuelva el pedido a `EN_PICKING` para editarlo y volver a
despacharlo. Requiere permiso de almacén.

**Opción C: hacer `PUT /dispatch` re-ejecutable en `LISTO_DESPACHO`.**
Permitir volver a llamar `dispatch` estando ya en `LISTO_DESPACHO` para **corregir**
las cantidades despachadas, sin cambiar de estado.

En los tres casos, la **regla de cierre es la misma**: una vez el pedido está en
`EN_RUTA` (el Repartidor lo cargó), **ya no se permiten ajustes** — eso es correcto y
deseado.

## 3. Preguntas al core

1. ¿Cuál de las tres opciones prefieren exponer? Para [1003] la más cómoda es la **A**
   (mismo `PATCH` que ya usamos, solo ampliando los estados admitidos).
2. Al ajustar en `LISTO_DESPACHO`, ¿el core recalcula `quantity_dispatched` y cualquier
   movimiento de inventario asociado, o el ajuste es solo sobre las cantidades del
   pedido? Necesitamos saberlo para no dejar inconsistencias.
3. ¿Qué permiso debe requerir el ajuste en `LISTO_DESPACHO` (mismo `inventory.write`
   del picking)?

## 4. Comportamiento de [1003] mientras tanto

Ya mostramos los pedidos `LISTO_DESPACHO` en la zona de picking (para poder ajustarlos
antes de que salgan). Hasta que exista esta capacidad, al intentar guardar un ajuste en
ese estado mostramos un mensaje claro ("este pedido ya está listo; para ajustarlo pide
reabrirlo") en vez del error técnico. Cuando el core habilite la opción elegida, el
ajuste guardará normalmente.

---
*[1003] — Requerimiento para el hilo del API CORE.*
