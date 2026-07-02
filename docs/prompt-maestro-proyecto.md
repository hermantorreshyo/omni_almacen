# PROMPT MAESTRO — JOSEPAN 360 · OMNI · [1003] Gestión de Almacenes y Mermas
## Documento de arquitectura completa para reconstrucción del subsistema
### API CORE de referencia: v6.6.0

---

## ROL Y CONTEXTO

Actúa como **Desarrollador Frontend/Backend Senior** del ecosistema JOSEPAN 360
(holding de panaderías artesanales en España). Vas a construir **[1003] Gestión
de Almacenes y Mermas**, una micro-app **stateless** (sin base de datos propia)
que consume el **OMNI API CORE v6.6.0** en `https://api.omni.josepan.app/api/v1`.

**Stack obligatorio (LAMP Vanilla):** PHP 8.1+ (`declare(strict_types=1)`,
POO/SOLID, PDO), HTML5 + Tailwind (CDN) + Vanilla JS (ES6+). **Sin** Composer,
Docker, ni frameworks JS. Coherencia gráfica con [1002]: Inter, fondo `#f4f5f7`,
cards blancas, marca `#642a72`, mobile-first táctil (targets ≥46px).

---

## REGLAS ABSOLUTAS DEL ECOSISTEMA

1. Toda persistencia/validación ocurre en el API CORE. Nunca BD propia.
2. El navegador **solo** habla con el proxy PHP mismo-origen `api/omni.php` (cero CORS).
3. El proxy usa el SDK `OmniCoreClient.php` (no modificar) e inyecta en cada
   llamada autenticada: `Authorization: Bearer {token}` y `X-Interlocutor-Id`.
4. El JWT vive en la cookie de sesión PHP (HttpOnly). Nunca en JS.
5. Sobre de respuesta del API: `{ status:'success'|'error', data, message, error_code }`.
   El SDK lo desenvuelve a `{ ok, data, error, code }`.
6. Cantidades **siempre en unidad base** (g/ml/ud). La UI convierte (Metrology).
7. Contraseña inicial de cada usuario = su propio username. El token expira en 8 h;
   ante `401 ERR_AUTH` → volver al login.
8. `X-Interlocutor-Id` aplica el filtro perimetral: cada sede ve solo lo suyo.

---

## ARQUITECTURA

```
Navegador (JS) ──fetch same-origin──► api/omni.php ──cURL (Bearer + X-Interlocutor-Id)──► API CORE v6.6.0
```

`api/omni.php` enruta por `?action=` y reenvía a los endpoints del API CORE,
desenvolviendo el sobre. Estructura de ficheros:

```
1003_app/
├── index.html              SPA (todas las vistas + estilos)
├── .htaccess               RewriteBase / + cabeceras de seguridad
├── .env.example / setup.sh  configuración y despliegue plug&play
├── api/
│   ├── omni.php            proxy mismo-origen + router por ?action=
│   └── OmniCoreClient.php  SDK cURL (desenvuelve el sobre)
├── js/
│   ├── api-client.js       cliente mismo-origen (ApiError tipada; evento 401)
│   ├── metrology.js        conversión a unidad base + formatQty(pack_size)
│   ├── scanner.js          QR (BarcodeDetector) + foto base64 + alarma
│   ├── outbox-service.js   cola FIFO offline + parada de emergencia
│   └── app.js              router de vistas + lógica de flujos
└── docs/                   manuales y este prompt
```

---

## AUTENTICACIÓN (LOGIN EN 2 FASES + INTERLOCUTOR)

1. **Credenciales** (no se envían aún): el usuario las introduce.
2. **Selección de tienda/bodega**: tras una validación inicial se listan los
   interlocutores; el usuario elige su sede.
3. **Login real con la sede** → `POST /auth/login` con `{username, password,
   interlocutor_id}`. **API CORE v6.8 fija el rol del JWT según ese
   `interlocutor_id`**, por lo que la sede debe enviarse en el login (no por
   header posterior). Respuesta: `{token, role, interlocutor_id, interlocutor_name, permissions}`.
4. **Pantallas**: `GET /rbac/subsystems/1003/my-screens` devuelve **siempre un
   array** de claves (v6.8): el SuperAdmin recibe todas + `gestor_permisos`; el
   resto, las asignadas; vacío si ninguna. El subsistema solo itera el array.

> Implementación: el proxy hace una validación provisional para listar sedes
> (`action=login`) y **re-autentica** con la sede elegida (`action=login_sede`),
> de modo que el JWT persistido lleva el rol de esa sede. Un cambio de sede exige
> logout + login.

> SuperAdmin (detección robusta: el rol contiene `superadmin`, admite
> `SuperAdministrador`) ve **todas** las pantallas y el **Gestor de Permisos**.

---

## PANTALLAS Y FLUJOS (claves estables)

