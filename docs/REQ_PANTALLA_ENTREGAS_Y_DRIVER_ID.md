# REQUERIMIENTO AL OMNI API CORE — Pantalla `entregas` (repartidor) y `driver_user_id` en rutas

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Prioridad:** Media-Alta — la pantalla ya está implementada en [1003] pero no puede asignarse a roles
**Tipo:** (A) registro de pantalla RBAC · (B) campo adicional en rutas

---

## A. Registrar la nueva pantalla `entregas` en el catálogo RBAC

[1003] incorporó un módulo para el **chofer/repartidor**: ve los pedidos de sus rutas
y los marca como entregados (`PUT /inventory/transfers/{id}/deliver`), lo que hace que
aparezcan en la Recepción de Traspaso de la tienda destino.

**Problema:** `GET /rbac/subsystems/1003/my-screens` no devuelve `entregas` (ni siquiera
para el SuperAdmin) porque la clave **no está registrada** en el catálogo de pantallas del
subsistema. Por tanto no puede asignarse al rol **Repartidor**.

### Solicitud

Registrar la pantalla en el catálogo de [1003]:

```
POST /api/v1/rbac/subsystems/1003/screens
```

```json
{
  "screens": [
    { "key": "recepcion",       "label": "Recepción de Mercancía" },
    { "key": "ubicar",          "label": "Ubicación por QR" },
    { "key": "picking",         "label": "Picking de Traspasos" },
    { "key": "transporte",      "label": "Ruta de Transporte" },
    { "key": "entregas",        "label": "Mis Entregas (repartidor)" },
    { "key": "solicitar",       "label": "Solicitar Insumos" },
    { "key": "recibir",         "label": "Recepción de Traspaso" },
    { "key": "merma",           "label": "Registrar Merma" },
    { "key": "dashboard",       "label": "Panel de Traspasos" },
    { "key": "gestor_permisos", "label": "Gestor de Permisos" }
  ]
}
```

> La clave nueva es **`entregas`**. El resto ya existe; se listan para referencia.

Tras el registro:

- `GET /rbac/subsystems/1003/my-screens` debe incluir `entregas` para el **SuperAdmin**.
- El **Gestor de Permisos** de [1003] podrá asignarla al rol **Repartidor** (y a quien corresponda).

---

## B. Exponer `driver_user_id` en las rutas

`GET /api/v1/logistics/routes` devuelve hoy `driver_name`, pero **no el id del usuario**
conductor. [1003] necesita filtrar "mis rutas" por el usuario autenticado; hoy hace un
match aproximado por nombre, que es frágil.

### Solicitud

Añadir el campo `driver_user_id` a la respuesta de rutas (listado y detalle):

```json
{
  "id": 3,
  "route_code": "RT-A1B2C3-20260702",
  "status": "en_transito",
  "plate_number": "1234-ABC",
  "driver_user_id": 45,
  "driver_name": "Carlos López",
  "transfers_count": 2
}
```

**Alternativa equivalente (igual de válida):** un filtro
`GET /logistics/routes?driver=me` (o `?driver_user_id=`) que devuelva solo las rutas
del usuario autenticado. Con cualquiera de las dos opciones [1003] resuelve el filtro
de forma exacta.

---

## Impacto

- **(A)** es imprescindible para que la pantalla pueda asignarse por RBAC.
- **(B)** es una mejora de exactitud; [1003] ya funciona con el match por nombre como
  respaldo, pero puede mostrar rutas ajenas si dos conductores tienen nombres similares.
- Ningún otro subsistema se ve afectado.

---

*[1003] — Requerimiento generado para el hilo del API CORE.*
