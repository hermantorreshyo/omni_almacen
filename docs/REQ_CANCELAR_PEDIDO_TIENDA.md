# REQUERIMIENTO AL OMNI API CORE — Cancelación de pedido por la tienda dueña

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Endpoint solicitado:** nuevo, `PUT /inventory/transfers/{id}/cancel` (o equivalente)
**Prioridad:** Media-Alta
**Estado:** ✅ ATENDIDA (v6.31) — PUT /inventory/transfers/{id}/cancel implementado. Permiso inventory.write (dueño, no admin); propiedad validada por el token contra interlocutor_id_dest; solo BORRADOR/SOLICITADO (409 en otro estado); pasa a CANCELADO sin borrar ni tocar inventario; auditoría en transfer_log. reason opcional (recomendado). [1003] ya lo consume.

---

## 1. Necesidad de negocio

Una tienda debe poder **cancelar un pedido propio** que ya no necesita, **siempre que
aún no haya entrado a picking**. En esta plataforma **no se elimina nada** de la base de
datos: "cancelar" significa marcar el pedido como **`CANCELADO`**, conservando el
histórico. Es el estado que mejor refleja la realidad del pedido.

Desde el **Panel de traspasos**, la tienda verá un ícono (papelera) para cancelar,
**solo** en sus propios pedidos y **solo** mientras estén en `BORRADOR` o `SOLICITADO`.

## 2. Lo que ya existe y por qué no alcanza

- `DELETE /inventory/transfers/{id}` — solo `BORRADOR`, y **borra** el borrador (no es lo
  que queremos para SOLICITADO, donde hay que conservar el registro como CANCELADO).
- `PUT /inventory/transfers/{id}/admin-state` — permite pasar a `CANCELADO`, pero es
  **exclusivo de SuperAdministrador**. No sirve para que **cada tienda cancele los
  suyos**.

Falta un endpoint de **cancelación por el dueño**, con permiso operativo (no admin).

## 3. Lo que se solicita

```
PUT /inventory/transfers/{id}/cancel
{ "reason": "La tienda ya no necesita el pedido" }
```

**Reglas:**
1. **Estados permitidos:** solo `BORRADOR` y `SOLICITADO`. En cualquier otro estado
   (EN_PICKING en adelante) → rechazar (`409 ERR_STATE`): una vez inicia el picking, ya
   no se cancela.
2. **Propiedad:** solo el **dueño** del pedido (la sede **origen/solicitante**) puede
   cancelarlo. Un usuario de otra tienda → rechazar (`403`). Idealmente el core valida
   esto contra el `interlocutor` del token, no confiando en el frontend.
3. **Efecto:** pasa el pedido a **`CANCELADO`** (no se borra el registro). En `BORRADOR`
   y `SOLICITADO` no hay movimientos de inventario, así que **no** debe tocar
   `inventory_stock`/`inventory_kardex`.
4. **Auditoría:** registrar quién canceló y el motivo (como ya se hace en `transfer_log`).
   Sugerimos `reason` recomendado; si no viene, "Sin motivo indicado".
5. **Permiso:** operativo de tienda (el mismo con el que crea/solicita pedidos), **no**
   el permiso admin. Confírmennos cuál.

### 3.1 Preguntas al core

1. ¿Prefieren un endpoint dedicado `/cancel` (propuesto) o habilitar `CANCELADO` como
   destino en un flujo existente para el dueño? Para [1003] es más claro el `/cancel`.
2. ¿El core resuelve la validación de propiedad por el token, o debemos enviar el
   `interlocutor_id` del solicitante?
3. ¿Confirman que en `BORRADOR`/`SOLICITADO` no hay ningún efecto de inventario que
   revertir?

## 4. Qué hará [1003] mientras tanto

- Ya muestra el ícono de cancelar en el Panel, **solo** en pedidos propios en
  `BORRADOR`/`SOLICITADO`.
- Para `BORRADOR`, si el negocio lo aceptara, podríamos usar el `DELETE` actual — pero
  como el criterio es **no borrar nada**, preferimos esperar este endpoint para que
  **ambos** casos (BORRADOR y SOLICITADO) queden como `CANCELADO` de forma uniforme.
  Hasta entonces, el botón muestra un aviso de "función pendiente en el API CORE".
- Al existir el endpoint, [1003] llamará `PUT /cancel` con el motivo y refrescará.

## 5. Resumen

> Se necesita `PUT /inventory/transfers/{id}/cancel` (dueño, no admin) que pase un pedido
> en `BORRADOR`/`SOLICITADO` a `CANCELADO`, conservando el registro y sin tocar
> inventario. Es la vía para que cada tienda "quite" de su vista un pedido que ya no
> necesita, reflejándolo como CANCELADO en el histórico.

---
*[1003] — Requerimiento para el hilo del API CORE.*
