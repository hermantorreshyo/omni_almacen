#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  JOSEPAN 360 · OMNI · [1003] GESTIÓN DE ALMACENES Y MERMAS
#  setup.sh — Despliegue plug&play. Idempotente: se puede ejecutar varias veces.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

echo "▶ [1003] Almacén — configuración"

# 1) .env desde plantilla (no sobreescribe uno existente)
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  ✔ .env creado desde .env.example (ajusta OMNI_API_HOST si procede)"
else
  echo "  • .env ya existe — se conserva"
fi

# 2) Requisitos PHP
if ! command -v php >/dev/null 2>&1; then
  echo "  ✖ PHP no encontrado. Instala PHP 8.1+ con la extensión cURL." >&2
  exit 1
fi
PHP_VER=$(php -r 'echo PHP_VERSION;')
echo "  ✔ PHP $PHP_VER detectado"
if ! php -m | grep -qi '^curl$'; then
  echo "  ✖ Falta la extensión php-curl (apt install php-curl)." >&2
  exit 1
fi
echo "  ✔ extensión cURL activa"

# 3) Permisos: solo lectura de la app por el servidor web
chmod 640 .env 2>/dev/null || true

echo "✓ Listo. Apunta el VirtualHost de Apache a esta carpeta (DocumentRoot) y recarga."
echo "  Reglas: usa el .htaccess incluido (RewriteBase /)."
