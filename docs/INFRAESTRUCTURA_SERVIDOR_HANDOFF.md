# Handoff — Infraestructura del servidor (certificados, vhosts y sistema)

**Origen:** hilo de desarrollo de [1003] Gestión de Almacenes y Mermas
**Destino:** hilo dedicado a infraestructura / administración del servidor JOSEPAN 360
**Fecha:** 2026-07-31
**Motivo:** La administración de certificados, vhosts de Apache y salud del servidor
**se sale del alcance de [1003]** (que es una app web del ecosistema OMNI). Este documento
traspasa todo el contexto para que otro hilo se encargue de forma continua de la
infraestructura.

---

## 1. Contexto del ecosistema (qué es esto)

JOSEPAN 360 es una panadería artesanal (España) con ~14 tiendas + CEDI (centro de
distribución/producción). Su plataforma interna es el **ecosistema OMNI**: un conjunto de
subsistemas web/API que comparten un núcleo. Todos corren en **un único servidor**.

**Stack:** LAMP sobre **Debian 13**, **Apache**, **MySQL/MariaDB 8.x**, **PHP 8.1+**.
Sin Docker, sin frameworks JS. Cada subsistema es un vhost de Apache con su subdominio.

**Servidor:** `srv1732343` (acceso root por SSH). Certbot instalado en `/usr/bin/certbot`.

### Subsistemas y sus subdominios

| Subsistema | Rol | Subdominio |
|---|---|---|
| [1001] OMNI API CORE | API núcleo (SSOT) | `api.omni.josepan.app` |
| [1002] Compras/Albaranes | Compras | `compras.josepan.app` |
| [1003] Almacenes y Mermas | App de almacén (este hilo) | `almacen.josepan.app` |
| [1004] Producción | Terminal de planta | `produccion.josepan.app` |
| [1005] Ágora TPV | Punto de venta | (no desplegado) |
| [1006] Watchdog & Analytics | Microservicio Python | `watchdog.josepan.app` (**en despliegue**) |
| [1007] Notificaciones y Alertas | Notificaciones | `notificaciones.josepan.app` |
| Academy | Formación | `academy.josepan.app` |
| Apex / futura intranet | Portal de accesos | `josepan.app` (+ `www`) |

---

## 2. Incidente resuelto — Certificado SSL "conexión insegura" en equipos antiguos

### Síntoma
Algunos usuarios (no todos) veían **`NET::ERR_CERT_AUTHORITY_INVALID`** / "conexión
insegura". Patrón "en unos dispositivos sí, en otros no".

### Causa raíz
Los certificados de Let's Encrypt se habían emitido en **ECDSA**, con cadena anclada en
la raíz **`ISRG Root X2`** (intermedios `YE1`/`YE2`). Esa raíz ECDSA nueva **no está en
el almacén de confianza de dispositivos antiguos** (Android viejo, etc.), que por tanto
rechazan el certificado. Los equipos modernos la reconocen y no ven el error.
SSL Labs mostraba "Trusted: Yes" porque prueba contra trust stores actualizados con el
cross-sign X2←X1 — pero los equipos viejos no tienen ni X2 ni esa actualización.

### Solución aplicada (2026-07-31) — RESUELTO para las apps
Reemitidos los **7 subdominios de las apps** en **RSA anclado a `ISRG Root X1`** (la raíz
RSA clásica, presente en casi todos los dispositivos), con certbot:

```bash
certbot certonly --cert-name <dominio> \
  --key-type rsa --preferred-chain "ISRG Root X1" \
  -a apache --force-renewal -d <dominio>
```

Cadena resultante verificada (los 7): `hoja → YR1/YR2 (RSA) → Root YR → ISRG Root X1`.

Persistido en cada `/etc/letsencrypt/renewal/*.conf` bajo `[renewalparams]` para que la
renovación automática NO vuelva a ECDSA:
```ini
key_type = rsa
preferred_chain = ISRG Root X1
```

Estado por dominio (verificado con `grep -H -E "key_type|preferred_chain" /etc/letsencrypt/renewal/*.conf`
y `openssl s_client ... -showcerts`):

| Dominio | key_type | preferred_chain | Cadena servida | OK |
|---|---|---|---|---|
| api.omni.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ |
| almacen.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ |
| compras.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ |
| produccion.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ |
| notificaciones.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ |
| academy.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ |
| watchdog.josepan.app | rsa | ISRG Root X1 | → X1 | ✅ (ver §3.2) |
| **josepan.app** (apex + www) | **ecdsa** | **(falta)** | ECDSA/X2 | ⚠️ (ver §3.1) |

`certbot renew --dry-run` (2026-07-31): **los 8 dominios simulan renovación con éxito.**

---

## 3. Pendientes que hereda el hilo de infraestructura

### 3.1 Apex `josepan.app` — pendiente, sin urgencia
- Hoy **no sirve nada de cara al usuario**. En el mediano plazo será una **intranet que
  agrupe los accesos a todos los subsistemas**.
- Su `renewal/josepan.app.conf` sigue en `key_type = ecdsa` y **sin** `preferred_chain`.
  Cubre `josepan.app` y `www.josepan.app`.
- **Acción cuando se despliegue la intranet (o antes, por higiene):** reemitir en RSA+X1
  igual que el resto y persistir el flag:
  ```bash
  certbot certonly --cert-name josepan.app \
    --key-type rsa --preferred-chain "ISRG Root X1" \
    -a apache --force-renewal -d josepan.app -d www.josepan.app

  f=/etc/letsencrypt/renewal/josepan.app.conf
  grep -q "preferred_chain" "$f" || sed -i '/^\[renewalparams\]/a preferred_chain = ISRG Root X1' "$f"
  sed -i 's/^key_type = ecdsa/key_type = rsa/' "$f"
  ```

