# REQUERIMIENTO AL OMNI API CORE — Hora de corte de pedidos (configurable)

**Subsistema solicitante:** [1003] Gestión de Almacenes y Mermas
**Prioridad:** Media — [1003] ya agrupa por ventana de corte con valor por defecto (12:00);
esto lo hace configurable y centralizado.
**Estado:** PENDIENTE en [1001].

---

## 1. Contexto de negocio

Los pedidos (traspasos) se organizan por **ventanas de corte**: una franja que va de la
**hora de corte** de un día a la hora de corte del día siguiente. Ejemplo con corte a las
12:00 (Europe/Madrid):

> Un pedido creado el **10-ago a las 15:00** pertenece a la ventana
> **10-ago 12:00 → 11-ago 12:00**, y se alista en el corte del **11-ago 12:00**.
> Un pedido creado el **11-ago a las 09:00** cae en esa **misma** ventana.
> Uno creado el **11-ago a las 13:00** ya pertenece a la ventana siguiente.

[1003] usa esto para **agrupar** los pedidos en la pantalla de picking: solo se juntan
(misma tienda) los pedidos de la **misma ventana de corte**. La ventana se decide por la
**fecha de creación** del pedido, en **hora de Madrid**.

## 2. Lo que se solicita

Exponer la **hora de corte** como un **parámetro de configuración del sistema**,
consultable por los subsistemas. Hoy [1003] la tiene fija en 12:00; se requiere poder
cambiarla sin tocar código.

Necesitamos del core:

1. **Un parámetro configurable**, p. ej. `pedidos.cutoff_hour` (entero 0–23, hora de
   Madrid). Idealmente editable desde el panel de administración.
2. **Un endpoint para consultarlo.** [1003] ya intenta leerlo de forma tolerante; solo
   necesitamos el contrato real. Propuesta:
   ```
   GET /api/v1/config?key=pedidos.cutoff_hour
   → { "key": "pedidos.cutoff_hour", "value": 14 }
   ```
   O, si prefieren un bloque de configuración:
   ```
   GET /api/v1/config/pedidos
   → { "cutoff_hour": 14, "timezone": "Europe/Madrid" }
   ```
   Indíquennos la forma definitiva (nombre del endpoint, clave y tipo del valor).

### 2.1 Preguntas al core

1. ¿La hora de corte es **global** para todo el ecosistema, o podría ser **por sede/CEDI**?
   Si por sede, el endpoint debería aceptar `interlocutor_id`. Para empezar nos vale
   global.
2. ¿Confirman que la referencia horaria es **Europe/Madrid**? [1003] calcula la ventana
   en esa zona.
3. ¿Exponen también la **zona horaria** como parte de la config, o la asumimos fija?

## 3. Alcance actual de [1003] (opción A — solo vista)

- Ya implementado: agrupación **visual** de pedidos por **tienda + ventana de corte** en
  picking, con la ventana calculada a partir de la fecha de creación (hora de Madrid) y
  **hora de corte 12:00 por defecto**.
- Cuando este endpoint exista, [1003] leerá la hora configurada y la usará en lugar del
  valor por defecto (ya está cableado: `sysConfig('pedidos.cutoff_hour')`).

## 4. Fuera de alcance de este REQ (posible fase B, a decidir)

El **corte "duro"** (que el sistema bloquee o mueva automáticamente los pedidos según la
ventana, cierre la franja a la hora exacta, o marque cada pedido con su ventana en la BD)
**no** está en este requerimiento. Hoy [1003] solo agrupa visualmente. Si el negocio
quiere el corte real a nivel de datos, se levantará un REQ aparte para que [1001] añada,
por ejemplo, un campo de ventana/fecha de despacho en el traspaso y la lógica asociada.

---
*[1003] — Requerimiento para el hilo del API CORE.*
