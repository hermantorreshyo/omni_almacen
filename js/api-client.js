/**
 * ═══════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1003] ALMACÉN Y MERMAS
 *  js/api-client.js — Cliente HTTP mismo-origen (v1.0)
 *
 *  El navegador SOLO habla con api/omni.php (mismo dominio). Ese proxy
 *  inyecta Authorization: Bearer y X-Interlocutor-Id contra el API CORE.
 *  El JWT vive en la cookie de sesión PHP (HttpOnly): no se toca en JS.
 *
 *  Expone ApiError tipada para que app.js y outbox-service.js reaccionen
 *  por TIPO de error, nunca por código HTTP crudo.
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const ApiClient = (() => {

  const BASE = 'api/omni.php';

  const ERR = Object.freeze({
    NETWORK:      'NETWORK',      // sin conexión → candidato a Outbox
    UNAUTHORIZED: 'UNAUTHORIZED', // 401
    RBAC:         'RBAC',         // 403
    VALIDATION:   'VALIDATION',   // 400/422 → PARADA DE EMERGENCIA del Outbox
    CONFLICT:     'CONFLICT',     // 409 lote/stock → PARADA DE EMERGENCIA
    SERVER:       'SERVER',       // 5xx
    UNKNOWN:      'UNKNOWN',
  });

  class ApiError extends Error {
    constructor(type, message, status = 0, code = null) {
      super(message);
      this.name = 'ApiError';
      this.type = type;
      this.status = status;
      this.code = code;
    }
    /** ¿Debe detener el Outbox y exigir intervención manual? */
    get isFatal() {
      return this.type === ERR.VALIDATION || this.type === ERR.CONFLICT;
    }
  }

  function _classify(status) {
    if (status === 401) return ERR.UNAUTHORIZED;
    if (status === 403) return ERR.RBAC;
    if (status === 409) return ERR.CONFLICT;
    if (status === 400 || status === 422) return ERR.VALIDATION;
    if (status >= 500) return ERR.SERVER;
    return ERR.UNKNOWN;
  }

  async function _request(action, { method = 'GET', body = null, query = {} } = {}) {
    const qs   = new URLSearchParams({ action, ...query }).toString();
    const url  = `${BASE}?${qs}`;
    const opts = { method, headers: { 'Accept': 'application/json' }, credentials: 'same-origin' };
    if (body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      throw new ApiError(ERR.NETWORK, 'Sin conexión con el servidor de almacén.', 0);
    }

    let data = {};
    try { data = await res.json(); } catch (_) { /* respuesta no-JSON */ }

    if (!res.ok || data.ok === false) {
      const type = _classify(res.status);
      if (type === ERR.UNAUTHORIZED) {
        try { window.dispatchEvent(new CustomEvent('omni:session-expired')); } catch (_) {}
      }
      throw new ApiError(
        type,
        data.error || `Error HTTP ${res.status}`,
        res.status,
        data.code || null,
      );
    }
    return data;
  }

  return {
    ERR, ApiError,

    /* ── Autenticación ── */
    login:   (usuario, password) => _request('login',   { method: 'POST', body: { usuario, password } }),
    session: ()                  => _request('session'),
    logout:  ()                  => _request('logout',  { method: 'POST' }),

    /* ── Catálogo ── */
    catalog: (resource, params = {}) => _request('catalog', { query: { resource, ...params } }),
    loginSede: (usuario, password, interlocutor_id) =>
      _request('login_sede', { method: 'POST', body: { usuario, password, interlocutor_id } }),
    stock:   (params = {})           => _request('stock',   { query: params }),
    batches: (params = {})           => _request('batches', { query: params }),

    /* ── Flujo 1: Recepción ── */
    ocPendientes: (params = {}) => _request('oc_pendientes', { query: params }),
    ocDetalle:    (id)          => _request('oc_detalle', { query: { id } }),
    reception:    (payload)     => _request('reception', { method: 'POST', body: payload }),
    ocRecibir:    (id, details) => _request('oc_recibir', { method: 'POST', body: { id, details } }),

    /* ── Flujo 2: Ubicación QR ── */
    ubicar: (payload) => _request('ubicar', { method: 'POST', body: payload }),

    /* ── Flujo 3: Traspaso externo ── */
    traspasos:          (estado)  => _request('traspasos_listar', { query: estado ? { estado } : {} }),
    traspasoSolicitar:  (payload) => _request('traspaso_solicitar',  { method: 'POST', body: payload }),
    pickingIniciar:     (payload) => _request('picking_iniciar',     { method: 'POST', body: payload }),
    pickingAlistar:     (payload) => _request('picking_alistar',     { method: 'POST', body: payload }),
    transporteRuta:     (payload) => _request('transporte_ruta',     { method: 'POST', body: payload }),
    transporteEntregar: (payload) => _request('transporte_entregar', { method: 'POST', body: payload }),
    traspasoCerrar:     (payload) => _request('traspaso_cerrar',     { method: 'POST', body: payload }),

    /* ── Flujo 4: Mermas ── */
    merma: (payload) => _request('merma', { method: 'POST', body: payload }),

    /* ── Pantallas visibles / Gestor de permisos ── */
    misPantallas: ()      => _request('mis_pantallas'),
    rolesListar:  ()      => _request('roles_listar'),
    screensListar:()      => _request('screens_listar'),
    permsListar:  ()      => _request('perms_listar'),
    permsGuardar: (permissions) => _request('perms_guardar', { method: 'POST', body: { permissions } }),

    /** Reenvío genérico por acción (lo usa el Outbox). */
    replay: (action, payload) => _request(action, { method: 'POST', body: payload }),
  };
})();