| Clave | Pantalla | Endpoint(s) del API CORE |
|---|---|---|
| `recepcion` | Recepción contra OC/albarán de [1002] | `GET /purchasing/orders` (pendientes) → `GET /purchasing/orders/{id}` (líneas) → por SKU `POST /inventory/reception` (lote inline) → `PUT /purchasing/orders/{id}/receive` (estado almacenado) |
| `ubicar` | Ubicación interna (QR) | `POST /inventory/transfer` (`movement_type:"Traslado Interno"`) |
| `solicitar` | Solicitar traspaso | `POST /inventory/transfers` (items `{item_id,item_type,batch_id,quantity_requested}`; el API exige `batch_id`, que el cliente resuelve por **FEFO** vía `/inventory/batches?item_id=&location_id={origen}` (stock real en bodega del OBRADOR) sin pedir el lote al usuario; origen=OBRADOR, destino=interlocutor solicitante) |
| `picking` | Picking de traspasos | `PUT /inventory/transfers/{id}/picking` · `/dispatch` |
| `transporte` | Ruta de transporte | `PUT /inventory/transfers/{id}/route` · `/deliver` |
| `recibir` | Recepción de traspaso | `PUT /inventory/transfers/{id}/close` |
| `merma` | Registro de merma | `POST /inventory/scrap` (`reason`, `file_data` opcional) |
| `dashboard` | Panel de traspasos (KPIs) | `GET /inventory/transfers` (informe; ignora estado del SKU) |
| `gestor_permisos` | Gestor de permisos (SuperAdmin) | `GET /rbac/roles`, `GET/PUT /rbac/subsystems/1003/screen-permissions`, `GET /rbac/subsystems/1003/screens` |

**Workflow de traspaso:** `SOLICITADO → EN_PICKING → LISTO_DESPACHO → EN_RUTA →
PENDIENTE_RECEPCION → CERRADO`. Stock: descuenta origen en `/route`, incrementa
destino en `/close`. El RBAC por transición lo valida el API CORE.

**Catálogos:** `/catalog/skus` (campos `name`, `sku_final_code`, `unit_of_measure`,
`pack_size`, `status`; filtro `?q=&status=active&limit=`), `/catalog/locations`
(`qr_code_uid`, `area_type`, `shelf`, `position`, `interlocutor_id`),
`/inventory/batches?item_id=` (`batch_reference`, `expiration_date`).

---

## REQUISITOS DE UI

- **Buscador de SKU** (typeahead contra `?q=`) **con listado** visible (≈1000 SKUs).
  Solo SKUs `status:"active"` en operativa; el panel/histórico muestra todos.
- **Home** ordenado y con **color por área/rol**: Almacén `#642a72`, Transporte
  `#F59E0B`, Tienda `#2563eb`, Mermas `#EF4444`, Gestión `#6b7280` (con leyenda).
- **Mermas:** foto obligatoria (habilita el botón). **Recepción:** lote inline.
- **Solicitar:** origen (OBRADOR, `?type=fabrica`) y destino (interlocutor de
  trabajo) como solo lectura; mapear a `location_id` vía `interlocutor_id`.
- **Resiliencia:** Outbox (cola FIFO localStorage) + parada de emergencia (rojo +
  alarma) ante error fatal. Listas de traspaso vacías/no disponibles → "No hay
  traspasos pendientes." (sin error visible).
- **Pack_size:** mostrar cantidades con `Metrology.formatQty` (ej. `4 ud (28 kg)`).

---

## CÓDIGOS DE ERROR

`401 ERR_AUTH` (→login) · `403 ERR_RBAC` · `404 ERR_NOT_FOUND` · `409 ERR_STATE`
(transición inválida) · `409 ERR_STOCK` · `409 ERR_DUPLICATE` · `400/422
ERR_VALIDATION/ERR_PARAM` · `500 ERR_INTERNAL`. El `error_code` viaja en el sobre.

---

## INVARIANTES

- Kardex inmutable (append-only); stock por delta atómico; FEFO estricto.
- Idempotencia: `ERR_DUPLICATE` = éxito silencioso.
- Soft deletes con `deleted_at`/`deleted_by`.
- El catálogo de pantallas registrado (`GET /rbac/subsystems/1003/screens`) es la
  fuente de verdad del Gestor de Permisos (intersecado con lo que [1003] renderiza).

---

## PARÁMETROS DE IMPLANTACIÓN (GET /system/params)

Tras el login, `GET /system/params` devuelve banderas que adaptan las
validaciones del cliente (se guardan en `state.params`):

- **Modo implantación** (`inventory_restriction=false`, `stock_negative_allowed=true`):
  el FEFO consulta lotes con `include_empty=1`, acepta `quantity_available=0` y
  **no** muestra avisos de stock; despachos/traspasos/mermas se procesan aunque el
  stock sea insuficiente (puede quedar negativo).
- **Modo producción** (`inventory_restriction=true`, `stock_negative_allowed=false`):
  el FEFO solo trae lotes con stock; sin lotes → "Sin stock en bodega"; si el lote
  no cubre lo pedido → aviso; el API bloquea despachos sin stock.

El SuperAdmin activa el modo producción desde el Panel Admin; el subsistema cambia
de comportamiento solo al releer los parámetros en la siguiente sesión (sin recompilar).

---

## MÉTRICAS DEL WORKFLOW DE TRASPASO

`quantity_requested` (solicitado) → `quantity_dispatched` (despachado en picking)
→ `quantity_received` (recibido al cerrar). El cierre incluye `reception_date`.
Diferencias: requested−dispatched = pedido no atendido; dispatched−received =
pérdida en tránsito.

---
*Reconstruir el subsistema respetando estas reglas. Validar siempre las rutas contra la colección Postman antes de producción.*
