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


## 🟡 Orden de áreas en RECEPCIÓN DE MERCANCÍA y UBICACIÓN POR QR — PENDIENTE
El orden de recorrido por área (`area_pick_sequence`), que ya se usa en el picking,
debe aplicarse también a los módulos **Recepción de Mercancía** y **Ubicación por QR**,
donde se acomoda la mercancía recién llegada en sus ubicaciones. Objetivo: que el
operario ubique la mercancía siguiendo el mismo orden físico del almacén que en el picking.
Pendiente de diseñar cómo se integra el área/su orden en esos dos flujos (hoy Ubicación por
QR trabaja por ubicación/estantería, no por área). Levantar REQ a [1001] si se necesita que
esos endpoints expongan `area_id`/`area_name`/`area_pick_sequence` por ítem/ubicación.


## 🟡 Ventana de corte de pedidos — fase B (corte real) PENDIENTE en 1001
Implementado en [1003] (opción A, solo vista): los pedidos se agrupan en picking por
**tienda + ventana de corte** (franja de HH:00 a HH:00 del día siguiente, hora de Madrid),
usando la **fecha de creación** del pedido. Hora de corte por defecto 12:00.

Pendiente de 1001:
1. **Hora de corte configurable** en la config del sistema (REQ_HORA_CORTE_PEDIDOS.md).
   [1003] ya la consume de forma tolerante vía `GET /config?key=pedidos.cutoff_hour`;
   falta que el core la exponga. Definir si es global o por sede, y confirmar zona horaria.
2. **Corte "duro" (fase B, a decidir con negocio):** que el sistema aplique el corte a
   nivel de datos — marcar cada pedido con su ventana/fecha de despacho, cerrar la franja
   a la hora exacta, o mover automáticamente los pedidos al siguiente corte. Hoy [1003]
   solo agrupa visualmente; si se prioriza el corte real, levantar REQ para el campo en el
   traspaso y la lógica asociada.

