# Autoguardado del Picking — Indicaciones para [1003]

**Versión:** v6.40 (2026-08-16) — **corrige la sección 3.1**: ya NO se debe
llamar `PUT /picking` al simple abrir la pantalla. Ver §0 antes de seguir
si ya integraron la v6.19 original.
**Estado:** El mecanismo YA EXISTE en OMNI API CORE — no requiere ninguna
migración. Es un ajuste de [1003].
**Prioridad:** Alta — se perdió trabajo real de un operario por un refresco
de navegador (v6.19, sigue vigente); además, abrir un pedido para
supervisarlo ya no debe cambiar su estado (v6.40, nuevo).

---

## 0. Qué cambió respecto a v6.19 — leer primero

La v6.19 original decía: *"llamar `PUT /picking` con `items: []` apenas se
abre la pantalla, para que el estado pase a `EN_PICKING` de inmediato."*
**Eso ya no es correcto — se corrige acá.**

**Motivo del cambio:** en la práctica, alguien abre un pedido para
**revisarlo o supervisar la operación sin empezar a gestionarlo**. Con el
comportamiento anterior, ese simple vistazo ya cambiaba el estado a
`EN_PICKING`, aunque nadie hubiera tocado un solo ítem — información
falsa sobre si el picking realmente empezó.

**Comportamiento nuevo (ya implementado en el core, v6.40):**
`PUT /picking` con `items: []` (o con ítems pero ninguno con
`quantity_picked`) **ya no transiciona de estado** — responde `200` con
`"started": false` y el traspaso se queda en `SOLICITADO`. La transición a
`EN_PICKING` ocurre **solo** cuando llega al menos un ítem con
`quantity_picked` real (incluyendo `0` explícito — marcar "no hay stock" en
un ítem también cuenta como gestión real, no solo cantidades positivas).

---

## 1. El problema reportado (v6.19, sigue vigente)

Durante una jornada de trabajo, se refrescó el navegador y **se perdió un
picking que se estaba realizando** — el operario tuvo que empezar de nuevo.

## 2. Evaluación del core: no hace falta construir nada nuevo

Revisamos el backend y **el mecanismo de guardado incremental ya existe**,
desde hace varias versiones — el mismo principio que ya usan para
`BORRADOR` en la toma de pedidos. El problema no es que falte el endpoint;
es que, aparentemente, la pantalla de picking de [1003] no lo está usando
de forma incremental — probablemente acumula los ítems pickeados en memoria
del navegador y solo los manda al final, con un único `PUT /picking`. Si
eso es así, es exactamente el mismo patrón de bug que ya corregimos antes
en la toma de pedidos.

## 3. Cómo usar lo que ya existe

### 3.1 Abrir la pantalla para consultar/supervisar — sin efecto de estado

```
GET /api/v1/inventory/transfers/{id}
```

Usar **solo esto** para mostrar el pedido al abrir la pantalla — consultar
no debe cambiar nada. **Ya no llamar `PUT /picking` con `items: []` al
abrir** (corrección v6.40, ver §0). Si nadie marca ningún ítem, el pedido
se queda en `SOLICITADO` indefinidamente — correcto, es justamente lo que
se pidió.

### 3.1.1 Cuando el operario marca el PRIMER ítem — ahí sí inicia el picking

```
PUT /api/v1/inventory/transfers/{id}/picking
{ "items": [ { "item_id": 101, "batch_id": 55, "quantity_picked": 8, "notes": "" } ] }
```

Llamar esto **con los datos del primer ítem que el operario realmente
marca** (no antes, no vacío) — este único llamado guarda ese ítem **y**
transiciona el traspaso a `EN_PICKING` en el mismo paso. La respuesta trae
`"started": true` cuando esto sucede.

```
PUT /api/v1/inventory/transfers/{id}/picking
{ "items": [] }
```

