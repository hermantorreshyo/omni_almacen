<?php
declare(strict_types=1);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1003] GESTIÓN DE ALMACENES Y MERMAS
 *  api/omni.php — Proxy ÚNICO mismo-origen hacia el API CORE v6 [1001]
 *
 *  El navegador SOLO habla con este archivo (mismo dominio) → PHP hace las
 *  llamadas cURL al API CORE mediante OmniCoreClient.php → CERO CORS.
 *  Enrutado por ?action=<verbo>. RBAC reforzado en servidor por acción.
 *
 *  Las RUTAS UPSTREAM están centralizadas abajo (array $UP). Valídalas contra
 *  tu colección Postman real del API CORE v6 antes de producción.
 * ═══════════════════════════════════════════════════════════════════════════
 */

require_once __DIR__ . '/OmniCoreClient.php';

session_start([
    'cookie_httponly' => true,
    'cookie_samesite' => 'Strict',
]);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

/* ── Configuración de entorno (.env) ────────────────────────────────────── */
function env(string $k, string $default = ''): string
{
    static $cache = null;
    if ($cache === null) {
        $cache = [];
        $path  = __DIR__ . '/../.env';
        if (is_file($path)) {
            foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                if ($line === '' || $line[0] === '#') continue;
                [$key, $val] = array_pad(explode('=', $line, 2), 2, '');
                $cache[trim($key)] = trim($val);
            }
        }
    }
    return $cache[$k] ?? (getenv($k) ?: $default);
}

$API_HOST   = env('OMNI_API_HOST', 'https://api.omni.josepan.app');
$API_PREFIX = env('OMNI_API_PREFIX', '/api/v1');

/* ── Mapa de rutas UPSTREAM (validar contra Postman real) ───────────────── */
$UP = [
    /* ── Operativo (validado contra colección Postman v6) ── */
    'catalog_skus'         => '/catalog/skus',
    'catalog_locations'    => '/catalog/locations',
    'catalog_interlocutors'=> '/catalog/interlocutors',
    'catalog_employees'    => '/catalog/employees',
    'catalog_categories'   => '/catalog/categories',
    'catalog_families'     => '/catalog/families',
    'routes'               => '/logistics/routes',
    'route_update'         => '/logistics/routes/%d',                 // PUT dispatch_time + status
    'route_detail'         => '/logistics/routes/%d',                 // GET route + transfers
    'drivers'              => '/logistics/drivers',                   // GET conductores (rol Repartidor)
    'vehicles'             => '/logistics/vehicles',                  // GET vehículos
    'stock'                => '/inventory/stock',
    'batches'              => '/inventory/batches',      // GET lotes activos (FEFO)
    'reception'            => '/inventory/reception',    // POST atómico (movement_type:"Compra")
    'oc_list'              => '/purchasing/orders',       // GET listar OC
    'oc_detail'            => '/purchasing/orders/%d',     // GET detalle con líneas
    'oc_receive'           => '/purchasing/orders/%d/receive', // PUT marcar recibida/almacenada
    'transfer'             => '/inventory/transfer',     // POST atómico (Traslado Interno/Externo)
    'scrap'                => '/inventory/scrap',         // POST merma con evidencia
    /* Workflow de traspaso externo — PENDIENTE de publicación en API CORE
       (ver REQ_TRANSFER_WORKFLOW_1003.md). Rutas ya alineadas al contrato. */
    'transfers'            => '/inventory/transfers',                 // POST crear / GET ?state=
    'transfer_detail'      => '/inventory/transfers/%d',              // GET detalle con items
    'transfer_picking'     => '/inventory/transfers/%d/picking',      // PUT
    'transfer_dispatch'    => '/inventory/transfers/%d/dispatch',     // PUT
    'transfer_route'       => '/inventory/transfers/%d/route',        // PUT (legacy)
    'transfer_assign_route'=> '/inventory/transfers/%d/assign-route', // PUT asignar a ruta logística
    'transfer_deliver'     => '/inventory/transfers/%d/deliver',      // PUT
    'transfer_send'        => '/inventory/transfers/%d/send',         // PUT despacho directo (sin ruta) → PENDIENTE_RECEPCION
    'transfer_close'       => '/inventory/transfers/%d/close',        // PUT
    'roles'            => '/rbac/roles',                        // GET roles operativos
    'perms_1003'       => '/rbac/subsystems/1003/screen-permissions', // GET / PUT mapa de pantallas
    'screens_catalog'  => '/rbac/subsystems/1003/screens',      // GET pantallas registradas (catálogo SSOT)
    'my_screens'       => '/rbac/subsystems/1003/my-screens',   // GET pantallas del usuario actual
    'system_params'    => '/system/params',                       // GET parámetros de implantación
];

