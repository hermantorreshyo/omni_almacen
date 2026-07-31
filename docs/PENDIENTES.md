# Pendientes y bugs — [1003] Gestión de Almacenes y Mermas

_Registro vivo. Actualizar a medida que se resuelvan._

---

## 🟢 INFRAESTRUCTURA — Certificado SSL (RESUELTO 2026-07-31)

**Resolución:** Los 7 subdominios de las apps (api.omni, almacen, compras, produccion,
watchdog, notificaciones, academy) fueron reemitidos con certbot en **RSA anclado a
ISRG Root X1**. Cadena verificada: hoja → YR1/YR2 (RSA) → Root YR → **ISRG Root X1**.
Esto elimina el `NET::ERR_CERT_AUTHORITY_INVALID` en dispositivos antiguos.
Persistido en cada `renewal/*.conf`: `key_type = rsa` + `preferred_chain = ISRG Root X1`
(no volverá a ECDSA en renovaciones automáticas).

**Estado de cierre:**
- ✅ Los 7 subdominios de las apps sirven RSA→ISRG Root X1 y tienen el flag persistido.
- ✅ `certbot renew --dry-run` (2026-07-31): los 8 dominios simulan renovación con éxito.
- ⏳ Validación en campo en proceso (usuario afectado confirma que ya no ve el error).

**Traspasado a infraestructura (fuera del alcance de [1003]):** los siguientes puntos se
documentaron en `docs/INFRAESTRUCTURA_SERVIDOR_HANDOFF.md` para un hilo dedicado a
certificados/vhosts/servidor:
1. **Apex `josepan.app`** sigue en `ecdsa` sin `preferred_chain`. Hoy no sirve nada de cara
   al usuario; a mediano plazo será la intranet de accesos. Reemitir en RSA+X1 al desplegarla.
2. **`watchdog.josepan.app`** (subsistema [1006] en despliegue): verificar que su vhost no
   sirva el certificado de `academy` (apareció Subject `academy` en el diagnóstico).

---

## 🔴 (HISTÓRICO) INFRAESTRUCTURA — Certificado SSL con cadena poco compatible

**Estado:** DIAGNÓSTICO CONFIRMADO (2026-07-31) — pendiente de reemitir certificados.

**Confirmación (2026-07-31):**
- Gestor: certbot (`/usr/bin/certbot`), 7 dominios en `/etc/letsencrypt/renewal/`, todos Key Type ECDSA.
- Error real del usuario: `NET::ERR_CERT_AUTHORITY_INVALID` (raíz no confiable).
- Issuers verificados: api/almacen/compras/produccion/watchdog/academy → `CN=YE1`; notificaciones → `CN=YE2`. Todos anclan en `ISRG Root X2` (ECDSA).
- SSL Labs sobre almacen.josepan.app: "Trusted: Yes" en trust stores actualizados e incluye cross-sign X2←X1, SIN chain issues. ⇒ El fallo NO es cadena rota, sino dispositivos con almacén de confianza desactualizado que no traen ISRG Root X2 ni el cross-sign.

**Decisión:** Opción A — reemitir en RSA anclado a ISRG Root X1 (máxima compatibilidad con equipos viejos), en los 7 dominios, y persistir en renovación automática.

**Dominios a reemitir:** api.omni, almacen, compras, produccion, watchdog, notificaciones, academy (.josepan.app).

**Siguiente acción concreta:** revisar `cat /etc/letsencrypt/renewal/api.omni.josepan.app.conf` (authenticator apache/webroot y si fija key_type) antes de lanzar `certbot certonly --force-renewal --key-type rsa --preferred-chain "ISRG Root X1" -d <dominio>` por cada uno; luego persistir `key_type = rsa` y `preferred_chain = ISRG Root X1` en cada .conf, recargar Apache, verificar issuer (debe ser R10/R11/R13) y `certbot renew --dry-run`.

