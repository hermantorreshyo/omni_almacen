# Ajuste — Reporte de productos recibidos/despachados por sede

**Versión:** v6.46 (2026-08-19)
**Estado:** Implementado en OMNI API CORE — pantalla nueva en [1003]
**Prioridad:** Alta

---

## 1. Qué se pide

Que cada tienda pueda consultar, desde [1003], un reporte de **productos
recibidos** — y que un **obrador** (§50 del manual — un interlocutor que
puede proveer insumos/producto terminado a otros) pueda consultar sus
**productos despachados**. Cada uno ve **solamente** lo que le corresponde
a la sede con la que inició sesión — sin excepción, sin selector de otra
sede.

## 2. Endpoint

```
GET /inventory/reports/my-products?date_from=&date_to=&item_id=&interlocutor_id=&page=&limit=
```

Permiso `inventory.read` — el mismo que ya usan para consultar sus propios
traspasos, no requiere nada especial de su lado.

**No manda ningún parámetro de "qué sede consultar"** — el core resuelve
la sede automáticamente desde el token de la sesión. Si intentan pasar un
`interlocutor_id` pensando que selecciona la sede propia, no tiene ese
efecto — ver §4 para lo que sí hace ese parámetro.

## 3. Dos vistas automáticas, según el tipo de sede logueada

El core resuelve solo, sin que la pantalla tenga que decidir nada:

- **Si la sede es una tienda** (no obrador): responde con
  `"view": "recibido"` — todo lo que esa tienda ha recibido.
- **Si la sede es un obrador** (`is_obrador=1`, ver §50 del manual):
  responde con `"view": "despachado"` — todo lo que esa sede ha despachado
  hacia otras.

**Recomendación de pantalla:** título/encabezado dinámico según
`response.data.view` — "Productos Recibidos" o "Productos Despachados" —
no hace falta que [1003] sepa de antemano qué tipo de sede es, el propio
reporte lo indica.

## 4. Filtros

| Parámetro | Aplica a | Descripción |
|---|---|---|
| `date_from` / `date_to` | Ambas vistas | Rango de fechas. Por defecto, últimos 30 días. |
| `item_id` | Ambas vistas | Sigue a un SKU puntual — obtenerlo de `GET /catalog/skus?q=...`. |
| `interlocutor_id` | **Solo vista "despachado"** | Filtra por interlocutor **receptor** — no tiene efecto en la vista "recibido" (el receptor siempre es la propia sede). |

## 5. Respuesta

```json
{
  "interlocutor_id": 12,
  "interlocutor_name": "CARTAGENA",
  "view": "recibido",
  "date_from": "2026-07-20", "date_to": "2026-08-19",
  "items": [
    {
      "item_id": 340, "sku_final_code": "PT-PAN-001234",
      "item_name": "Pan de Molde 500g", "unit_of_measure": "unidad",
      "quantity_total": 480, "transfer_count": 6
    }
  ],
  "totals": { "quantity_total": 3240, "items_distinct_count": 18 },
  "pagination": { "page": 1, "limit": 50, "total_rows": 18, "total_pages": 1 }
}
```

En la vista `despachado`, cada ítem trae además `destinations_count`
(cuántas sedes distintas recibieron ese producto en el rango) — útil si
quieren mostrar "despachado a N tiendas" sin necesitar el detalle completo.

## 6. Diferencia importante entre las dos vistas — no son la misma métrica invertida

- **Recibido** (tienda): usa la cantidad **confirmada** — en `CERRADO`, solo
  cuenta si `disposition='recibido'` (lo `no_recibido`/`devuelto` no
  cuenta); en `PENDIENTE_RECEPCION`, usa lo despachado como estimado
  todavía sin confirmar.
- **Despachado** (obrador): usa `quantity_dispatched` **directo** — lo que
  esa sede efectivamente envió, sin importar qué confirme después el
  destino. Puede ser mayor a lo que el destino termine reportando como
  "recibido" si algo se pierde o se devuelve en el camino — es una métrica
  distinta a propósito, no la misma vista mirada desde el otro lado.

## 7. Resumen

> Una sola pantalla nueva en [1003], que llama
> `GET /inventory/reports/my-products` — el core decide sola la vista
> (recibido/despachado) según el tipo de sede logueada, y siempre limita
> los datos a esa sede. Filtros de fecha y SKU en ambas vistas; filtro de
> interlocutor receptor solo aplica si la sede es un obrador.

---
*Contrato de datos definido y mantenido desde OMNI API CORE [1001]. Documento
permanente — vive en `docs/requerimientos/` junto al resto de REQs.*