### 3.2 `watchdog.josepan.app` — verificar vhost al desplegar
- El subsistema [1006] Watchdog **está en proceso de despliegue**, aún no productivo.
- Durante el diagnóstico, un `openssl s_client` a `watchdog.josepan.app` devolvió Subject
  **`CN=academy.josepan.app`** en lugar de `watchdog`. Puede ser un desliz de copy/paste,
  **pero debe verificarse** que el vhost de watchdog no esté sirviendo el certificado de
  academy (revisar `ServerName` y `SSLCertificateFile` de ese vhost):
  ```bash
  echo | openssl s_client -connect watchdog.josepan.app:443 -servername watchdog.josepan.app 2>/dev/null | openssl x509 -noout -subject -issuer
  # Debe decir subject=CN=watchdog.josepan.app
  ```
  Si sirve el cert equivocado, corregir el vhost de Apache de watchdog y recargar.

### 3.3 Validación en campo del fix SSL — AÚN FALLA en al menos un dispositivo
- Tras el fix (RSA→ISRG Root X1), **un usuario probó y SIGUE viendo el error** (2026-07-31).
- Falta acotar la causa concreta con ese usuario. Árbol de decisión pendiente para el hilo
  de infraestructura:
  1. **Captura del aviso + código exacto**: si es `NET::ERR_CERT_AUTHORITY_INVALID` sigue
     siendo raíz/cadena; si es `NET::ERR_CERT_DATE_INVALID` → reloj del dispositivo;
     si es `ERR_CERT_COMMON_NAME_INVALID` → SAN/vhost.
  2. **URL/subdominio exacto** que tiene abierto: descartar que entre por el apex
     `josepan.app`/`www` (que sigue en ECDSA/X2, ver §3.1) en vez del subdominio corregido.
  3. **Caché/estado del navegador**: cerrar el navegador por completo y probar en incógnito;
     si en incógnito funciona → era caché/estado (limpiar). PWA/acceso directo guardado
     cachea aparte: borrar y recrear.
  4. **Reloj del dispositivo**: activar fecha/hora automáticas.
  5. **Verificar la cadena servida a ESE host** desde fuera:
     `echo | openssl s_client -connect <host>:443 -servername <host> -showcerts 2>/dev/null | grep -E "s:|i:" | head -6`
     (debe terminar en ISRG Root X1; si aún sale X2, el vhost no recargó → `systemctl reload apache2`).
  6. **Equipo demasiado antiguo**: hay dispositivos que **tampoco traen ISRG Root X1** en su
     almacén (Android muy viejo / sin actualizar). En esos, ni RSA+X1 basta: falta la raíz.
     Si tras limpiar caché, incógnito y reloj sigue fallando SOLO en ese equipo pero funciona
     en otros → equipo fuera de soporte de raíces (actualizar SO, instalar raíz manual, o
     asumir incompatibilidad de ese dispositivo).
- **Dato de contexto:** la app [1003] corre en `almacen.josepan.app` (ya en RSA→X1). Confirmar
  que el usuario accede por ese subdominio y no por un marcador antiguo del apex.

---

## 4. Alcance sugerido para el hilo de infraestructura

Este hilo debería encargarse, de forma continua, de:
- **Certificados TLS**: emisión/renovación, cadenas compatibles, monitoreo de caducidad,
  automatización (`certbot renew` vía cron/systemd-timer ya activo — confirmar).
- **Vhosts de Apache**: alta de subdominios nuevos (p. ej. [1005] Ágora TPV cuando llegue),
  `ServerName`, mapeo correcto de certificado por vhost, headers de seguridad (HSTS, etc.).
- **Salud del servidor**: espacio en disco, actualizaciones de Debian, backups, logs.
- **DNS**: registros de los subdominios, CAA si se decide fijarlo.
- **Coordinación con despliegues**: cuando un subsistema nuevo se publique, prepararle
  vhost + certificado RSA/X1 desde el inicio (no repetir el incidente de la cadena ECDSA).

### Comandos de referencia útiles

```bash
# Inventario de certificados
certbot certificates

# Config de renovación (key_type / preferred_chain por dominio)
grep -H -E "key_type|preferred_chain" /etc/letsencrypt/renewal/*.conf

# Cadena servida por un host (issuers de cada eslabón)
echo | openssl s_client -connect <host>:443 -servername <host> -showcerts 2>/dev/null | grep -E "s:|i:" | head -6

# Issuer + fechas de la hoja
echo | openssl s_client -connect <host>:443 -servername <host> 2>/dev/null | openssl x509 -noout -issuer -subject -dates

# Simular renovación de todos (no toca nada real)
certbot renew --dry-run

# Recargar Apache tras cambios de cert/vhost
systemctl reload apache2
```

### Nota sobre rate limits de Let's Encrypt
Cada reemisión con `--force-renewal` consume cupo (límite semanal por dominio registrado).
Reemitir solo lo necesario; usar `--dry-run` para validar config sin gastar cupo.

---

## 5. Convención de trabajo del ecosistema (para el nuevo hilo)

- Cada cambio que modifique archivos del proyecto se acompaña de una **descripción de
  commit** (convención del equipo).
- Ante un cambio que afecte a un subsistema, **avisar al hilo de ese subsistema**; el
  API CORE [1001] es la fuente de verdad y define contratos — los satélites se adaptan.
- Este documento vive en `docs/` y debe mantenerse actualizado a medida que se resuelvan
  los pendientes.

---
*Handoff generado desde el hilo de [1003]. Contacto/decisor: Herman Adrián Torres Marín
(Director de Tecnología y Transformación Digital, SuperAdministrador OMNI).*
