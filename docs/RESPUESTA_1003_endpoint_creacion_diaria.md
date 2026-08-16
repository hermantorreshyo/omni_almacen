# RESPUESTA a REQ — Endpoint de creación usado para solicitudes diarias

**De:** [1003] Gestión de Almacenes y Mermas · **Para:** OMNI API CORE [1001]
**Referencia:** REQ_1003_confirmar_endpoint_creacion_diaria.md
**Fecha:** 2026-08-11

---

## Respuesta directa

[1003] usa el **Camino A — flujo de borrador**. **No** usamos el endpoint
directo (`POST /inventory/transfers`).

Por lo tanto, en el reporte "Traspasos Diarios", `created_at` y
`at_solicitado` **son dos momentos genuinamente distintos**: reflejan el
tiempo real que la tienda tarda entre empezar a armar el pedido y
confirmarlo. Si aparecen iguales en algún registro, es porque esa tienda
confirmó (casi) al instante, no por el camino de creación.

## Evidencia en el código de la pantalla de solicitud

La pantalla "Solicitar Insumos" (`openSolicitar` en `js/app.js`) crea y
confirma así:

1. **Crear el borrador** — al primer ítem con cantidad > 0, se llama a
   `ApiClient.draftCrear(...)`, que en el proxy (`api/omni.php`, acción
   `draft_crear`) hace:
   ```
   POST /inventory/transfers/draft      → crea en BORRADOR (created_at = ahora)
   ```

2. **Armar/ajustar el pedido** — mientras la tienda agrega/edita ítems, se
   guarda de forma incremental sobre ese mismo borrador
   (`POST/PATCH/DELETE /inventory/transfers/{id}/items`), sin cambiar el
   estado. El pedido sigue en `BORRADOR`.

3. **Confirmar el envío** — al pulsar enviar, se llama a la transición:
   ```
   PUT /inventory/transfers/{id}/solicitar   → BORRADOR → SOLICITADO
                                               (at_solicitado = ahora)
   ```
   (proxy `api/omni.php`, acción `draft_enviar`, ruta `transfer_solicitar`).

No existe ninguna llamada a `POST /inventory/transfers` (creación directa)
en la pantalla de solicitud de tienda.

## Sobre la recomendación (§4 del REQ)

No aplica una migración: ya estamos en el flujo de borrador recomendado.
Todas las funcionalidades construidas sobre `BORRADOR` (autoguardado
incremental, recuperación de borrador tras perder sesión, cancelación por
la tienda dueña) operan sobre este mismo camino.

## Resumen

> [1003] usa `POST /inventory/transfers/draft` + `PUT .../solicitar`. El
> reporte "Traspasos Diarios" debe mostrar `created_at` y `at_solicitado`
> distintos cuando la tienda se toma tiempo entre armar y confirmar; iguales
> solo cuando confirma de inmediato. No hay que cambiar nada.

---
*[1003] — Respuesta de verificación para el hilo del API CORE.*