---
_Estado previo:_ pendiente (no bloqueante para dispositivos modernos)
**Síntoma:** algunos usuarios ven "conexión insegura" / aviso de certificado; en otros
dispositivos no ocurre. Patrón "en unos sí, en otros no".

**Causa raíz identificada (2026-07):**
Los certificados de los subdominios se emiten con Let's Encrypt anclando en la **raíz
ECDSA nueva `ISRG Root X2`** (intermedio `CN=YE1`). Esa raíz aún no está en los almacenes
de confianza de dispositivos/navegadores antiguos → fallan la validación. Los dispositivos
modernos la conocen y validan bien.

Diagnóstico ejecutado sobre `api.omni.josepan.app`:
- Cadena bien montada (hoja → YE1 → Root YE → ISRG Root X2). No es cadena incompleta.
- Issuer = `CN=YE1`, raíz `ISRG Root X2` (ECDSA nueva, baja penetración en equipos viejos).
- Fechas vigentes: notBefore Jun 7 2026 / notAfter Sep 5 2026.
- Nota: cada subdominio tiene su **propio** certificado (se vio `almacen.josepan.app`
  con la misma familia ECDSA). Hay que corregir TODOS los hosts, no solo uno.

**Solución propuesta (pendiente de aplicar):**
Reemitir anclando a la raíz RSA de máxima compatibilidad **`ISRG Root X1`**:

```bash
# Ver cadenas/estado
certbot certificates

# Reemitir con cadena compatible (por host o con renew global)
certbot certonly --preferred-chain "ISRG Root X1" -d api.omni.josepan.app --force-renewal
certbot renew --preferred-chain "ISRG Root X1" --force-renewal   # afecta a todos

# Verificar que el issuer cambió a RSA (R10/R11/R3), no YE1:
echo | openssl s_client -connect api.omni.josepan.app:443 -servername api.omni.josepan.app 2>/dev/null | openssl x509 -noout -issuer
```

Persistir el flag para las renovaciones automáticas en cada
`/etc/letsencrypt/renewal/*.conf` bajo `[renewalparams]`:
```ini
preferred_chain = ISRG Root X1
```

**Verificar todos los subdominios:**
```bash
for h in api.omni.josepan.app almacen.josepan.app compras.josepan.app; do
  echo "== $h =="
  echo | openssl s_client -connect $h:443 -servername $h 2>/dev/null | openssl x509 -noout -issuer
done
```
Y pasar cada host por https://www.ssllabs.com/ssltest/ confirmando "Trusted" en
Android/Windows antiguos y que la ruta ya no dependa de X2/YE1.

**Causas secundarias a descartar en usuarios concretos:**
- Reloj del dispositivo desajustado → activar fecha/hora automáticas.
- Equipos muy antiguos sin raíces actualizadas.
- Confirmar el código de error exacto del navegador:
  - `NET::ERR_CERT_AUTHORITY_INVALID` → raíz/cadena (encaja con X2).
  - `NET::ERR_CERT_DATE_INVALID` → fecha del equipo o caducidad.
  - `ERR_CERT_COMMON_NAME_INVALID` → SAN/nombre del subdominio.

**Datos por recabar de Herman:** gestor usado (certbot/acme.sh), salida del bucle `for h`
con el issuer de cada subdominio, y código de error exacto de un usuario afectado.

---

## Otros pendientes de producto

- **Notas del borrador (Solicitud):** el contrato del core no expone editar `notes` tras
  crear el BORRADOR. Hoy se capturan al crear. Si se requiere editarlas después, pedir
  endpoint (`PATCH /transfers/{id}` con `notes`) al API CORE.
- **Ítems recuperados de borrador fuera del filtro "Más usados":** se ven en el resumen,
  pero no como tarjeta si no están en FAV. Aceptable; revisar si molesta en uso real.
- **Pantalla `entregas` → rol Chofer Logístico:** asignarla desde el Gestor de Permisos.
- **[1005] Ágora TPV:** no iniciado.
