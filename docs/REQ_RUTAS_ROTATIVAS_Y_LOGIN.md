# REQUERIMIENTO AL OMNI API CORE — Rutas rotativas: selección en login + log histórico

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Versión de contexto:** parte del ajuste de rutas de reparto (última: v6.13)
**Prioridad:** Alta — cambia el modelo de asignación conductor↔ruta
**Estado:** ✅ ATENDIDA PARCIALMENTE (v6.14, 2026-08-01) — alcance reducido por decisión de [1001]:
- Selección/cambio de ruta se hace desde el **HOME** (no en el login) vía `POST /logistics/routes/{id}/select`. ✅ implementado en [1003] (banner de ruta + selector).
- Ruta **exclusiva** por día (un conductor = una ruta); `409 ERR_STATE` si otro la tomó.
- Selector armado con `GET /logistics/delivery-routes` (`today_driver_id`, `origin_name`, `stores_count`).
- `GET /logistics/routes/mine` sin cambios de contrato (resuelve por la ruta elegida hoy).
- NO se hizo: renombre de rol (sigue "Chofer Logístico"), selección en login, log histórico extenso (queda como requerimiento aparte si se prioriza).

---

## 1. Cambio de negocio que motiva este requerimiento

Hoy (v6.12/v6.13) el modelo asume **un conductor fijo por ruta**
(`delivery_routes.driver_user_id`). La operación real es distinta:

> **Las rutas son rotativas.** Un mismo conductor no hace siempre la misma ruta;
> cada día puede trabajar una ruta diferente. Por tanto, el conductor debe
> **elegir la ruta en la que trabajará ese día al iniciar sesión**, no tenerla
> asignada de forma permanente.

Consecuencias:

1. El vínculo conductor↔ruta deja de ser fijo en el maestro y pasa a ser una
   **elección por sesión/día**.
2. Como la ruta cambia de conductor a diario, hace falta un **log histórico**
   que preserve quién hizo qué ruta y qué entregas, para que los históricos no
   se pierdan (auditoría, productividad, trazabilidad de entregas).

También se pide un **cambio de nomenclatura** (ver §2).

---

## 2. Renombrar el rol "Chofer Logístico" → "Encargado Logístico"

El rol que hoy se llama **Chofer Logístico** debe pasar a llamarse
**Encargado Logístico** en todo el ecosistema (etiqueta visible, y donde
aplique, identificador de rol).

- Permisos: **sin cambios** — sigue teniendo `logistics.dispatch` y lo que ya
  tenía. Es solo el nombre.
- Pedimos que el cambio se haga en el **core** (fuente de verdad de roles) para
  que todos los subsistemas lo hereden y [1003] no tenga que "traducir" el
  nombre por su cuenta.
- **Pregunta:** ¿el identificador interno del rol cambia o solo la etiqueta
  visible? Si cambia el identificador, indíquennos el nuevo valor exacto para
  ajustar cualquier comparación por rol en [1003]. Si solo cambia la etiqueta,
  ideal — [1003] ya muestra el nombre que envía el core.

---

## 3. Lo que se solicita — selección de ruta en el login

### 3.1 Flujo actual del login en [1003] (contexto para el core)

El login de [1003] es en dos pasos:
- **Paso 1:** usuario + contraseña → se listan los **interlocutores/sedes**
  disponibles para ese usuario.
- **Paso 2:** el usuario elige su sede y se hace el login definitivo con el rol
  de esa sede (JWT con el rol correcto).

### 3.2 Lo que se necesita para conductores

Para un usuario cuyo rol sea **Repartidor** (y **Encargado Logístico** cuando
actúe como repartidor), el segundo paso del login debe permitir **elegir la
ruta del día**. Necesitamos del core:

**a) Un endpoint que liste las rutas seleccionables por ese conductor en el login.**

Propuesta:
```
GET /logistics/routes/selectable
```
- Resuelve el usuario desde el JWT del paso 1 (o recibe el usuario si aún no hay
  token con rol). Indíquennos cómo prefieren la autenticación en este punto.
- Devuelve las rutas que ese conductor puede tomar hoy. **Pregunta de negocio:**
  ¿cualquier conductor puede tomar **cualquier** ruta, o hay un subconjunto
  permitido por conductor? Según eso, este endpoint devuelve todas las rutas
  activas o solo las habilitadas para él.

Respuesta esperada (ejemplo):
```json
{
  "routes": [
    { "id": 3, "name": "Ruta Madrid Centro", "status": "active",
      "stores_count": 6, "pending_transfers": 4, "taken_by": null },
    { "id": 5, "name": "Ruta Sur", "status": "active",
      "stores_count": 4, "pending_transfers": 0,
      "taken_by": { "user_id": 42, "name": "Edwin Cortes" } }
  ]
}
```
- `taken_by`: si otra persona ya tomó esa ruta hoy, para avisarlo en la UI.
  **Pregunta:** ¿una ruta puede ser tomada por **más de un** conductor el mismo
  día, o es exclusiva? Si es exclusiva, el core debería rechazar la segunda toma.

**b) Un endpoint para "tomar" la ruta al confirmar el login (paso 2).**

Propuesta:
```
POST /logistics/routes/{id}/take
```
- Registra que **este conductor** trabaja **esta ruta** **hoy**.
- Debe devolver lo necesario para que el JWT/sesión quede ligado a esa ruta, de
  modo que `GET /logistics/routes/mine` (que ya consumimos) devuelva las
  entregas **de la ruta elegida ese día**, no de una ruta fija.