/* ── Matriz RBAC por acción (defensa en servidor) ───────────────────────── */
$RBAC = [
    'recepcion'           => ['Encargado de Almacén', 'Personal de Picking'],
    'ubicar'              => ['Encargado de Almacén', 'Personal de Picking'],
    'merma'               => ['Encargado de Almacén', 'Encargado de Tienda', 'Personal de Picking'],
    'traspaso_solicitar'  => ['Encargado de Tienda', 'Director de Suministros'],
    'picking_iniciar'     => ['Personal de Picking', 'Encargado de Almacén'],
    'picking_alistar'     => ['Personal de Picking', 'Encargado de Almacén'],
    'transporte_ruta'     => ['Transportista'],
    'transporte_entregar' => ['Transportista'],
    'traspaso_cerrar'     => ['Encargado de Tienda'],
];

/* ── Helpers de respuesta ───────────────────────────────────────────────── */
function out(array $payload, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}
function fail(string $code, string $msg, int $http = 400): void
{
    out(['ok' => false, 'code' => $code, 'error' => $msg], $http);
}
function bodyJson(): array
{
    $raw = file_get_contents('php://input');
    $d   = json_decode($raw ?: '[]', true);
    return is_array($d) ? $d : [];
}

/* ── Cliente con contexto de sesión ─────────────────────────────────────── */
function sanitizeUser($user): array
{
    if (!is_array($user)) return [];
    unset($user['token'], $user['access_token'], $user['jwt'], $user['password']);
    return $user;
}
function client(): OmniCoreClient
{
    global $API_HOST, $API_PREFIX;
    $c = new OmniCoreClient($API_HOST, $API_PREFIX);
    if (!empty($_SESSION['omni_token']))        $c->setToken($_SESSION['omni_token']);
    if (isset($_SESSION['omni_interlocutor']))  $c->setInterlocutor($_SESSION['omni_interlocutor']);
    return $c;
}

/* ── Guardas auth + RBAC ────────────────────────────────────────────────── */
function requireAuth(): array
{
    if (empty($_SESSION['omni_token']) || empty($_SESSION['omni_user'])) {
        fail('ERR_AUTH', 'Sesión no autenticada.', 401);
    }
    return $_SESSION['omni_user'];
}
function isSuperAdmin(string $rol): bool
{
    $r = strtolower(preg_replace('/[\s_-]/', '', $rol));
    return strpos($r, 'superadmin') !== false;
}
function requireRole(string $action): array
{
    global $RBAC;
    $user  = requireAuth();
    $roles = $RBAC[$action] ?? [];
    $rol   = $user['rol'] ?? $user['role'] ?? '';
    if (!isSuperAdmin($rol) && !in_array($rol, $roles, true)) {
        fail('ERR_RBAC', 'Acceso denegado por rol para esta operación.', 403);
    }
    return $user;
}
function requireSuperAdmin(): array
{
    $user = requireAuth();
    $rol  = $user['rol'] ?? $user['role'] ?? '';
    if (!isSuperAdmin($rol)) {
        fail('ERR_RBAC', 'Solo el SuperAdmin puede gestionar permisos.', 403);
    }
    return $user;
}

