# [1003] JOSEPAN 360 OMNI — Gestión de Almacenes y Mermas

Micro-app web (PWA táctil, mobile-first) del ecosistema OMNI para recepción
contra albarán, ubicación física por QR, traspasos externos reglamentados y
registro de mermas con foto. Stack **LAMP Vanilla** (PHP 8.1+, Vanilla JS, sin
frameworks). Coherencia gráfica con [1002].

## Arquitectura de red

```
Navegador  ──(mismo origen)──►  api/omni.php  ──(cURL)──►  API CORE v6 [1001]
   JS                              proxy PHP                api.omni.josepan.app
```

El navegador **solo** habla con `api/omni.php` (mismo dominio) ⇒ **cero CORS**.
El proxy resuelve sesión (cookie HttpOnly + SameSite=Strict), aplica RBAC por
acción y reenvía al API CORE añadiendo `Authorization: Bearer` y
`X-Interlocutor-Id`. El JWT nunca vive en JavaScript.

## Requisitos

- PHP 8.1+ con extensión **cURL**
- Apache con `mod_rewrite` y `mod_headers`
- El API CORE v6 accesible desde el servidor

## Instalación

```bash
git pull                 # en el servidor Debian
bash setup.sh            # genera .env y verifica PHP/cURL
# editar .env si el host del API CORE cambia
```

Apunta el `DocumentRoot` del VirtualHost a la raíz del proyecto y recarga
Apache. El `.htaccess` ya fija `RewriteBase /` (evita el bucle de redirección).

## Variables de entorno (`.env`)

| Variable           | Por defecto                     | Descripción                         |
|--------------------|---------------------------------|-------------------------------------|
| `OMNI_API_HOST`    | `https://api.omni.josepan.app`  | Host del API CORE, sin barra final  |
| `OMNI_API_PREFIX`  | `/api/v1`                        | Prefijo de versión                  |

## Mapa de carpetas

```
1003_app/
├── index.html              SPA maestra (todas las vistas + estilos)
├── .htaccess               RewriteBase / + cabeceras de seguridad
├── .env.example            plantilla de configuración
├── setup.sh                despliegue plug&play
├── api/
│   ├── omni.php            proxy único mismo-origen + RBAC por acción
│   └── OmniCoreClient.php  SDK cURL (sustituir por el canónico del ecosistema)
└── js/
    ├── api-client.js       cliente mismo-origen (errores tipados)
    ├── metrology.js        conversión a unidad base (g/ml/ud) en frontera
    ├── scanner.js          QR (BarcodeDetector) + foto comprimida + alarma
    ├── outbox-service.js   cola FIFO offline + parada de emergencia
    └── app.js              router de vistas y lógica de los 4 flujos
```

## Flujos

1. **Recepción** contra albarán de compra (confirmar concordancia; observación si hay diferencia).
2. **Ubicación** física por escaneo QR.
3. **Traspaso externo**: SOLICITADO → EN_PICKING → LISTO_DESPACHO → EN_RUTA/PENDIENTE_RECEPCION → CERRADO (interfaz por rol).
4. **Mermas** con foto obligatoria (VENCIMIENTO / DESPERFECTO).

**Gestor de permisos (solo SuperAdmin):** pantalla exclusiva donde se asocia
cada pantalla del módulo a los roles operativos del API CORE. El SuperAdmin ve
**todas** las pantallas (pruebas) y, para el resto de roles, las pantallas
visibles se resuelven dinámicamente desde el API CORE (`mis_pantallas`); si el
API no responde el mapa, el cliente cae a sus valores por defecto.

Resiliencia offline mediante **Outbox** (cola FIFO en `localStorage`). Ante error
fatal no recuperable se activa la **parada de emergencia** (pantalla roja + alarma).

## Contrato del API CORE v6.9

El SDK (`api/OmniCoreClient.php`) **desenvuelve** el sobre canónico
`{ status, data, message }`. Mapeo de campos reales aplicado en el cliente:

- SKUs (`/catalog/skus`): `name`, `sku_final_code`, `unit_of_measure`, `id`→`item_id`. Filtros `?q=&item_type=&is_standardized=`.
- Ubicaciones (`/catalog/locations`): `qr_code_uid` (casa el escaneo QR), etiqueta `area_type+shelf+position`, `id`→`location_id`.
- Lotes (`/inventory/batches?item_id=`): `batch_reference`, `expiration_date`, `id`→`batch_id` (FEFO, filtrado por SKU).

Operaciones atómicas: recepción (`/inventory/reception`, lote **inline** vía
`batch:{batch_reference,expiration_date}`), ubicación = `Traslado Interno` y
merma (`/inventory/scrap`, `file_data` opcional).

Workflow de traspaso externo en `/inventory/transfers` (plural, multi-estado):
`SOLICITADO→EN_PICKING→LISTO_DESPACHO→EN_RUTA→PENDIENTE_RECEPCION→CERRADO`, con
ítems `{item_id,batch_id,quantity_requested|dispatched|received}`. El **RBAC por
transición lo aplica el API CORE** (autoridad); el proxy mantiene auth y
same-origin, y la visibilidad de pantallas la entrega `my-screens` en el login.

## Documentación del proyecto (carpeta `docs/`)

- `manual_usuario.html` — guía rápida para el operario (HTML autocontenido).
- `manual_tecnico.html` — manual técnico/desarrollador (HTML autocontenido).
- `prompt-maestro-proyecto.md` — prompt de reconstrucción completa del subsistema.
- `1003-postman-collection.json` — colección Postman de las acciones del proxy.

## Pendiente de validación

- Sustituir `api/OmniCoreClient.php` por el SDK canónico del ecosistema (este replica el contrato).
- Ejecutar la migración de BD del API CORE antes de activar el workflow de traspasos.
- Registrar la clave de pantalla `dashboard` en el catálogo del API CORE (admin visual o curl); una vez registrada, el Gestor de Permisos la ofrece y aparece en `/my-screens` según los roles asignados.