- **Pregunta clave:** ¿cómo se vincula la ruta elegida a la sesión? ¿El JWT
  incluye la `route_id` del día? ¿O `routes/mine` la resuelve a partir del log
  de "toma" del día? Nos sirve cualquiera de las dos; indíquennos cuál para
  ajustar [1003].

### 3.3 Efecto en `GET /logistics/routes/mine`

Hoy resuelve las rutas del conductor por `driver_user_id` fijo. Con rutas
rotativas, debe resolver la ruta **que el conductor tomó hoy** (del log de
§4). El resto de la respuesta (paradas en orden, productos por parada) puede
quedar **igual** — [1003] ya la consume así, no habría que cambiar el frontend
de "Mis Rutas" salvo por el nuevo paso de selección.

---

## 4. Log histórico ruta + conductor + entregas

Se solicita un **registro histórico persistente** que preserve, por día:

- **Qué conductor** tomó **qué ruta** y **cuándo** (fecha/turno).
- **Qué entregas** (traspasos) correspondieron a esa ruta ese día y su
  desenlace (enviado / entregado / recibido), con sus timestamps.

Esto es necesario porque, al ser rotativas, la relación conductor↔ruta ya no
vive en el maestro y se perdería sin un log. Casos de uso: auditoría,
productividad por conductor, reclamaciones de una tienda ("¿quién repartió el
día X?"), y reportes.

Propuesta de consulta para [1003] (solo lectura, para el Encargado Logístico /
SuperAdmin):
```
GET /logistics/route-assignments?date_from=&date_to=&route_id=&driver_user_id=
```
Respuesta (ejemplo):
```json
[{
  "assignment_id": 1201, "date": "2026-08-01",
  "route": { "id": 3, "name": "Ruta Madrid Centro" },
  "driver": { "user_id": 42, "username": "edwin.cortes", "name": "Edwin Cortes" },
  "taken_at": "2026-08-01 07:55:00",
  "deliveries": [
    { "transfer_id": 55, "dest_name": "LEGANES", "final_state": "CERRADO",
      "at_en_ruta": "2026-08-01 09:40:00", "at_delivered": "2026-08-01 10:05:00" }
  ]
}]
```

El **maestro `delivery_routes.driver_user_id`** probablemente deja de tener
sentido como conductor fijo. **Pregunta:** ¿lo eliminan, lo dejan como
"conductor sugerido/por defecto", o lo reinterpretan? Nos afecta la pantalla de
administración de rutas (que es de [1001], pero conviene alinear el concepto).

---

## 5. Resumen de lo que pedimos a [1001]

1. Renombrar el rol **Chofer Logístico → Encargado Logístico** (mismos permisos).
2. Endpoint para **listar rutas seleccionables** en el login del conductor
   (`GET /logistics/routes/selectable` o equivalente).
3. Endpoint para **tomar la ruta del día** al confirmar el login
   (`POST /logistics/routes/{id}/take` o equivalente) y su vínculo con la sesión.
4. Ajustar `GET /logistics/routes/mine` para que resuelva por la **ruta tomada
   hoy**, no por conductor fijo.
5. **Log histórico** ruta+conductor+entregas y un endpoint de consulta para
   reportes/auditoría.

## 6. Preguntas abiertas (para que la respuesta las resuelva)

1. ¿El renombre del rol cambia el identificador interno o solo la etiqueta?
2. ¿Un conductor puede tomar cualquier ruta o un subconjunto permitido?
3. ¿Una ruta es exclusiva de un conductor por día, o pueden compartirla varios?
4. ¿Cómo se vincula la ruta elegida a la sesión (JWT con `route_id` vs. log del
   día que `routes/mine` consulta)?
5. ¿Qué pasa con `delivery_routes.driver_user_id` (se elimina / queda como
   sugerido)?
6. ¿Autenticación del endpoint de rutas seleccionables: con el token del paso 1,
   o antes de tener token con rol?

## 7. Alcance de [1003] una vez implementado (para su referencia)

Cuando [1001] responda, [1003] hará: (a) mostrar el nombre "Encargado
Logístico"; (b) añadir el **paso de selección de ruta** en el login para
Repartidor/Encargado Logístico, consumiendo el endpoint de rutas seleccionables
y "tomando" la ruta elegida; (c) `Mis Rutas` seguirá consumiendo
`routes/mine` (que ya resolverá por la ruta del día); (d) opcionalmente, una
pantalla de solo lectura para consultar el **log histórico** de asignaciones.
No haremos nada de esto hasta recibir el contrato definitivo.

---
*[1003] — Requerimiento para el hilo del API CORE. [1003] no implementa hasta la respuesta.*


---

## Adenda v6.15 (2026-08-01) — inicio de ruta + histórico — ✅ IMPLEMENTADO en [1003]
- **Iniciar ruta** (`POST /logistics/routes/{id}/start`): botón "Iniciar ruta" en el banner del home; al iniciar, se oculta "Cambiar ruta" y el banner muestra "En curso". El core respalda la regla (rechaza `select` con 409 tras iniciar). Respaldo local `state._rutaIniciada` para reflejarlo de inmediato.
- **Histórico de rutas ejecutadas** (`GET /logistics/route-history`): nueva pantalla "Historial de rutas" en el drawer (visible para conductores y gestores). Filtros Desde/Hasta (default 7 días). Cada ruta con conductor, hora de inicio y entregas por punto (salió/entregó). Un solo endpoint; el core filtra por rol (Repartidor solo ve lo suyo).
