# Pendientes y bugs — [1003] Gestión de Almacenes y Mermas

_Registro vivo. Actualizar a medida que se resuelvan._

---

## 🔴 INFRAESTRUCTURA — Certificado SSL con cadena poco compatible

**Estado:** pendiente (no bloqueante para dispositivos modernos)
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