/* ── Helper de despacho upstream uniforme ───────────────────────────────── */
function relay(array $res): void
{
    out(
        ['ok' => $res['ok'], 'data' => $res['data'], 'error' => $res['error'] ?? null, 'code' => $res['code'] ?? $res['error'] ?? null],
        $res['ok'] ? 200 : ($res['status'] ?: 502)
    );
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTER
═══════════════════════════════════════════════════════════════════════════ */
$action = $_GET['action'] ?? '';

switch ($action) {

    /* ── AUTENTICACIÓN ──────────────────────────────────────────────────── */
    /* FASE 1: valida credenciales (interlocutor provisional) y lista sedes.
       El rol definitivo del JWT se obtiene en la FASE 2 al re-autenticar con
       la sede elegida (API CORE v6.8 fija el rol según el interlocutor_id). */
    case 'login': {
        $in  = bodyJson();
        $c   = client();
        $res = $c->login([
            'usuario'         => $in['usuario'] ?? $in['username'] ?? '',
            'password'        => $in['password'] ?? '',
            'interlocutor_id' => $in['interlocutor_id'] ?? 1,
        ]);
        if (!$res['ok']) fail('ERR_LOGIN', $res['error'] ?? 'Credenciales inválidas.', 401);

        $token = $res['data']['token'] ?? $res['data']['access_token'] ?? null;
        if (!$token) fail('ERR_LOGIN', 'El API no devolvió token.', 502);
        $_SESSION['omni_token'] = $token;
        $c->setToken($token);

        $user = $res['data']['user'] ?? $res['data'] ?? [];
        $_SESSION['omni_user'] = sanitizeUser($user);
        $_SESSION['omni_interlocutor'] = $user['interlocutor_id'] ?? ($in['interlocutor_id'] ?? 1);
        unset($_SESSION['omni_committed']);                  // aún no confirmada la sede

        $intc = $c->request('GET', $UP['catalog_interlocutors'], null, true);
        $interlocutors = $intc['ok'] ? (is_array($intc['data']) ? $intc['data'] : []) : [];

        out(['ok' => true, 'data' => [
            'user'          => sanitizeUser($user),
            'interlocutors' => $interlocutors,
            'needs_interlocutor' => true,
        ]]);
    }

    /* FASE 2: re-autentica con la sede elegida → JWT con el rol de ESA sede. */
    case 'login_sede': {
        $in  = bodyJson();
        $id  = (int) ($in['interlocutor_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'interlocutor_id inválido.', 422);
        $c   = client();
        $res = $c->login([
            'usuario'         => $in['usuario'] ?? $in['username'] ?? '',
            'password'        => $in['password'] ?? '',
            'interlocutor_id' => $id,
        ]);
        if (!$res['ok']) fail('ERR_LOGIN', $res['error'] ?? 'Credenciales inválidas.', 401);

        $token = $res['data']['token'] ?? $res['data']['access_token'] ?? null;
        if (!$token) fail('ERR_LOGIN', 'El API no devolvió token.', 502);
        $_SESSION['omni_token'] = $token;
        $c->setToken($token);

        $user = $res['data']['user'] ?? $res['data'] ?? [];
        $_SESSION['omni_user'] = sanitizeUser($user);
        $_SESSION['omni_interlocutor'] = $id;
        $_SESSION['omni_committed']    = true;

        out(['ok' => true, 'data' => [
            'user'            => sanitizeUser($user),
            'rol'             => $user['rol'] ?? $user['role'] ?? null,
            'interlocutor_id' => $id,
            'interlocutor_name' => $user['interlocutor_name'] ?? null,
        ]]);
    }

    case 'session': {
        if (empty($_SESSION['omni_user']) || empty($_SESSION['omni_committed'])) out(['ok' => false, 'data' => null]);
        out(['ok' => true, 'data' => [
            'user'            => $_SESSION['omni_user'],
            'rol'             => $_SESSION['omni_user']['rol'] ?? $_SESSION['omni_user']['role'] ?? null,
            'interlocutor_id' => $_SESSION['omni_interlocutor'] ?? null,
            'interlocutor_name' => $_SESSION['omni_user']['interlocutor_name'] ?? null,
            'interlocutor_set'=> true,
        ]]);
    }

    case 'logout': {
        $_SESSION = [];
        session_destroy();
        out(['ok' => true]);
    }

    /* ── CATÁLOGO (lectura) ─────────────────────────────────────────────── */
    case 'catalog': {
        requireAuth();
        $resource = preg_replace('/[^a-z_]/', '', strtolower($_GET['resource'] ?? ''));
        $MAP = [
            'skus'          => 'catalog_skus',
            'locations'     => 'catalog_locations',
            'interlocutors' => 'catalog_interlocutors',
            'employees'     => 'catalog_employees',
            'categories'    => 'catalog_categories',
            'families'      => 'catalog_families',
            'rutas'         => 'routes',   // alias front
            'routes'        => 'routes',   // las rutas viven en /logistics/routes
        ];
        if (!isset($MAP[$resource])) fail('ERR_PARAM', 'Recurso de catálogo no soportado.', 422);
        $qs = $_GET; unset($qs['action'], $qs['resource']);
        $path = $UP[$MAP[$resource]] . ($qs ? '?' . http_build_query($qs) : '');
        relay(client()->request('GET', $path, null, true));
    }

    case 'stock': {
        requireAuth();
        $qs = $_GET; unset($qs['action']);
        relay(client()->request('GET', $UP['stock'] . ($qs ? '?' . http_build_query($qs) : ''), null, true));
    }

    case 'batches': {
        requireAuth();
        $qs = $_GET; unset($qs['action']);
        relay(client()->request('GET', $UP['batches'] . ($qs ? '?' . http_build_query($qs) : ''), null, true));
    }
    case 'batch_crear': {
        requireAuth();
        relay(client()->request('POST', $UP['batches'], json_encode(bodyJson(), JSON_UNESCAPED_UNICODE), true));
    }

    /* ── FLUJO 1: RECEPCIÓN CONTRA OC/ALBARÁN (de [1002]) ───────────────── */
    case 'oc_pendientes': {
        requireAuth();
        $qs = $_GET; unset($qs['action']);
        relay(client()->request('GET', $UP['oc_list'] . ($qs ? '?' . http_build_query($qs) : ''), null, true));
    }
    case 'oc_detalle': {
        requireAuth();
        $id = (int) ($_GET['id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'id de OC inválido.', 422);
        relay(client()->request('GET', sprintf($UP['oc_detail'], $id), null, true));
    }
    case 'reception': {
        requireAuth();
        $in = bodyJson();
        $in['movement_type'] = $in['movement_type'] ?? 'Compra';
        relay(client()->request('POST', $UP['reception'], json_encode($in, JSON_UNESCAPED_UNICODE), true));
    }
    case 'oc_recibir': {
        requireAuth();
        $in = bodyJson(); $id = (int) ($in['id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'id de OC inválido.', 422);
        relay(client()->request('PUT', sprintf($UP['oc_receive'], $id),
            json_encode(['details' => $in['details'] ?? []], JSON_UNESCAPED_UNICODE), true));
    }

    /* ── FLUJO 2: UBICACIÓN = Traslado Interno atómico ──────────────────── */
    case 'ubicar': {
        requireAuth();
        $in = bodyJson();
        $in['movement_type'] = 'Traslado Interno';
        relay(client()->request('POST', $UP['transfer'], json_encode($in, JSON_UNESCAPED_UNICODE), true));
    }

    /* ── FLUJO 3: TRASPASO EXTERNO (workflow multi-estado) ──────────────── */
    /* Endpoints pendientes de publicación en API CORE (REQ_TRANSFER_WORKFLOW_1003).
       El proxy ya está alineado al contrato: al existir las rutas, opera directo. */
    case 'traspasos_listar': {
        requireAuth();
        $qs = [];
        $state = preg_replace('/[^A-Z_]/', '', strtoupper($_GET['estado'] ?? $_GET['state'] ?? ''));
        if ($state) $qs['state'] = $state;
        if (!empty($_GET['driver']))          $qs['driver'] = preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['driver']);
        if (!empty($_GET['interlocutor_id'])) $qs['interlocutor_id'] = (int) $_GET['interlocutor_id'];
        relay(client()->request('GET', $UP['transfers'] . ($qs ? '?' . http_build_query($qs) : ''), null, true));
    }
    case 'traspaso_detalle': {
        requireAuth();
        $id = (int) ($_GET['id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'id de traspaso inválido.', 422);
        relay(client()->request('GET', sprintf($UP['transfer_detail'], $id), null, true));
    }
    case 'traspaso_solicitar': {
        requireAuth();
        relay(client()->request('POST', $UP['transfers'], json_encode(bodyJson(), JSON_UNESCAPED_UNICODE), true));
    }
    case 'picking_iniciar': {
        requireAuth();
        $id = (int) (bodyJson()['traspaso_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'traspaso_id inválido.', 422);
        relay(client()->request('PUT', sprintf($UP['transfer_picking'], $id), '{}', true));
    }
    case 'picking_alistar': {
        requireAuth();
        $in = bodyJson(); $id = (int) ($in['traspaso_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'traspaso_id inválido.', 422);
        $body = ['items' => $in['items'] ?? []];
        if (!empty($in['notes'])) $body['notes'] = $in['notes'];
        relay(client()->request('PUT', sprintf($UP['transfer_dispatch'], $id), json_encode($body, JSON_UNESCAPED_UNICODE), true));
    }
    case 'rutas_activas': {
        requireAuth();
        $qs = [];
        $status = preg_replace('/[^a-z_]/', '', strtolower($_GET['status'] ?? ''));
        if ($status) $qs['status'] = $status;
        if (!empty($_GET['driver'])) $qs['driver'] = preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['driver']);
        relay(client()->request('GET', $UP['routes'] . ($qs ? '?' . http_build_query($qs) : ''), null, true));
    }
    case 'conductores': {
        requireAuth();
        relay(client()->request('GET', $UP['drivers'], null, true));
    }
    case 'vehiculos': {
        requireAuth();
        relay(client()->request('GET', $UP['vehicles'], null, true));
    }
    case 'ruta_detalle': {
        requireAuth();
        $id = (int) ($_GET['id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'id de ruta inválido.', 422);
        relay(client()->request('GET', sprintf($UP['route_detail'], $id), null, true));
    }
    case 'ruta_actualizar': {
        requireAuth();
        $in = bodyJson(); $id = (int) ($in['route_id'] ?? $in['id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'route_id inválido.', 422);
        $body = [];
        if (!empty($in['dispatch_time'])) $body['dispatch_time'] = $in['dispatch_time'];
        if (!empty($in['status']))        $body['status'] = $in['status'];
        relay(client()->request('PUT', sprintf($UP['route_update'], $id),
            json_encode($body ?: new stdClass(), JSON_UNESCAPED_UNICODE), true));
    }
    case 'traspaso_asignar_ruta': {
        requireAuth();
        $in = bodyJson(); $id = (int) ($in['traspaso_id'] ?? 0);
        $ruta = (int) ($in['logistic_route_id'] ?? $in['ruta_id'] ?? 0);
        if ($id <= 0 || $ruta <= 0) fail('ERR_PARAM', 'traspaso_id y logistic_route_id son obligatorios.', 422);
        relay(client()->request('PUT', sprintf($UP['transfer_assign_route'], $id),
            json_encode(['logistic_route_id' => $ruta], JSON_UNESCAPED_UNICODE), true));
    }
    case 'transporte_ruta': {
        requireAuth();
        $in = bodyJson(); $id = (int) ($in['traspaso_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'traspaso_id inválido.', 422);
        relay(client()->request('PUT', sprintf($UP['transfer_route'], $id), json_encode(['route_id' => $in['ruta_id'] ?? $in['route_id'] ?? null], JSON_UNESCAPED_UNICODE), true));
    }
    case 'transporte_entregar': {
        requireAuth();
        $id = (int) (bodyJson()['traspaso_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'traspaso_id inválido.', 422);
        relay(client()->request('PUT', sprintf($UP['transfer_deliver'], $id), '{}', true));
    }
    case 'traspaso_enviar': {
        requireAuth();
        $id = (int) (bodyJson()['traspaso_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'traspaso_id inválido.', 422);
        relay(client()->request('PUT', sprintf($UP['transfer_send'], $id), '{}', true));
    }
    case 'traspaso_cerrar': {
        requireAuth();
        $in = bodyJson(); $id = (int) ($in['traspaso_id'] ?? 0);
        if ($id <= 0) fail('ERR_PARAM', 'traspaso_id inválido.', 422);
        $body = [];
        if (isset($in['items']))          $body['items'] = $in['items'];
        if (isset($in['reception_date'])) $body['reception_date'] = $in['reception_date'];
        if (isset($in['notes']))          $body['notes'] = $in['notes'];
        relay(client()->request('PUT', sprintf($UP['transfer_close'], $id),
            json_encode($body ?: new stdClass(), JSON_UNESCAPED_UNICODE), true));
    }

    /* ── FLUJO 4: MERMAS (POST /inventory/scrap con evidencia) ──────────── */
    case 'merma': {
        requireAuth();
        $in = bodyJson();
        $u  = $_SESSION['omni_user'] ?? [];
        if (empty($in['responsible_user_id'])) {
            $uid = $u['user_id'] ?? $u['id'] ?? null;
            if ($uid) $in['responsible_user_id'] = (int) $uid;
        }
        relay(client()->request('POST', $UP['scrap'], json_encode($in, JSON_UNESCAPED_UNICODE), true));
    }

    /* ── PANTALLAS VISIBLES PARA EL USUARIO ACTUAL ──────────────────────── */
    /* Endpoint nativo del API CORE v6: resuelve SuperAdmin → '*' y filtra por
       rol para el resto. Disponible para cualquier usuario autenticado. */
    case 'mis_pantallas': {
        requireAuth();
        relay(client()->request('GET', $UP['my_screens'], null, true));
    }
    case 'system_params': {
        requireAuth();
        relay(client()->request('GET', $UP['system_params'], null, true));
    }

    /* ── GESTOR DE PERMISOS (solo SuperAdmin) ───────────────────────────── */
    case 'roles_listar': {
        requireSuperAdmin();
        relay(client()->request('GET', $UP['roles'] . '?ambito=operativo', null, true));
    }
    case 'screens_listar': {
        requireSuperAdmin();
        relay(client()->request('GET', $UP['screens_catalog'], null, true));
    }
    case 'perms_listar': {
        requireSuperAdmin();
        relay(client()->request('GET', $UP['perms_1003'], null, true));
    }
    case 'perms_guardar': {
        requireSuperAdmin();
        $in = bodyJson();
        if (empty($in['permissions']) || !is_array($in['permissions'])) {
            fail('ERR_PARAM', 'Falta el mapa de permisos.', 422);
        }
        relay(client()->request('PUT', $UP['perms_1003'], json_encode([
            'permissions' => $in['permissions'],
        ], JSON_UNESCAPED_UNICODE), true));
    }

    default:
        fail('ERR_ACTION', 'Acción no reconocida: ' . htmlspecialchars($action), 404);
}