Llamar esto **apenas el operario abre la pantalla de picking** de un
traspaso en `SOLICITADO` — mueve el estado a `EN_PICKING` de inmediato,
**sin necesidad de tener ya ningún ítem pickeado.** Esto es clave: a partir
de este momento, cualquier corte de sesión ya no pierde el hecho de que el
picking "empezó".

### 3.2 Del segundo ítem en adelante — guardar al momento, no acumular en el cliente

```
PATCH /api/v1/inventory/transfers/{id}/picking-items
{ "items": [ { "item_id": 101, "batch_id": 55, "quantity_picked": 8, "notes": "" } ] }
```

**Llamar esto cada vez que el operario confirma un ítem** (o cada pocos
ítems, si prefieren agrupar por eficiencia de red — pero nunca esperar
hasta el final). No cambia de estado — el traspaso sigue en `EN_PICKING`
todo el tiempo que haga falta. Se puede llamar tantas veces como se
necesite, incluyendo para corregir una cantidad ya guardada.

**No acumulen el picking en memoria/estado local del navegador como fuente
de verdad.** El servidor debe ser la fuente de verdad en todo momento —
igual que ya hacen con `BORRADOR`.

### 3.3 Recuperar el progreso si se corta la sesión o se refresca

```
GET /api/v1/inventory/transfers/{id}
```

Al abrir (o reabrir) la pantalla de picking de un traspaso que ya está en
`EN_PICKING`, traer el detalle completo primero — cada ítem en
`data.items[]` ya trae `quantity_picked` y `picking_notes` con lo último
guardado. Precargar la pantalla con esos valores, en vez de partir vacío.

Esto significa que, si el navegador se refresca a mitad de un picking, al
volver a entrar la pantalla debe mostrar exactamente lo que ya se había
guardado — no debe haber ninguna pérdida, sin importar en qué ítem
específico haya ocurrido el corte.

### 3.4 Terminar el picking

`PUT /dispatch` sigue siendo el paso que cierra el picking
(`EN_PICKING → LISTO_DESPACHO`) — sin cambios, ya lo tienen implementado.

## 4. Resumen de una línea

> Abrir la pantalla es solo `GET` — no cambia el estado. El estado pasa a
> `EN_PICKING` cuando llega el **primer** ítem con `quantity_picked` real,
> vía `PUT /picking` (guarda ese ítem y transiciona en el mismo llamado).
> Del segundo ítem en adelante, `PATCH /picking-items` al momento, no al
> final. Al reabrir, precargar desde `GET /transfers/{id}` — el servidor ya
> tiene todo lo último guardado.

## 5. Qué NO cambia

- El resto del flujo (`/dispatch`, `/route`, `/deliver`, `/close`) sigue
  exactamente igual.
- No hay ningún endpoint nuevo, ni campo nuevo, ni migración. Es 100%
  ajuste de consumo del lado de [1003].

## 6. Nota sobre acceso concurrente (fuera de alcance de este ajuste)

Si dos operarios abren el picking del mismo traspaso al mismo tiempo, el
último `PATCH` que llegue por ítem es el que queda guardado (no hay bloqueo
ni control de conflicto). No se pidió resolver esto — si en la práctica es
un problema real (dos personas pickeando el mismo traspaso a la vez), es un
requerimiento aparte a evaluar.

## 7. Etiquetas del mapa de estados en la pantalla (v6.40 — solo UI, sin cambios de API)

Pedido explícito: cambiar la descripción visible de los dos estados que
aparecen en el mapa de colores de la pantalla de picking —

| Estado real (`state` en la API) | Etiqueta a mostrar |
|---|---|
| `SOLICITADO` | **Nuevas** |
| `EN_PICKING` | **En preparación** |

Esto es puramente una etiqueta/color en la interfaz de [1003] — el valor
que viaja en la API (`transfers.state`) **no cambia**, sigue siendo
`SOLICITADO`/`EN_PICKING` tal cual. Solo se traduce el texto que ve el
usuario.

---
*Contrato de datos definido y mantenido desde OMNI API CORE [1001]. Documento
permanente — vive en `docs/` junto al resto de manuales del proyecto.*
