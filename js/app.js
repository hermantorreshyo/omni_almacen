/**
 * ═══════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1003] ALMACÉN Y MERMAS
 *  js/app.js — Núcleo lógico (Vanilla ES6+, async/await)
 *
 *  Gobierna: ciclo de vida de vistas, RBAC perimetral en cliente,
 *  teclado numérico sobredimensionado, los 4 flujos operativos, captura
 *  QR / fotográfica nativa, indicador offline y parada de emergencia.
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const App = (() => {

  /* ── Estado ───────────────────────────────────────────────────── */
  const state = {
    user: null,
    rol: null,
    interlocutor: null,
    catalogs: { interlocutors: [], locations: [], skus: [], batches: [], rutas: [] },
    screens: null,      // '*' (SuperAdmin) | array de claves | null (usar defaults)
    ctx: {},            // contexto efímero del flujo en curso
  };

  /* Pantallas accesibles por rol (RBAC perimetral; el servidor revalida). */
  const ROLE_TILES = {
    'Encargado de Almacén': ['recepcion', 'ubicar', 'picking', 'merma'],
    'Personal de Picking':  ['recepcion', 'ubicar', 'picking', 'merma'],
    'Transportista':        ['transporte'],
    'Encargado de Tienda':  ['solicitar', 'recibir', 'merma'],
    'Director de Suministros': ['solicitar'],
    'SuperAdmin': ['recepcion', 'ubicar', 'picking', 'transporte', 'solicitar', 'recibir', 'merma'],
  };

  /* ── Utilidades UI ────────────────────────────────────────────── */
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const el = (id) => document.getElementById(id);

  function view(id) {
    $$('.view').forEach((v) => v.classList.add('hidden'));
    const target = el(id);
    if (target) target.classList.remove('hidden');
    window.scrollTo(0, 0);
  }

  function toast(msg, type = 'ok') {
    const t = el('toast');
    t.textContent = msg;
    t.dataset.type = type;          // ok | warn | err
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  function logError(scope, e) {
    // Logging de cliente para auditoría de soporte.
    console.error(`[1003][${scope}]`, e?.message || e, e);
  }

  /* ── Teclado numérico sobredimensionado ───────────────────────── */
  function bindNumpad(input) {
    input.readOnly = true;
    input.addEventListener('click', () => openNumpad(input));
  }
  function openNumpad(input) {
    const pad = el('numpad');
    let buf = String(input.value || '');
    const disp = el('numpad-display');
    disp.textContent = buf || '0';
    pad.dataset.target = input.id;
    pad.classList.remove('hidden');

    pad.onclick = (ev) => {
      const k = ev.target.closest('[data-k]');
      if (!k) return;
      const key = k.dataset.k;
      if (key === 'ok')      { input.value = buf; input.dispatchEvent(new Event('input')); pad.classList.add('hidden'); }
      else if (key === 'del') buf = buf.slice(0, -1);
      else if (key === 'c')   buf = '';
      else if (key === '.')   { if (!buf.includes('.')) buf += '.'; }
      else                    buf += key;
      disp.textContent = buf || '0';
    };
  }

  /* ── Arranque ─────────────────────────────────────────────────── */
  async function boot() {
    el('year').textContent = new Date().getFullYear();
    refreshOfflineBadge();
    wireOutboxEvents();
    wireLogin();
    window.addEventListener('omni:session-expired', onSessionExpired);

    try {
      const s = await ApiClient.session();
      if (s.ok && s.data) {                       // sesión ya confirmada con sede (rol correcto)
        setIdentity(s.data);
        state.interlocutor = s.data.interlocutor_id ?? null;
        state.interlocutorName = s.data.interlocutor_name ?? null;
        await finishAuth(); return;
      }
    } catch (e) { logError('boot/session', e); }
    view('view-login');
  }

  /* ── Login ────────────────────────────────────────────────────── */
  function wireLogin() {
    const u = el('login-user'), p = el('login-pass'), btn = el('login-btn');
    u.addEventListener('keydown', (e) => { if (e.key === 'Enter') p.focus(); });
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
    btn.addEventListener('click', doLogin);
    el('intc-confirm').addEventListener('click', () => confirmInterlocutor().catch(() => {}));
  }
  async function doLogin() {
    const usuario  = el('login-user').value.trim();
    const password = el('login-pass').value;
    if (!usuario || !password) { toast('Introduce usuario y contraseña.', 'warn'); return; }
    setBusy('login-btn', true);
    try {
      const r = await ApiClient.login(usuario, password);
      setIdentity(r.data);
      state._creds = { usuario, password };          // se usan en la fase 2 (re-login por sede)
      promptInterlocutor(rowsOf(r.data.interlocutors));
    } catch (e) {
      logError('login', e);
      toast(e.message || 'No se pudo iniciar sesión.', 'err');
    } finally {
      setBusy('login-btn', false);
    }
  }

  function setIdentity(data) {
    state.user = data.user || {};
    state.rol  = data.rol || state.user.rol || state.user.role || null;
  }

  /* Token expirado (8 h) o no autorizado → volver al login. */
  let _expiring = false;
  function onSessionExpired() {
    if (_expiring) return;
    _expiring = true;
    el('app-header').classList.add('hidden');
    closeDrawer();
    state.user = null; state.rol = null; state.screens = null;
    view('view-login');
    toast('Tu sesión expiró. Vuelve a entrar.', 'warn');
    setTimeout(() => { _expiring = false; }, 1500);
  }

  /* Fase 2: elegir tienda / interlocutor de trabajo. */
  function promptInterlocutor(list) {
    const sel = el('intc-select');
    const rows = list || [];
    sel.innerHTML = '';
    sel.add(new Option('Selecciona tu tienda o bodega…', ''));
    rows.forEach((b) => sel.add(new Option(
      b.commercial_name || b.fiscal_name || b.name || b.nombre || ('Interlocutor ' + b.id), b.id)));
    // Si solo hay uno, autoselección.
    if (rows.length === 1) sel.value = String(rows[0].id);
    view('view-interlocutor');
  }
  async function confirmInterlocutor() {
    const sel = el('intc-select');
    const id = Number(sel.value);
    if (!id) { toast('Selecciona dónde estás trabajando.', 'warn'); return; }
    if (!state._creds) { toast('Vuelve a iniciar sesión.', 'warn'); view('view-login'); return; }
    setBusy('intc-confirm', true);
    try {
      // Re-login con la sede elegida → JWT con el rol de ESA sede (API CORE v6.8).
      const r = await ApiClient.loginSede(state._creds.usuario, state._creds.password, id);
      setIdentity(r.data);
      state.interlocutor = id;
      state.interlocutorName = (r.data && r.data.interlocutor_name)
        || (sel.selectedOptions[0] ? sel.selectedOptions[0].text : null);
      state._creds = null;                            // ya no se necesitan
      await finishAuth();
    } catch (e) {
      logError('login_sede', e);
      toast(e.message || 'No se pudo entrar a esa sede.', 'err');
    } finally {
      setBusy('intc-confirm', false);
    }
  }

  /* Fase 3: cabecera, pantallas y hub. */
  async function finishAuth() {
    el('hdr-sede').textContent = state.interlocutorName || 'Sede';
    el('hdr-user').textContent = state.user.username || state.user.nombre || '—';
    el('hdr-rol').textContent  = state.rol || '—';
    el('app-header').classList.remove('hidden');
    await loadParams();
    await loadScreens();
    renderHub();
  }

  /* Parámetros de implantación (GET /system/params). Adaptan validaciones. */
  async function loadParams() {
    // Defaults = modo implantación (no restringir por stock).
    state.params = { inventory_restriction: false, stock_negative_allowed: true, recipe_restriction: false };
    try {
      const r = await ApiClient.systemParams();
      const d = r?.data ?? {};
      const val = (k, def) => (d[k] && typeof d[k] === 'object' ? (d[k].value ?? def) : (d[k] ?? def));
      state.params = {
        inventory_restriction: !!val('inventory_restriction', false),
        stock_negative_allowed: val('stock_negative_allowed', true) !== false,
        recipe_restriction: !!val('recipe_restriction', false),
      };
    } catch (e) { logError('system/params', e); }
  }
  function stockRestricted() {
    return state.params && state.params.inventory_restriction === true && state.params.stock_negative_allowed === false;
  }

  /* Pantallas visibles del usuario actual (driven por el API CORE). */
  async function loadScreens() {
    try {
      const r = await ApiClient.misPantallas();
      const d = r?.data ?? null;
      // Acepta: {screens:'*'} | {screens:[...]} | '*' | [...] | {data:{screens:...}}
      let scr = (d && typeof d === 'object' && !Array.isArray(d))
        ? (d.screens ?? d.data?.screens ?? null)
        : d;
      if (scr === '*') state.screens = '*';                 // ── SuperAdmin: acceso total
      else if (Array.isArray(scr)) state.screens = scr;     // ── pantallas asignadas
      else state.screens = null;                            // ── desconocido → fallback local
    } catch (_) {
      state.screens = null;
    }
  }

  async function doLogout() {
    try { await ApiClient.logout(); } catch (_) {}
    state.user = state.rol = state.interlocutor = null;
    el('app-header').classList.add('hidden');
    el('login-user').value = el('login-pass').value = '';
    view('view-login');
  }

  /* ── Hub (tiles por rol) ──────────────────────────────────────── */
  const AREA = {
    almacen:    { label: 'Almacén',    color: '#642a72' },
    transporte: { label: 'Transporte', color: '#F59E0B' },
    tienda:     { label: 'Tienda',     color: '#2563eb' },
    mermas:     { label: 'Mermas',     color: '#EF4444' },
    gestion:    { label: 'Gestión',    color: '#6b7280' },
  };
  const TILE_META = {
    recepcion:  { t: 'Recepción de Mercancía',  d: 'Alta de stock por albarán',     area: 'almacen',    go: openRecepcion },
    ubicar:     { t: 'Ubicación por QR',         d: 'Asignar producto a estantería',  area: 'almacen',    go: openUbicar },
    picking:    { t: 'Picking de Traspasos',     d: 'Alistar y despachar pedidos',    area: 'almacen',    go: openPicking },
    transporte: { t: 'Ruta de Transporte',       d: 'Despacho y entrega en destino',  area: 'transporte', go: openTransporte },
    entregas:   { t: 'Mis Entregas',             d: 'Pedidos de tu ruta · marcar entregado', area: 'transporte', go: openEntregas },
    solicitar:  { t: 'Solicitar Insumos',        d: 'Pedido de traspaso a bodega',    area: 'tienda',     go: openSolicitar },
    recibir:    { t: 'Recepción de Traspaso',    d: 'Verificar y cerrar entrega',     area: 'tienda',     go: openRecibir },
    merma:      { t: 'Registrar Merma',          d: 'Baja con evidencia fotográfica', area: 'mermas',     go: openMerma },
    dashboard:  { t: 'Panel de Traspasos',       d: 'Estado, KPIs e histórico',       area: 'gestion',    go: openDashboard },
    gestor_permisos: { t: 'Gestor de Permisos',  d: 'Asignar pantallas a roles',      area: 'gestion',    go: openPermisos },
  };
  // Orden de aparición en el home (agrupado por área/rol).
  const TILE_ORDER = ['recepcion', 'ubicar', 'picking', 'transporte', 'entregas', 'solicitar', 'recibir', 'merma', 'dashboard', 'gestor_permisos'];
  /* Detección robusta de SuperAdmin: por rol, por usuario o por id global (=1).
     Resiliente a JWT sin rol (login en sede sin rol asignado). */
  function isSuperAdmin() {
    const norm = (v) => (v || '').toString().toLowerCase().replace(/[\s_-]/g, '');
    const r = norm(state.rol);
    const u = norm(state.user && (state.user.username || state.user.usuario || state.user.nombre));
    if (r.includes('superadmin') || u.includes('superadmin')) return true;
    const id = state.user && (state.user.user_id ?? state.user.id);
    return Number(id) === 1 || !!(state.user && state.user.is_superadmin);
  }
  /* Calcula las pantallas operativas visibles para el usuario actual. */
  function visibleTiles() {
    const all = Object.keys(TILE_META);
    if (isSuperAdmin()) return all;                              // SuperAdmin ve todo (incl. pantallas aún no registradas)
    if (Array.isArray(state.screens)) return state.screens.filter((k) => TILE_META[k]); // el API manda
    if (state.screens === '*') return all;                       // compatibilidad
    return ROLE_TILES[state.rol] || [];                          // fallback local
  }

  function orderTiles(keys) {
    return keys.slice().sort((a, b) => {
      const ia = TILE_ORDER.indexOf(a), ib = TILE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
  const MENU_KEYS = ['dashboard', 'gestor_permisos'];   // van al menú hamburguesa, no a tiles
  function renderHub() {
    const visible = visibleTiles();
    const tiles = orderTiles(visible.filter((k) => !MENU_KEYS.includes(k)));
    renderDrawer(visible);
    const wrap = el('hub-tiles');
    wrap.innerHTML = '';
    if (tiles.length === 0 && !isSuperAdmin()) {
      wrap.innerHTML = `<div class="rounded-xl border border-warn/40 bg-warn/10 p-4 text-warn-700">
        Tu rol no tiene pantallas asignadas en este módulo.</div>`;
    }
    const areasShown = [...new Set(tiles.map((k) => TILE_META[k].area))];
    const legend = el('hub-legend');
    if (legend) {
      legend.innerHTML = areasShown.map((a) =>
        `<span><i style="background:${AREA[a].color}"></i>${AREA[a].label}</span>`).join('');
    }
    tiles.forEach((key) => {
      const m = TILE_META[key];
      const b = document.createElement('button');
      b.className = 'tile';
      b.style.borderLeftColor = AREA[m.area].color;
      b.innerHTML = `<span class="tile-t">${m.t}</span><span class="tile-d">${m.d}</span>`;
      b.addEventListener('click', m.go);
      wrap.appendChild(b);
    });
    view('view-hub');
  }
  /* Muestra en el menú los accesos según permisos (dashboard / gestor_permisos). */
  function renderDrawer(visible) {
    const v = visible || visibleTiles();
    const dash = el('drawer-dashboard'), perm = el('drawer-permisos');
    if (dash) dash.classList.toggle('hidden', !v.includes('dashboard'));
    if (perm) perm.classList.toggle('hidden', !v.includes('gestor_permisos'));
  }
  function openDrawer() { el('app-drawer').classList.remove('hidden'); }
  function closeDrawer() { el('app-drawer').classList.add('hidden'); }

  /* ════════════════════════════════════════════════════════════════
     GESTOR DE PERMISOS · solo SuperAdmin
     Asocia cada pantalla del subsistema [1003] a roles operativos del
     API CORE. La fuente de verdad es el API CORE: aquí solo se edita.
  ════════════════════════════════════════════════════════════════ */
  function roleName(r) {
    if (typeof r === 'string') return r;
    return r?.nombre || r?.name || r?.rol || r?.role || r?.codigo || String(r?.id ?? '');
  }
  function screenKey(s) {
    if (typeof s === 'string') return s;
    return s?.screen_key || s?.key || s?.screen || s?.clave || '';
  }

  async function openPermisos() {
    view('view-permisos');
    const box = el('perm-groups');
    box.innerHTML = `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
    el('perm-save').disabled = true;

    let roles = [], map = {}, registered = null;
    try {
      const [rr, pp, ss] = await Promise.all([
        ApiClient.rolesListar(), ApiClient.permsListar(), ApiClient.screensListar().catch(() => null),
      ]);
      const rawRoles = rr?.data?.roles ?? rr?.data?.data ?? rr?.data ?? [];
      roles = (Array.isArray(rawRoles) ? rawRoles : []).map(roleName).filter(Boolean);
      const rawMap = pp?.data?.permissions ?? pp?.data?.data?.permissions ?? pp?.data ?? {};
      map = (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) ? rawMap : {};
      const rawScreens = ss?.data?.screens ?? ss?.data?.data ?? ss?.data ?? null;
      if (Array.isArray(rawScreens)) registered = rawScreens.map(screenKey).filter(Boolean);
    } catch (e) {
      logError('permisos/load', e);
      box.innerHTML = `<div class="empty">No se pudieron cargar los roles del API CORE.<br>
        Verifica la conexión y los endpoints de RBAC.</div>`;
      return;
    }

    if (roles.length === 0) {
      box.innerHTML = `<div class="empty">El API CORE no devolvió roles operativos.</div>`;
      return;
    }

    // Pantallas a gestionar: catálogo registrado (SSOT) que [1003] renderiza,
    // excluyendo la propia pantalla de administración (gestor_permisos).
    const screens = ((registered && registered.length)
      ? registered.filter((k) => TILE_META[k])
      : Object.keys(TILE_META)).filter((k) => k !== 'gestor_permisos');

    // Estado editable en memoria: { group: Set(roles) }
    const draft = {};
    screens.forEach((g) => {
      const assigned = Array.isArray(map[g]) ? map[g].map(roleName) : [];
      draft[g] = new Set(assigned);
    });
    state.ctx.permDraft = draft;
    state.ctx.permRoles = roles;

    box.innerHTML = '';
    screens.forEach((g) => {
      const card = document.createElement('div');
      card.className = 'perm-card';
      const chips = roles.map((rn) => {
        const on = draft[g].has(rn);
        return `<button type="button" class="chip ${on ? 'chip-on' : ''}"
                  data-group="${g}" data-role="${encodeURIComponent(rn)}">${rn}</button>`;
      }).join('');
      card.innerHTML = `<div class="perm-card-h">${TILE_META[g].t}</div>
        <div class="perm-card-d">${TILE_META[g].d}</div>
        <div class="chip-wrap">${chips}</div>`;
      box.appendChild(card);
    });

    box.querySelectorAll('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        const g = c.dataset.group;
        const rn = decodeURIComponent(c.dataset.role);
        if (draft[g].has(rn)) { draft[g].delete(rn); c.classList.remove('chip-on'); }
        else { draft[g].add(rn); c.classList.add('chip-on'); }
      });
    });

    el('perm-save').disabled = false;
  }

  async function savePermisos() {
    const draft = state.ctx.permDraft || {};
    const permissions = {};
    Object.keys(draft).forEach((g) => { permissions[g] = Array.from(draft[g]); });
    setBusy('perm-save', true);
    try {
      await ApiClient.permsGuardar(permissions);
      toast('Permisos actualizados en el API CORE.', 'ok');
      renderHub();
    } catch (e) {
      logError('permisos/save', e);
      toast(e.message || 'No se pudieron guardar los permisos.', 'err');
    } finally {
      setBusy('perm-save', false);
    }
  }

  /* ════════════════════════════════════════════════════════════════
     FLUJO 1 · RECEPCIÓN CONTRA ALBARÁN
  ════════════════════════════════════════════════════════════════ */
  /* PASO 1: lista de OC/albaranes pendientes de recepcionar (de [1002]). */
  const OC_FINAL = ['recibido', 'recibida', 'almacenado', 'almacenada', 'cerrado', 'cerrada', 'anulado', 'anulada'];
  async function openRecepcion() {
    view('view-recepcion');
    const list = el('recepcion-list'); list.innerHTML = skeleton();
    try {
      const r = await ApiClient.ocPendientes();
      const rows = rowsOf(r.data).filter((o) => !OC_FINAL.includes(String(ocState(o)).toLowerCase()));
      list.innerHTML = rows.length ? '' : empty('No hay albaranes pendientes por recepcionar.');
      rows.forEach((o) => {
        const c = document.createElement('button'); c.className = 'rowcard';
        c.innerHTML = `<div><b>${ocRef(o)}</b><small>${o.supplier_name || o.proveedor || ''} · ${ocState(o)}</small></div>
          <span class="chip">${(o.details || o.lines || []).length || '·'} líneas</span>`;
        c.addEventListener('click', () => openOC(o));
        list.appendChild(c);
      });
    } catch (e) { logError('recepcion/oc', e); list.innerHTML = empty('No hay albaranes pendientes por recepcionar.'); }
  }
  function ocId(o)    { return o.id ?? o.order_id ?? o.purchase_order_id; }
  function ocRef(o)   { return o.reference ?? o.referencia ?? o.numero_albaran ?? ('OC #' + ocId(o)); }
  function ocState(o) { return o.status ?? o.estado ?? '—'; }

  /* PASO 1b: detalle de la OC — líneas SKU para asociar ubicación + lote + cantidad. */
  async function openOC(oc) {
    view('view-oc');
    el('oc-title').textContent = 'Cargando…';
    el('oc-grid').innerHTML = skeleton();
    el('oc-save').disabled = true;
    await ensureCatalogs(['locations']);
    let detail = oc;
    try { const r = await ApiClient.ocDetalle(ocId(oc)); if (r.data) detail = r.data; }
    catch (e) { logError('oc/detalle', e); }
    const lines = detail.details || detail.lines || detail.lineas || [];
    state.ctx = { oc: detail, ref: ocRef(detail), lines: lines.map(normalizeLine) };
    el('oc-title').textContent = `${ocRef(detail)} · ${state.ctx.lines.length} SKU`;
    const grid = el('oc-grid'); grid.innerHTML = '';
    state.ctx.lines.forEach((ln, i) => grid.appendChild(ocLineCard(ln, i)));
    refreshOcSave();
  }
  function normalizeLine(d) {
    return {
      detail_id: d.detail_id ?? d.id,
      item_id: d.item_id ?? d.sku_id,
      item_type: d.item_type || 'sku',
      name: d.name ?? d.sku_name ?? d.descripcion ?? d.supplier_item_name ?? ('SKU ' + (d.item_id ?? '')),
      code: d.sku_final_code ?? d.codigo ?? '',
      unit: d.unit_of_measure ?? 'ud',
      requested: Number(d.quantity_requested ?? d.cantidad ?? 0),
      batch_reference: d.batch_reference ?? d.lote ?? '',
      expiration_date: d.expiration_date ?? d.fecha_caducidad ?? '',
      // entradas del usuario:
      loc: '', recibida: null, confirmed: false,
    };
  }
  function ocLineCard(ln, idx) {
    const card = document.createElement('div'); card.className = 'oc-card'; card.id = `oc-card-${idx}`;
    const locOpts = ['<option value="">Ubicación del lote…</option>']
      .concat(state.catalogs.locations.map((l) => `<option value="${l.id}">${lblLoc(l)}</option>`)).join('');
    card.innerHTML = `
      <div class="oc-card-h"><b>${ln.name}</b>${ln.code ? `<small>${ln.code}</small>` : ''}</div>
      <div class="oc-card-sub">Solicitado: <b>${ln.requested} ${ln.unit}</b></div>
      <div class="field-label">Ubicación destino del lote</div>
      <select id="oc-loc-${idx}" class="sel">${locOpts}</select>
      <div class="oc-row2">
        <div><div class="field-label">Lote</div><input id="oc-bref-${idx}" class="txt" placeholder="Ref. lote" value="${ln.batch_reference || ''}" /></div>
        <div><div class="field-label">Caducidad</div><input id="oc-exp-${idx}" class="txt" type="date" value="${ln.expiration_date || ''}" /></div>
      </div>
      <div class="field-label">Cantidad recibida (${ln.unit})</div>
      <div class="oc-row2">
        <input id="oc-qty-${idx}" class="num" inputmode="decimal" placeholder="0" value="${ln.requested || ''}" />
        <button id="oc-ok-${idx}" class="btn-ok-sm">Confirmar SKU</button>
      </div>`;
    setTimeout(() => {
      bindNumpad(el(`oc-qty-${idx}`));
      el(`oc-ok-${idx}`).addEventListener('click', () => confirmLine(idx));
    }, 0);
    return card;
  }
  function confirmLine(idx) {
    const ln = state.ctx.lines[idx];
    const loc = Number(el(`oc-loc-${idx}`).value);
    const bref = el(`oc-bref-${idx}`).value.trim();
    const exp = el(`oc-exp-${idx}`).value;
    const qty = Number(el(`oc-qty-${idx}`).value);
    if (!loc)  { toast('Asocia una ubicación al lote.', 'warn'); return; }
    if (!bref) { toast('Indica la referencia de lote.', 'warn'); return; }
    if (!qty)  { toast('Confirma la cantidad recibida.', 'warn'); return; }
    ln.loc = loc; ln.batch_reference = bref; ln.expiration_date = exp; ln.recibida = qty; ln.confirmed = true;
    el(`oc-card-${idx}`).classList.add('oc-done');
    el(`oc-ok-${idx}`).textContent = '✓ Confirmado';
    refreshOcSave();
  }
  function refreshOcSave() {
    const all = state.ctx.lines.length > 0 && state.ctx.lines.every((l) => l.confirmed);
    el('oc-save').disabled = !all;
  }
  /* PASO 1c: alta en inventario por SKU + marcar la OC como recibida/almacenada. */
  async function saveOC() {
    const { lines, ref } = state.ctx;
    if (!lines.every((l) => l.confirmed)) { toast('Confirma todas las líneas.', 'warn'); return; }
    setBusy('oc-save', true);
    try {
      for (const ln of lines) {                       // alta de stock por línea (FEFO)
        await ApiClient.reception({
          location_id: ln.loc,
          item_id: ln.item_id,
          item_type: ln.item_type || 'sku',
          batch: { batch_reference: ln.batch_reference, expiration_date: ln.expiration_date || null },
          quantity: ln.recibida,
          movement_type: 'Compra',
          reference_document: ref,
        });
      }
      // Marca la OC como recibida/almacenada en compras.
      await ApiClient.ocRecibir(ocId(state.ctx.oc),
        lines.filter((l) => l.detail_id != null).map((l) => ({ detail_id: l.detail_id, quantity_received: l.recibida })));
      toast('Recepción almacenada y stock dado de alta.', 'ok');
      openRecepcion();
    } catch (e) {
      logError('oc/save', e);
      toast(e.message || 'No se pudo completar la recepción.', 'err');
    } finally {
      setBusy('oc-save', false);
    }
  }

  /* ════════════════════════════════════════════════════════════════
     FLUJO 2 · UBICACIÓN POR QR
  ════════════════════════════════════════════════════════════════ */
  async function openUbicar() {
    state.ctx = { destinoQR: null };
    view('view-ubicar');
    el('ubicar-cant').value = '';
    el('ubicar-loc').textContent = '—';
    resetSkuSearch('ubicar-sku-q', 'ubicar-sku-res');
    fillSelect(el('ubicar-batch'), [], lblBatch, 'Elige SKU primero…');
    bindNumpad(el('ubicar-cant'));
    await ensureCatalogs(['locations']);
    fillSelect(el('ubicar-origen'), state.catalogs.locations, lblLoc, 'Ubicación origen…');
    fillSelect(el('ubicar-dest'),   state.catalogs.locations, lblLoc, 'Ubicación destino…');
  }
  async function scanUbicacion() {
    try {
      const code = await Scanner.scanQR(el('ubicar-cam'));
      el('ubicar-loc').textContent = code;
      const match = state.catalogs.locations.find((l) => String(locQR(l)) === code);
      if (match) el('ubicar-dest').value = String(match.id);
    } catch (e) { logError('ubicar/scan', e); toast('No se pudo leer el QR.', 'err'); }
  }
  async function confirmUbicar() {
    const origen = Number(el('ubicar-origen').value);
    const dest   = Number(el('ubicar-dest').value);
    const item   = pickedSku('ubicar-sku-q');
    const batch  = Number(el('ubicar-batch').value);
    const cant   = Number(el('ubicar-cant').value);
    const unit   = el('ubicar-unidad').value;
    if (!origen || !dest || !item || !batch || !cant) { toast('Completa origen, destino, SKU, lote y cantidad.', 'warn'); return; }
    if (origen === dest) { toast('Origen y destino no pueden coincidir.', 'warn'); return; }

    const payload = {
      location_id_origin: origen,
      location_id_destination: dest,
      item_id: item,
      item_type: 'sku',
      batch_id: batch,
      quantity: Metrology.toBase(cant, unit),
      movement_type: 'Traslado Interno',
    };
    await sendTx('ubicar', payload, 'Producto ubicado.');
    renderHub();
  }

  /* ════════════════════════════════════════════════════════════════
     FLUJO 3 · TRASPASO EXTERNO (5 interfaces por rol)
  ════════════════════════════════════════════════════════════════ */
  // A) Solicitar insumos
  async function openSolicitar() {
    view('view-solicitar');
    state.ctx = { qty: {}, skus: [], stock: {}, fabricas: [] };
    el('sol-notes').value = '';
    el('sol-ctx-user').textContent = state.user?.nombre || state.user?.username || '—';
    el('sol-ctx-int').textContent  = state.interlocutorName || ('Interlocutor ' + (state.interlocutor ?? '—'));
    el('sol-ctx-rol').textContent  = state.rol || '—';
    state.ctx.tipo = 'FAV';
    renderSolChips();
    el('sol-sku-q').value = '';
    el('sol-sheet').classList.add('hidden');
    fillSelect(el('sol-origen'), [], intName, 'Cargando fábricas…');
    el('sol-sku-res').innerHTML = skeleton();
    updateSolCta();
    await loadFabricas();
    await resolveSolEndpoints();
    await loadSolStock();
    await loadSolSkus();
  }
  /* Carga fábricas (origen), ordenadas por id ascendente; la primera por defecto. */
  async function loadFabricas() {
    try {
      const fr = await ApiClient.catalog('interlocutors', { type: 'fabrica' });
      const fabricas = rowsOf(fr.data).slice().sort((a, b) => Number(a.id) - Number(b.id));
      state.ctx.fabricas = fabricas;
      const sel = el('sol-origen'); sel.innerHTML = '';
      fabricas.forEach((f, i) => {
        const o = document.createElement('option');
        o.value = String(f.id); o.textContent = intName(f);
        if (i === 0) o.selected = true;                 // primera por defecto
        sel.appendChild(o);
      });
      if (!fabricas.length) fillSelect(sel, [], intName, 'Sin fábricas');
      sel.onchange = async () => { await resolveSolEndpoints(); await loadSolStock(); renderSolCards(); };
    } catch (e) { logError('sol/fabricas', e); fillSelect(el('sol-origen'), [], intName, 'Sin fábricas'); }
  }
  async function locForInterlocutor(intId) {
    if (!intId) return null;
    let locs = [];
    try {
      const r = await ApiClient.catalog('locations', { interlocutor_id: intId });
      locs = rowsOf(r.data).filter((l) => Number(l.interlocutor_id) === Number(intId) || !l.interlocutor_id);
    } catch (e) { logError('sol/locs', e); }
    if (!locs.length) {
      await ensureCatalog('locations');
      locs = (state.catalogs.locations || []).filter((l) => Number(l.interlocutor_id) === Number(intId));
    }
    const pref = (a) => String(a || '').toLowerCase();
    return locs.find((l) => pref(l.area_type) === 'bodega') || locs[0] || null;
  }
  async function resolveSolEndpoints() {
    const originIntId = Number(el('sol-origen').value) || (state.ctx.fabricas[0] && state.ctx.fabricas[0].id) || null;
    const destIntId   = state.interlocutor ?? null;
    const [oLoc, dLoc] = await Promise.all([locForInterlocutor(originIntId), locForInterlocutor(destIntId)]);
    state.ctx.originIntId = originIntId;
    state.ctx.destIntId   = destIntId;
    state.ctx.originLocId = oLoc ? oLoc.id : null;
    state.ctx.destLocId   = dLoc ? dLoc.id : null;
    if (!oLoc) toast('La fábrica de origen no tiene ubicaciones registradas.', 'warn');
    if (!dLoc) toast('Tu sede no tiene ubicaciones registradas. Avisa al administrador.', 'warn');
  }
  function intName(i) { return i.commercial_name || i.fiscal_name || i.name || i.nombre || ('Interlocutor ' + i.id); }

  /* Stock del origen: una sola llamada → mapa item_id → {qty, loc}. */
  async function loadSolStock() {
    state.ctx.stock = {};
    const intId = state.ctx.originIntId;
    if (!intId) return;
    try {
      const r = await ApiClient.stock({ interlocutor_id: intId });
      rowsOf(r.data).forEach((s) => {
        const id = Number(s.item_id ?? s.sku_id);
        if (!id) return;
        const q = Number(s.quantity ?? s.current_quantity ?? s.quantity_available ?? 0);
        const prev = state.ctx.stock[id];
        state.ctx.stock[id] = {
          qty: (prev ? prev.qty : 0) + q,
          loc: (prev && prev.loc) || s.location_qr || s.qr_code_uid || s.location_name || s.area_type || '',
        };
      });
    } catch (e) { logError('sol/stock', e); }
  }
  /* Catálogo de SKUs: todas las categorías (el API omite PT → se pide aparte). */
  function renderSolChips() {
    const wrap = el('sol-chips'); wrap.innerHTML = '';
    SKU_TYPES.forEach((t) => {
      const b = document.createElement('button');
      b.className = 'chip-f' + (t.v === 'FAV' ? ' chip-fav' : '') + (state.ctx.tipo === t.v ? ' on' : '');
      b.textContent = t.c || t.t;
      b.addEventListener('click', () => { state.ctx.tipo = t.v; renderSolChips(); loadSolSkus().catch(() => {}); });
      wrap.appendChild(b);
    });
  }

  /* ── "Más usados": frecuencia por SKU de la sede ──────────────────────
     Se acumula localmente al enviar cada solicitud y, la primera vez, se
     siembra con el historial de traspasos de la sede (API). */
  function freqKey() { return `omni1003_freq_${state.interlocutor || 0}`; }
  function freqGet() {
    try { return JSON.parse(localStorage.getItem(freqKey()) || '{}'); } catch (_) { return {}; }
  }
  function freqBump(ids) {
    const f = freqGet();
    ids.forEach((id) => { f[id] = (f[id] || 0) + 1; });
    try { localStorage.setItem(freqKey(), JSON.stringify(f)); } catch (_) {}
  }
  async function freqSeed() {
    const f = freqGet();
    if (Object.keys(f).length) return f;
    try {
      const r = await ApiClient.traspasos();                    // traspasos de mi sede
      const mine = Number(state.interlocutor);
      const rows = rowsOf(r.data)
        .filter((t) => { const d = destIntOf(t); return d == null || d === mine; })
        .sort((a, b) => String(transferDate(b)).localeCompare(String(transferDate(a))))
        .slice(0, 12);                                          // últimos 12 pedidos
      const lotes = await Promise.all(rows.map((t) => transferItems(t).catch(() => [])));
      lotes.flat().forEach((it) => {
        const id = Number(it.item_id); if (!id) return;
        f[id] = (f[id] || 0) + 1;
      });
      if (Object.keys(f).length) { try { localStorage.setItem(freqKey(), JSON.stringify(f)); } catch (_) {} }
    } catch (e) { logError('sol/freq', e); }
    return f;
  }
  async function fetchAllSkus(base) {
    const [gen, pt] = await Promise.all([                        // el API omite PT por defecto
      ApiClient.catalog('skus', base).catch(() => ({ data: [] })),
      ApiClient.catalog('skus', { ...base, item_type: 'PT' }).catch(() => ({ data: [] })),
    ]);
    const seen = new Set();
    return [...rowsOf(gen.data), ...rowsOf(pt.data)]
      .filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; })
      .filter((s) => (s.status ?? 'active') === 'active');
  }
  async function loadSolSkus() {
    const type = state.ctx.tipo || '';
    const q = el('sol-sku-q').value.trim();
    const base = { status: 'active', limit: 200 };
    if (q) base.q = q;
    el('sol-sku-res').innerHTML = skeleton();
    try {
      let rows;
      if (type === 'FAV') {
        const f = await freqSeed();
        const ids = Object.keys(f).sort((a, b) => f[b] - f[a]).map(Number);
        if (!ids.length) {
          el('sol-sku-res').innerHTML = empty('Aún no hay historial de pedidos. Usa "TODOS" para buscar.');
          state.ctx.skus = []; return;
        }
        const all = await fetchAllSkus(base);
        state.ctx.skus = ids.map((id) => all.find((s) => Number(s.id) === id)).filter(Boolean);
        renderSolCards(); return;
      }
      if (type) {
        rows = rowsOf((await ApiClient.catalog('skus', { ...base, item_type: type })).data);
      } else {
        const [gen, pt] = await Promise.all([
          ApiClient.catalog('skus', base).catch(() => ({ data: [] })),
          ApiClient.catalog('skus', { ...base, item_type: 'PT' }).catch(() => ({ data: [] })),
        ]);
        const seen = new Set();
        rows = [...rowsOf(gen.data), ...rowsOf(pt.data)]
          .filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
      }
      state.ctx.skus = rows.filter((s) => (s.status ?? 'active') === 'active')
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      renderSolCards();
    } catch (e) {
      logError('sol/skus', e);
      el('sol-sku-res').innerHTML = apiErrorBox([e]);
    }
  }
  /* Tarjetas de SKU con stepper (cero tecleo). La cantidad viaja en state.ctx.qty. */
  function renderSolCards() {
    const wrap = el('sol-sku-res');
    const rows = state.ctx.skus;
    wrap.innerHTML = '';
    if (!rows.length) { wrap.innerHTML = empty('Sin productos para ese filtro.'); return; }
    rows.forEach((s) => {
      const st = state.ctx.stock[Number(s.id)] || {};
      const unit = skuUnit(s);
      const qty = state.ctx.qty[s.id] || 0;
      const stock = Number(st.qty || 0);
      const step = unit === 'ud' ? 1 : 100;               // g/ml → pasos de 100
      const card = document.createElement('div');
      card.className = 'sol-card' + (qty > 0 ? ' picked' : '');
      card.innerHTML = `
        <div class="sol-card-main">
          <div class="sol-card-top">
            <span class="sol-sku">SKU ${s.id}</span>
            ${s.item_type ? `<span class="sol-tag">${s.item_type}</span>` : ''}
          </div>
          <div class="sol-card-n">${s.name || ('SKU ' + s.id)}</div>
          <div class="sol-card-c">${s.sku_final_code || ''}</div>
          <div class="sol-card-m">
            <span>Ubicación actual: <b>${st.loc || '—'}</b></span>
            <span>Stock actual: <b class="${stock <= 0 ? 'sol-crit' : ''}">${stock} ${unit}</b>${stock <= 0 ? ' <span class="sol-crit">⚠ Sin stock</span>' : ''}</span>
          </div>
        </div>
        <div class="stepper">
          <div class="stp-row">
            <button class="stp-btn minus" aria-label="Restar">−</button>
            <input class="stp-val" type="number" min="0" step="0.01" inputmode="decimal" value="${qty}" />
            <button class="stp-btn plus" aria-label="Sumar">+</button>
          </div>
          <div class="stp-quick">
            <button class="stp-q" data-add="${step}">+${step}</button>
            <button class="stp-q" data-add="${step * 10}">+${step * 10}</button>
            <button class="stp-q stp-pad" aria-label="Teclado numérico">⌨</button>
          </div>
        </div>`;
      const val = card.querySelector('.stp-val');
      const cur = () => state.ctx.qty[s.id] || 0;
      card.querySelector('.minus').addEventListener('click', () => setSolQty(s.id, cur() - step, val, card));
      card.querySelector('.plus').addEventListener('click',  () => setSolQty(s.id, cur() + step, val, card));
      card.querySelectorAll('.stp-q[data-add]').forEach((q) =>
        q.addEventListener('click', () => setSolQty(s.id, cur() + Number(q.dataset.add), val, card)));
      card.querySelector('.stp-pad').addEventListener('click', () => openNumpad(val));   // teclado numérico
      val.addEventListener('input', () => setSolQty(s.id, val.value, null, card));
      wrap.appendChild(card);
    });
  }
  function setSolQty(id, q, val, card) {
    q = Math.max(0, Number(q) || 0);
    q = Math.round(q * 100) / 100;                 // hasta 2 decimales
    if (q === 0) delete state.ctx.qty[id]; else state.ctx.qty[id] = q;
    if (val) val.value = String(q);
    if (card) card.classList.toggle('picked', q > 0);
    updateSolCta();
  }
  function updateSolCta() {
    const ids = Object.keys(state.ctx.qty || {});
    el('sol-total-n').textContent = String(ids.length);
    const btn = el('sol-confirm');
    btn.disabled = ids.length === 0;
    if (!ids.length) el('sol-sheet').classList.add('hidden');
    renderSolSummary();
  }
  function renderSolSummary() {
    const wrap = el('sol-summary'); if (!wrap) return;
    const byId = Object.fromEntries((state.ctx.skus || []).map((s) => [String(s.id), s]));
    const ids = Object.keys(state.ctx.qty || {});
    wrap.innerHTML = ids.length ? '' : '<div class="sol-sum-row"><span class="sol-sum-n">Sin productos seleccionados.</span></div>';
    ids.forEach((id) => {
      const s = byId[id] || {};
      const unit = skuUnit(s);
      const r = document.createElement('div'); r.className = 'sol-sum-row';
      r.innerHTML = `<span class="sol-sum-n">${s.name || ('SKU ' + id)}<span class="sol-sum-u">${s.sku_final_code || ''}</span></span>
        <span class="sol-sum-q">${state.ctx.qty[id]} ${unit}</span>`;
      wrap.appendChild(r);
    });
  }
  async function confirmSolicitar() {
    const ids = Object.keys(state.ctx.qty || {});
    if (!ids.length) { toast('Indica la cantidad de al menos un producto.', 'warn'); return; }
    if (!state.ctx.originLocId || !state.ctx.destLocId) {
      toast('No se pudo resolver origen/destino. Avisa al encargado.', 'err'); return;
    }
    const payload = {
      location_id_origin: state.ctx.originLocId,
      location_id_destination: state.ctx.destLocId,
      items: ids.map((id) => ({
        item_id: Number(id),
        item_type: 'sku',
        quantity_requested: state.ctx.qty[id],
      })),   // batch_id lo resuelve el API (FEFO o lote provisional)
      notes: el('sol-notes').value.trim(),
    };
    freqBump(ids);                       // alimenta el filtro "Más usados"
    await sendTx('traspaso_solicitar', payload, 'Solicitud registrada (SOLICITADO).');
    renderHub();
  }


  // Helpers de traspaso (resolver interlocutores y fecha)
  function intNameById(id) {
    const f = (state.catalogs.interlocutors || []).find((x) => Number(x.id) === Number(id));
    return f ? intName(f) : (id != null ? 'Interlocutor ' + id : '—');
  }
  function originIntOf(t) {
    if (t.interlocutor_id_origin != null) return Number(t.interlocutor_id_origin);
    const l = (state.catalogs.locations || []).find((x) => Number(x.id) === Number(t.location_id_origin));
    return l ? Number(l.interlocutor_id) : null;
  }
  function destIntOf(t) {
    if (t.interlocutor_id_dest != null) return Number(t.interlocutor_id_dest);
    const l = (state.catalogs.locations || []).find((x) => Number(x.id) === Number(t.location_id_destination));
    return l ? Number(l.interlocutor_id) : null;
  }
  function transferDate(t) { return t.at_solicitado || t.created_at || t.fecha || ''; }
  function fmtDT(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d)) return String(s);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // Picking: solo solicitudes cuyo ORIGEN es mi interlocutor. Incluye SOLICITADO
  // (nuevas) y EN_PICKING (asignadas a mí, reabribles hasta cambiar de estado).
  const PICKING_STATES = ['SOLICITADO', 'EN_PICKING'];
  /* Consulta traspasos y NO oculta los errores del API (403 por permisos, etc.). */
  async function fetchTransfers(states) {
    const errs = [];
    const calls = [...states.map((s) => ApiClient.traspasos(s)), ApiClient.traspasos()];
    const res = await Promise.all(calls.map((p) => p.catch((e) => { errs.push(e); return { data: [] }; })));
    const seen = new Set();
    const rows = res.flatMap((r) => rowsOf(r.data))
      .filter((t) => states.includes(String(tState(t)).toUpperCase()))
      .filter((t) => { const id = tId(t); if (seen.has(id)) return false; seen.add(id); return true; });
    return { rows, errs, allFailed: errs.length === calls.length };
  }
  function apiErrorBox(errs) {
    const e = errs[0] || {};
    const code = e.code || e.status || '';
    const denied = String(code).includes('403') || /rbac|permis|denegad/i.test(e.message || '');
    const msg = denied
      ? `Tu rol (${state.rol || '—'}) no tiene permiso para consultar traspasos. Pide al SuperAdmin que te asigne esta pantalla en el Gestor de Permisos.`
      : (e.message || 'No se pudo consultar el API.');
    return `<div class="err-box">${msg}</div>`;
  }
  async function openPicking() {
    view('view-picking');
    const list = el('picking-list'); list.innerHTML = skeleton();
    await ensureCatalogs(['locations', 'interlocutors']);
    const { rows, errs, allFailed } = await fetchTransfers(PICKING_STATES);
    if (allFailed) { logError('picking/list', errs[0]); list.innerHTML = apiErrorBox(errs); return; }
    const mine = Number(state.interlocutor);
    const mias = rows.filter((t) => { const o = originIntOf(t); return o == null || o === mine; });
    if (!mias.length) { list.innerHTML = empty('No hay solicitudes para tu almacén.'); return; }
    list.innerHTML = '';
    mias.forEach((t) => {
      const st = String(tState(t)).toUpperCase();
      const c = document.createElement('button'); c.className = 'rowcard';
      const badge = st === 'EN_PICKING'
        ? '<span class="chip chip-amb">EN PREPARACIÓN</span>'
        : '<span class="chip">SOLICITADO</span>';
      c.innerHTML = `<div><b>Traspaso #${tId(t)}</b>
        <small>Solicita: ${t.dest_sede || intNameById(destIntOf(t))}${transferDate(t) ? ' · ' + fmtDT(transferDate(t)) : ''}</small></div>${badge}`;
      c.addEventListener('click', () => openAlistarFor(t, st !== 'EN_PICKING').catch(() => {}));
      list.appendChild(c);
    });
  }
  /* El listado de traspasos no anida ítems; se obtienen del detalle /{id}. */
  async function transferItems(t) {
    if (Array.isArray(t.items) && t.items.length) return t.items;
    try {
      const r = await ApiClient.traspasoDetalle(tId(t));
      const d = r?.data ?? {};
      return d.items || d.details || d.lineas || [];
    } catch (e) { logError('transfer/detalle', e); return []; }
  }
  function itemCount(t) {
    if (t.item_count != null) return Number(t.item_count);
    if (t.items_count != null) return Number(t.items_count);
    if (t.total_items != null) return Number(t.total_items);
    if (Array.isArray(t.items) && t.items.length) return t.items.length;
    return null;                     // el listado no anida ítems → "ver detalle"
  }
  // Abre el alistado. start=true inicia el picking (SOLICITADO→EN_PICKING);
  // start=false reabre una solicitud ya asignada (EN_PICKING) sin re-iniciar.
  async function openAlistarFor(t, start) {
    try {
      if (start) await ApiClient.pickingIniciar({ traspaso_id: tId(t) });   // → EN_PICKING (bloqueo/asignación)
      let header = t, items = [];
      try {
        const r = await ApiClient.traspasoDetalle(tId(t));
        const d = r?.data ?? {};
        header = d.transfer || t;
        items = d.items || d.details || [];
      } catch (e) { logError('picking/detalle', e); items = await transferItems(t); }
      state.ctx = {
        traspaso: t, header,
        items: items.map((it) => ({ ...it, despachada: Number(it.quantity_requested ?? 0), obs: '', done: false })),
      };
      renderAlistar();
    } catch (e) { logError('picking/abrir', e); toast(e.message || 'No se pudo abrir el alistado.', 'err'); }
  }
  function renderAlistar() {
    view('view-alistar');
    const h = state.ctx.header;
    el('alistar-title').textContent = `Alistar Traspaso #${tId(state.ctx.traspaso)}`;
    el('alistar-sub').textContent = `Solicita: ${intNameById(destIntOf(h))}${transferDate(h) ? ' · ' + fmtDT(transferDate(h)) : ''}`;
    const grid = el('alistar-grid'); grid.innerHTML = '';
    state.ctx.items.forEach((it, i) => {
      const sol = Number(it.quantity_requested ?? 0);
      const card = document.createElement('div'); card.className = 'ali-card'; card.id = `ali-card-${i}`;
      card.innerHTML = `
        <label class="ali-check"><input type="checkbox" id="ali-chk-${i}" /><b>${itemLabel(it)}</b></label>
        <div class="oc-card-sub">Solicitada: <b>${sol}</b>${it.batch_reference ? ` · Lote ${it.batch_reference}` : ''}</div>
        <div class="oc-row2">
          <div><div class="field-label">Despachada</div>
            <input id="ali-qty-${i}" class="num" type="number" min="0" step="0.01" inputmode="decimal" value="${sol}" /></div>
          <div><div class="field-label">Observación</div><input id="ali-obs-${i}" class="txt" placeholder="Opcional…" /></div>
        </div>
        <div id="ali-warn-${i}" class="ali-warn hidden">⚠️ Mayor al solicitado</div>
        <button id="ali-zero-${i}" class="btn-zero">Sin stock (0)</button>`;
      grid.appendChild(card);
      setTimeout(() => {
        const q = el(`ali-qty-${i}`), chk = el(`ali-chk-${i}`), obs = el(`ali-obs-${i}`), warn = el(`ali-warn-${i}`);
        const sync = () => {
          const v = Math.max(0, Number(q.value) || 0);      // sin tope superior; 0 permitido
          it.despachada = Math.round(v * 100) / 100;        // 2 decimales
          warn.classList.toggle('hidden', it.despachada <= sol);
        };
        q.addEventListener('input', sync);
        obs.addEventListener('input', () => { it.obs = obs.value; });
        el(`ali-zero-${i}`).addEventListener('click', () => {   // atajo: sin existencias
          q.value = '0'; sync();
          if (!obs.value.trim()) { obs.value = 'Sin stock'; it.obs = 'Sin stock'; }
        });
        chk.addEventListener('change', () => {
          it.done = chk.checked;
          card.classList.toggle('ali-done', chk.checked);
          updateAliProgress();
        });
      }, 0);
    });
    el('ali-all').checked = false;
    updateAliProgress();
  }
  function updateAliProgress() {
    const total = state.ctx.items.length;
    const done = state.ctx.items.filter((it) => it.done).length;
    el('ali-progress').textContent = `${done}/${total} alistados`;
    el('alistar-confirm').disabled = total === 0 || done < total;
  }
  function toggleAliAll(checked) {
    state.ctx.items.forEach((it, i) => {
      it.done = checked;
      const chk = el(`ali-chk-${i}`); if (chk) chk.checked = checked;
      const card = el(`ali-card-${i}`); if (card) card.classList.toggle('ali-done', checked);
    });
    updateAliProgress();
  }
  async function confirmAlistar() {
    const items = state.ctx.items;
    if (!items.every((it) => it.done)) { toast('Marca todos los ítems como alistados.', 'warn'); return; }
    const short = items.find((it) => it.despachada < Number(it.quantity_requested ?? 0) && !it.obs.trim());
    if (short) { toast('Añade una observación en los ítems con faltante.', 'warn'); return; }

    // El API acepta quantity_dispatched = 0 (ítem sin existencias): se envían TODOS
    // los ítems con su cantidad real para no perder el "pedido no atendido".
    const ceros = items.filter((it) => Number(it.despachada) <= 0);
    const notas = [
      ...items.filter((it) => it.obs.trim()).map((it) => `${itemLabel(it)}: ${it.obs.trim()}`),
      ...ceros.filter((it) => !it.obs.trim()).map((it) => `SIN STOCK: ${itemLabel(it)}`),
    ].join(' | ');

    const payload = {
      traspaso_id: tId(state.ctx.traspaso),
      notes: notas,
      items: items.map((it) => {
        const o = { item_id: it.item_id, batch_id: it.batch_id, quantity_dispatched: Math.round((Number(it.despachada) || 0) * 100) / 100 };
        if (it.obs.trim()) o.notes = it.obs.trim();
        return o;
      }),
    };
    if (ceros.length) toast(`${ceros.length} ítem(s) se despachan en 0 (sin stock).`, 'warn');
    await sendTx('picking_alistar', payload, 'Traspaso LISTO_DESPACHO (en tránsito).');
    openPicking();
  }

  // D) Transportista: pedidos listos para transportar / en ruta (origen = mi sede).
  async function openTransporte() {
    view('view-transporte');
    await ensureCatalogs(['locations', 'interlocutors']);
    const list = el('transporte-list'); list.innerHTML = skeleton();
    // Rutas activas: aceptan traspasos en estado despachado y en_transito.
    try {
      const [rd, rt] = await Promise.all([
        ApiClient.rutasActivas('despachado').catch(() => ({ data: [] })),
        ApiClient.rutasActivas('en_transito').catch(() => ({ data: [] })),
      ]);
      const seenR = new Set();
      state.rutas = [...rowsOf(rd.data), ...rowsOf(rt.data)]
        .filter((r) => { if (seenR.has(r.id)) return false; seenR.add(r.id); return true; });
    } catch (e) { logError('transporte/rutas', e); state.rutas = []; }
    renderRutasPanel();
    const { rows, errs, allFailed } = await fetchTransfers(['LISTO_DESPACHO', 'EN_RUTA']);
    if (allFailed) { logError('transporte/list', errs[0]); list.innerHTML = apiErrorBox(errs); return; }
    const mine = Number(state.interlocutor);
    const mias = rows.filter((t) => { const o = originIntOf(t); return o == null || o === mine; });
    list.innerHTML = mias.length ? '' : empty('No hay pedidos listos para transportar.');
    mias.forEach((t) => list.appendChild(transporteCard(t)));
  }
  function rutaLabel(r) {
    const base = r.route_code || ('Ruta ' + r.id);
    const extra = [r.plate_number, r.driver_name].filter(Boolean).join(' · ');
    return extra ? `${base} — ${extra}` : base;
  }
  // Panel superior: rutas activas con acción de confirmar salida del vehículo.
  function renderRutasPanel() {
    const wrap = el('transporte-routes'); if (!wrap) return;
    wrap.innerHTML = '';
    const rutas = state.rutas || [];
    if (!rutas.length) return;
    const h = document.createElement('div'); h.className = 'tp-panel-h'; h.textContent = 'Rutas activas';
    wrap.appendChild(h);
    rutas.forEach((r) => {
      const st = String(r.status || '').toLowerCase();
      const card = document.createElement('div'); card.className = 'rowcard col';
      card.innerHTML = `<div class="rowcard-top"><b>${r.route_code || ('Ruta ' + r.id)}</b>
        <span class="chip ${st === 'en_transito' ? 'chip-amb' : ''}">${st.replace(/_/g, ' ') || '—'}</span></div>
        <small class="tp-sub">${[r.plate_number, r.model, r.driver_name].filter(Boolean).join(' · ')}${r.transfers_count != null ? ' · ' + r.transfers_count + ' traspaso(s)' : ''}</small>`;
      if (st === 'despachado') {
        const ctrls = document.createElement('div'); ctrls.className = 'rowcard-ctrls';
        const go = document.createElement('button'); go.className = 'btn-prim-sm'; go.textContent = 'Confirmar salida';
        go.addEventListener('click', async () => {
          try {
            await ApiClient.rutaActualizar({ route_id: r.id, dispatch_time: new Date().toISOString(), status: 'en_transito' });
            toast('Salida confirmada. Ruta en tránsito.', 'ok'); openTransporte();
          } catch (e) { logError('ruta/salida', e); toast(e.message || 'No se pudo confirmar la salida.', 'err'); }
        });
        ctrls.appendChild(go); card.appendChild(ctrls);
      }
      wrap.appendChild(card);
    });
  }
  function transporteCard(t) {
    const id = tId(t); const st = tState(t);
    const c = document.createElement('div'); c.className = 'rowcard col';
    c.innerHTML = `<div class="rowcard-top"><b>Traspaso #${id}</b>
      <span class="chip ${st === 'EN_RUTA' ? 'chip-amb' : ''}">${st.replace(/_/g, ' ')}</span></div>
      <small class="tp-sub">Entregar a: ${t.dest_sede || intNameById(destIntOf(t))}${transferDate(t) ? ' · ' + fmtDT(transferDate(t)) : ''}${t.route_code ? ' · ' + t.route_code : ''}</small>`;
    const det = document.createElement('div'); det.className = 'dash-det hidden';
    const seeBtn = document.createElement('button'); seeBtn.className = 'btn-ghost btn-see'; seeBtn.textContent = 'Ver qué entrego';
    seeBtn.addEventListener('click', async () => {
      det.classList.toggle('hidden');
      if (!det.dataset.loaded) {
        det.innerHTML = '<div class="skel"></div>';
        const items = await transferItems(t); det.dataset.loaded = '1';
        det.innerHTML = items.length ? items.map((it) =>
          `<div class="dash-det-row"><span>${itemLabel(it)}</span><b>${it.quantity_dispatched ?? it.quantity_requested ?? 0}</b></div>`).join('')
          : '<div class="dash-det-row"><span>Sin ítems.</span></div>';
      }
    });
    const ctrls = document.createElement('div'); ctrls.className = 'rowcard-ctrls';
    const assignedWrap = document.createElement('div'); assignedWrap.className = 'tp-assigned';
    const showAssigned = (info) => {
      const label = [info.route_code, info.plate_number, info.driver_name].filter(Boolean).join(' · ');
      assignedWrap.innerHTML = label ? `<span class="tp-ok">✓ Asignado a ${label}</span>` : '';
    };
    if (t.logistic_route_id || t.route_code) showAssigned(t);   // ya asignado (si el API lo trae)
    if (st === 'LISTO_DESPACHO' || st === 'EN_RUTA') {
      if (!state.rutas || !state.rutas.length) {
        const msg = document.createElement('div'); msg.className = 'tp-noroute';
        msg.textContent = 'No hay rutas disponibles. Contacta al administrador.';
        ctrls.appendChild(msg);
      } else {
        const ruta = document.createElement('select'); ruta.className = 'sel';
        ruta.add(new Option('Asignar a ruta…', ''));
        state.rutas.forEach((r) => ruta.add(new Option(rutaLabel(r), r.id)));
        if (t.logistic_route_id) ruta.value = String(t.logistic_route_id);
        const go = document.createElement('button'); go.className = 'btn-amber-sm'; go.textContent = 'Asignar ruta';
        go.addEventListener('click', async () => {
          if (!ruta.value) { toast('Elige una ruta.', 'warn'); return; }
          setBusyEl(go, true);
          try {
            const r = await ApiClient.asignarRuta({ traspaso_id: id, logistic_route_id: Number(ruta.value) });
            const info = (r && r.data) ? r.data : (state.rutas.find((x) => Number(x.id) === Number(ruta.value)) || {});
            showAssigned(info);
            toast('Traspaso asignado a la ruta.', 'ok');
          } catch (e) { logError('transporte/asignar', e); toast(e.message || 'No se pudo asignar.', 'err'); }
          finally { setBusyEl(go, false); }
        });
        ctrls.append(ruta, go);
      }
    }
    if (st === 'LISTO_DESPACHO') {                // despacho directo sin ruta/chofer
      const goSend = document.createElement('button'); goSend.className = 'btn-ok-sm'; goSend.textContent = 'ENVIAR';
      goSend.addEventListener('click', async () => {
        await sendTx('traspaso_enviar', { traspaso_id: id }, 'Despachado directo (PENDIENTE_RECEPCION).');
        openTransporte();
      });
      ctrls.append(goSend);
    }
    if (st === 'EN_RUTA') {                       // marcar entrega física → PENDIENTE_RECEPCION
      const goEnt = document.createElement('button'); goEnt.className = 'btn-prim-sm'; goEnt.textContent = 'ENTREGAR';
      goEnt.addEventListener('click', async () => {
        await sendTx('transporte_entregar', { traspaso_id: id }, 'Entregado (PENDIENTE_RECEPCION).');
        openTransporte();
      });
      ctrls.append(goEnt);
    }
    c.append(seeBtn, det, ctrls, assignedWrap);
    return c;
  }

  // F) Repartidor: entregas en tránsito de su sede → marcar entregado.
  async function openEntregas() {
    view('view-entregas');
    await ensureCatalogs(['interlocutors', 'locations']);
    const list = el('entregas-list'); list.innerHTML = skeleton();
    const { rows, errs, allFailed } = await fetchTransfers(['EN_RUTA', 'LISTO_DESPACHO']);
    if (allFailed) { logError('entregas/list', errs[0]); list.innerHTML = apiErrorBox(errs); return; }
    list.innerHTML = rows.length ? '' : empty('No tienes entregas pendientes.');
    rows.forEach((t) => list.appendChild(entregaCard(t)));
  }
  function entregaCard(t) {
    const id = tId(t);
    const c = document.createElement('div'); c.className = 'rowcard col ent-card';
    renderEntregaCard(c, t, id);
    // Si el listado no trae los campos enriquecidos, completarlos desde el detalle.
    if (t.dest_sede == null && t.driver_name == null) {
      ApiClient.traspasoDetalle(id).then((r) => {
        const h = r?.data?.transfer || r?.data || {};
        renderEntregaCard(c, { ...t, ...h }, id);
      }).catch((e) => logError('entregas/detalle', e));
    }
    return c;
  }
  function renderEntregaCard(c, t, id) {
    c.innerHTML = '';
    const st = String(tState(t)).toUpperCase();
    const line = (ic, txt) => txt ? `<div class="ent-line"><span class="ent-ic">${ic}</span><span>${txt}</span></div>` : '';
    const veh = [t.vehicle_plate, t.vehicle_model].filter(Boolean).join(' · ');
    const head = document.createElement('div');
    head.innerHTML = `
      <div class="rowcard-top"><b>🚚 Traspaso #${id}</b>
        <span class="chip ${st === 'EN_RUTA' ? 'chip-amb' : ''}">${st.replace(/_/g, ' ')}</span></div>
      ${t.route_code ? `<div class="ent-ruta-code">${t.route_code}</div>` : ''}
      <div class="ent-route">${t.origin_sede || intNameById(originIntOf(t))} → <b>${t.dest_sede || intNameById(destIntOf(t))}</b>${t.dest_sede_type ? ` <small>(${t.dest_sede_type})</small>` : ''}</div>
      <div class="ent-body">
        ${line('👤', t.driver_name ? 'Conductor: ' + t.driver_name : '')}
        ${line('🚐', veh ? 'Vehículo: ' + veh : '')}
        ${line('🕐', t.route_dispatch_time ? 'Despacho: ' + fmtDT(t.route_dispatch_time) : '')}
        ${line('📦', t.origin_qr ? `Origen: ${t.origin_qr}${t.origin_area ? ' (' + t.origin_area + ')' : ''}` : '')}
        ${line('📬', t.dest_qr ? `Destino: ${t.dest_qr}${t.dest_area ? ' (' + t.dest_area + ')' : ''}` : '')}
        ${line('📝', t.notes ? 'Notas: ' + t.notes : '')}
        ${line('🧾', t.created_by_user ? `Creado por: ${t.created_by_user}${t.at_solicitado ? ' · ' + fmtDT(t.at_solicitado) : ''}` : '')}
      </div>`;
    c.appendChild(head);
    const det = document.createElement('div'); det.className = 'dash-det';
    det.innerHTML = '<div class="skel"></div>';
    transferItems(t).then((items) => {                       // contenido siempre visible
      det.innerHTML = items.length ? items.map((it) =>
        `<div class="dash-det-row"><span>${itemLabel(it)}</span><b>${it.quantity_dispatched ?? it.quantity_requested ?? 0}</b></div>`).join('')
        : '<div class="dash-det-row"><span>Sin ítems.</span></div>';
    }).catch(() => { det.innerHTML = '<div class="dash-det-row"><span>Sin ítems.</span></div>'; });
    const ctrls = document.createElement('div'); ctrls.className = 'rowcard-ctrls';
    const go = document.createElement('button'); go.className = 'btn-ok-sm'; go.textContent = 'MARCAR ENTREGADO';
    go.addEventListener('click', async () => {
      // deliver → PENDIENTE_RECEPCION: aparece en Recepción de Traspaso de la tienda.
      await sendTx('transporte_entregar', { traspaso_id: id }, 'Entregado. La tienda ya puede recibirlo.');
      openEntregas();
    });
    ctrls.append(go);
    c.append(det, ctrls);
  }
  async function openRecibir() {
    view('view-recibir');
    await ensureCatalogs(['locations', 'interlocutors']);
    const list = el('recibir-list'); list.innerHTML = skeleton();
    const { rows, errs, allFailed } = await fetchTransfers(['PENDIENTE_RECEPCION']);
    if (allFailed) { logError('recibir/list', errs[0]); list.innerHTML = apiErrorBox(errs); return; }
    const mine = Number(state.interlocutor);
    const mias = rows.filter((t) => { const d = destIntOf(t); return d == null || d === mine; });
    list.innerHTML = mias.length ? '' : empty('No hay entregas por recibir.');
    mias.forEach((t) => {
      const c = document.createElement('button'); c.className = 'rowcard';
      c.innerHTML = `<div><b>Traspaso #${tId(t)}</b>
        <small>Desde: ${t.origin_sede || intNameById(originIntOf(t))}${transferDate(t) ? ' · ' + fmtDT(transferDate(t)) : ''}</small></div>
        <span class="chip chip-amb">EN TRÁNSITO</span>`;
      c.addEventListener('click', () => openCierre(t).catch(() => {}));
      list.appendChild(c);
    });
  }
  async function openCierre(t) {
    let header = t, items = [];
    try {
      const r = await ApiClient.traspasoDetalle(tId(t));
      const d = r?.data ?? {}; header = d.transfer || t; items = d.items || d.details || [];
    } catch (e) { logError('cierre/detalle', e); items = await transferItems(t); }
    state.ctx = {
      traspaso: t, header,
      items: items.map((it) => ({ ...it, recibida: Number(it.quantity_dispatched ?? it.quantity_requested ?? 0), obs: '', done: false })),
    };
    view('view-cierre');
    el('cierre-title').textContent = `Recepción Traspaso #${tId(t)}`;
    el('cierre-sub').textContent = `Desde: ${header.origin_sede || intNameById(originIntOf(header))}${transferDate(header) ? ' · ' + fmtDT(transferDate(header)) : ''}`;
    const grid = el('cierre-grid'); grid.innerHTML = '';
    state.ctx.items.forEach((it, i) => {
      const env = Number(it.quantity_dispatched ?? it.quantity_requested ?? 0);
      const card = document.createElement('div'); card.className = 'ali-card'; card.id = `cie-card-${i}`;
      card.innerHTML = `
        <label class="ali-check"><input type="checkbox" id="cie-chk-${i}" /><b>${itemLabel(it)}</b></label>
        <div class="cie-qty-row">
          <span class="cie-qty-lbl">Cantidad enviada</span>
          <span class="cie-qty-big">${env}</span>
        </div>
        ${it.batch_reference ? `<div class="oc-card-sub">Lote ${it.batch_reference}</div>` : ''}
        <div class="field-label">Observación / novedad (si hay diferencia o daño)</div>
        <input id="cie-obs-${i}" class="txt" placeholder="Escribe aquí cualquier objeción o novedad…" />`;
      grid.appendChild(card);
      setTimeout(() => {
        const chk = el(`cie-chk-${i}`), obs = el(`cie-obs-${i}`);
        obs.addEventListener('input', () => { it.obs = obs.value; });
        chk.addEventListener('change', () => {
          it.done = chk.checked; card.classList.toggle('ali-done', chk.checked); updateCieProgress();
        });
      }, 0);
    });
    el('cie-all').checked = false;
    updateCieProgress();
  }
  function updateCieProgress() {
    const total = state.ctx.items.length;
    const done = state.ctx.items.filter((it) => it.done).length;
    el('cie-progress').textContent = `${done}/${total} revisados`;
    el('cierre-confirm').disabled = total === 0 || done < total;
  }
  function toggleCieAll(checked) {
    state.ctx.items.forEach((it, i) => {
      it.done = checked;
      const chk = el(`cie-chk-${i}`); if (chk) chk.checked = checked;
      const card = el(`cie-card-${i}`); if (card) card.classList.toggle('ali-done', checked);
    });
    updateCieProgress();
  }
  async function confirmCierre() {
    const items = state.ctx.items;
    if (!items.every((it) => it.done)) { toast('Marca todos los ítems como revisados.', 'warn'); return; }
    // La cantidad recibida = enviada (no editable). Las novedades van en observaciones.
    const notes = items.filter((it) => it.obs.trim()).map((it) => `${itemLabel(it)}: ${it.obs.trim()}`).join(' | ');
    const payload = {
      traspaso_id: tId(state.ctx.traspaso),
      reception_date: new Date().toISOString().slice(0, 10),
      notes,
      items: items.map((it) => {
        const o = { item_id: it.item_id, batch_id: it.batch_id, quantity_received: it.recibida };
        if (it.obs.trim()) o.notes = it.obs.trim();
        return o;
      }),
    };
    await sendTx('traspaso_cerrar', payload, 'Traspaso CERRADO. Stock recibido.');
    openRecibir();
  }

  /* Helpers de transfer (contrato v6.3.0) */
  function tId(t)    { return t.transfer_id ?? t.id; }
  function tState(t) { return t.state ?? t.estado ?? 'LISTO_DESPACHO'; }
  function itemLabel(it) { return it.name ?? it.item_name ?? it.sku_final_code ?? ('SKU ' + (it.item_id ?? '')); }

  /* ════════════════════════════════════════════════════════════════
     PANEL DE TRASPASOS · KPIs e histórico (perimetral por interlocutor)
     Informe histórico: muestra info sin importar el estado del SKU.
  ════════════════════════════════════════════════════════════════ */
  const DASH_STATES = ['SOLICITADO', 'EN_PICKING', 'LISTO_DESPACHO', 'EN_RUTA', 'PENDIENTE_RECEPCION', 'CERRADO'];
  async function openDashboard() {
    view('view-dashboard');
    el('dash-kpis').innerHTML = `<div class="skel"></div><div class="skel"></div>`;
    el('dash-states').innerHTML = '';
    el('dash-list').innerHTML = '';
    try {
      const r = await ApiClient.traspasos();        // sin filtro: todos los del interlocutor
      const rows = rowsOf(r.data);
      renderDashboard(rows);
    } catch (e) {
      logError('dashboard/load', e);
      renderDashboard([]);
    }
  }
  function renderDashboard(rows) {
    const total   = rows.length;
    const byState = Object.fromEntries(DASH_STATES.map((s) => [s, 0]));
    rows.forEach((t) => { const s = tState(t); if (s in byState) byState[s]++; });
    const cerrados = byState['CERRADO'];
    const enCurso  = total - cerrados;
    const pctCerr  = total ? Math.round((cerrados / total) * 100) : 0;

    el('dash-kpis').innerHTML = [
      kpiCard('Total traspasos', total, ''),
      kpiCard('En curso', enCurso, 'warn'),
      kpiCard('Cerrados', cerrados, 'ok'),
      kpiCard('% completado', pctCerr + '%', 'ok'),
    ].join('');

    // Desglose por estado (barras proporcionales)
    const max = Math.max(1, ...DASH_STATES.map((s) => byState[s]));
    el('dash-states').innerHTML = `<div class="perm-card-h" style="margin-bottom:8px;">Por estado</div>` +
      DASH_STATES.map((s) => {
        const n = byState[s], w = Math.round((n / max) * 100);
        return `<div class="dash-row">
          <span class="dash-row-lbl">${s.replace(/_/g, ' ')}</span>
          <span class="dash-bar"><i style="width:${w}%"></i></span>
          <span class="dash-row-n">${n}</span></div>`;
      }).join('');

    // Listado reciente (hasta 25)
    const list = el('dash-list');
    if (!total) { list.innerHTML = empty('Sin traspasos en tu tienda.'); return; }
    list.innerHTML = `<div class="perm-card-h" style="margin:14px 0 8px;">Detalle</div>`;
    rows.slice(0, 25).forEach((t) => {
      const n = itemCount(t);
      const c = document.createElement('div'); c.className = 'rowcard rowcard-exp';
      c.innerHTML = `<div><b>Traspaso #${tId(t)}</b><small>${n != null ? n + ' ítem(s)' : 'ver detalle'}${t.notes ? ' · ' + t.notes : ''}</small></div>
        <span class="chip">${tState(t).replace(/_/g, ' ')}</span>`;
      const det = document.createElement('div'); det.className = 'dash-det hidden';
      c.addEventListener('click', async () => {
        det.classList.toggle('hidden');
        if (!det.dataset.loaded) {
          det.innerHTML = '<div class="skel"></div>';
          const items = await transferItems(t);
          det.dataset.loaded = '1';
          det.innerHTML = items.length
            ? items.map((it) => `<div class="dash-det-row"><span>${it.item_name || it.name || ('SKU ' + (it.item_id ?? ''))}</span>
                <b>${it.quantity_requested ?? it.quantity ?? 0}</b></div>`).join('')
            : '<div class="dash-det-row"><span>Sin ítems.</span></div>';
        }
      });
      list.appendChild(c); list.appendChild(det);
    });
  }
  function kpiCard(label, value, tone) {
    return `<div class="kpi ${tone ? 'kpi-' + tone : ''}"><div class="kpi-v">${value}</div><div class="kpi-l">${label}</div></div>`;
  }

  /* ════════════════════════════════════════════════════════════════
     FLUJO 4 · MERMAS CON EVIDENCIA FOTOGRÁFICA
  ════════════════════════════════════════════════════════════════ */
  async function openMerma() {
    state.ctx = { foto: null };
    view('view-merma');
    el('merma-cant').value = '';
    el('merma-razon').value = '';
    el('merma-obs').value = '';
    el('merma-foto-prev').classList.add('hidden');
    el('merma-confirm').disabled = false;
    bindNumpad(el('merma-cant'));
    resetSkuSearch('merma-sku-q', 'merma-sku-res');
    el('merma-sku-q')._skuLoad();
  }
  async function captureMerma() {
    try {
      const b64 = await Scanner.capturePhoto(el('merma-cam'));
      state.ctx.foto = b64;
      const img = el('merma-foto-prev');
      img.src = b64; img.classList.remove('hidden');
    } catch (e) { logError('merma/foto', e); toast('No se pudo capturar la imagen.', 'err'); }
  }
  async function confirmMerma() {
    const item  = pickedSku('merma-sku-q');
    const cant  = Number(el('merma-cant').value);
    const unit  = el('merma-unidad').value;
    const razon = el('merma-razon').value;
    const obs   = el('merma-obs').value.trim();
    if (!item || !cant) { toast('Indica el producto y la cantidad.', 'warn'); return; }
    if (!razon) { toast('Selecciona el motivo.', 'warn'); return; }

    const consumo = razon === 'PARA_CONSUMO';
    // Para consumo interno el motivo debe ir EXACTO (el API detecta el caso especial).
    // location_id y batch_id los resuelve el API (zona_mermas + FEFO).
    const payload = {
      item_id: item,
      item_type: 'sku',
      quantity: Metrology.toBase(cant, unit),
      reason: consumo ? 'PARA_CONSUMO' : (obs ? `${razon} — ${obs}` : razon),
    };
    if (state.ctx.foto) payload.file_data = state.ctx.foto;   // evidencia opcional
    await sendTx('merma', payload,
      consumo ? 'Consumo interno registrado. Stock movido a COCINA.' : 'Merma registrada. Stock decrementado.');
    renderHub();
  }

  /* ════════════════════════════════════════════════════════════════
     ENVÍO TRANSACCIONAL (online → si falla red, Outbox)
  ════════════════════════════════════════════════════════════════ */
  async function sendTx(action, payload, okMsg) {
    try {
      const r = await Outbox.submit(action, payload);
      toast(r.queued ? 'Sin red: transacción retenida en cola.' : okMsg, r.queued ? 'warn' : 'ok');
    } catch (e) {
      logError('tx/' + action, e);
      if (e instanceof ApiClient.ApiError && e.type === ApiClient.ERR.UNAUTHORIZED) { doLogout(); return; }
      toast(e.message || 'Error al enviar.', 'err');
      throw e;
    }
  }

  /* ── Catálogos ────────────────────────────────────────────────── */
  async function ensureCatalog(resource) {
    if (state.catalogs[resource]?.length) return;
    try {
      if (resource === 'batches') {
        const r = await ApiClient.batches();
        state.catalogs.batches = rowsOf(r.data);
        return;
      }
      const map = { interlocutors: 'interlocutors', locations: 'locations', skus: 'skus', rutas: 'rutas' };
      const params = resource === 'skus' ? { status: 'active' } : {};
      const r = await ApiClient.catalog(map[resource] || resource, params);
      let rows = rowsOf(r.data);
      if (resource === 'skus') rows = rows.filter((s) => (s.status ?? 'active') === 'active');
      state.catalogs[resource] = rows;
    } catch (e) { logError('catalog/' + resource, e); state.catalogs[resource] = []; }
  }

  /* Carga varios catálogos y puebla los <select> de una vista atómica. */
  async function ensureCatalogs(list) { await Promise.all(list.map(ensureCatalog)); }

  function lblSku(r)   { return (r.name || r.nombre || ('SKU ' + r.id)) + (r.sku_final_code ? ' · ' + r.sku_final_code : ''); }
  function skuUnit(r)  { return r.unit_of_measure || r.unidad_base || 'ud'; }
  function lblLoc(r)   {
    const base = r.area_type ? `${r.area_type}${r.shelf ? ' ' + r.shelf : ''}${r.position ? '-' + r.position : ''}` : (r.nombre || r.name || ('Ubic. ' + r.id));
    return r.qr_code_uid ? `${base} · ${r.qr_code_uid}` : base;
  }
  function locQR(r)    { return r.qr_code_uid || r.codigo || r.qr || r.code; }
  function lblBatch(r) {
    const code = r.batch_reference || r.codigo_lote || r.lote || ('Lote ' + r.id);
    const exp  = r.expiration_date || r.fecha_caducidad;
    return exp ? `${code} · cad. ${exp}` : code;
  }
  function fillSelect(sel, rows, labelFn, placeholder) {
    sel.innerHTML = '';
    sel.add(new Option(placeholder || 'Selecciona…', ''));
    rows.forEach((r) => sel.add(new Option(labelFn(r), r.id)));
  }
  /* Lotes filtrados por SKU (FEFO): GET /inventory/batches?item_id= */
  async function batchesForSku(itemId, sel) {
    fillSelect(sel, [], lblBatch, 'Cargando lotes…');
    try {
      const r = await ApiClient.batches(itemId ? { item_id: itemId } : {});
      fillSelect(sel, rowsOf(r.data), lblBatch, 'Lote…');
    } catch (e) { logError('batches/sku', e); fillSelect(sel, [], lblBatch, 'Sin lotes'); }
  }

  const SKU_TYPES = [
    { v: 'FAV', t: 'Más usados',               c: '★ MÁS USADOS' },
    { v: '',   t: 'Todas las categorías',      c: 'TODOS' },
    { v: 'MP', t: 'MP · Materia prima',        c: 'MATERIA PRIMA' },
    { v: 'CD', t: 'CD · Consumo directo',      c: 'CONSUMO DIRECTO' },
    { v: 'PN', t: 'PN · No fabricado',         c: 'NO FABRICADO' },
    { v: 'PT', t: 'PT · Producto terminado',   c: 'TERMINADO' },
  ];
  /* Buscador de SKU (typeahead) — necesario con ~1000 SKUs activos.
     opts.persistent=true: muestra siempre el listado y la búsqueda lo filtra.
     opts.typeSelectId: <select> de categoría (item_type).
     Nota: para [1003] el API excluye item_type=PT por defecto; para ver TODAS las
     categorías se consulta también ?item_type=PT y se fusiona. */
  function wireSkuSearch(inputId, resultsId, onPick, opts = {}) {
    const input = el(inputId), res = el(resultsId);
    const persistent = !!opts.persistent;
    const typeSel = opts.typeSelectId ? el(opts.typeSelectId) : null;
    let timer = null;
    input.autocomplete = 'off';
    input.dataset.skuId = '';
    const render = (rows) => {
      res.innerHTML = '';
      if (!rows.length) { res.innerHTML = '<div class="sku-empty">Sin coincidencias</div>'; res.classList.add('open'); return; }
      rows.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sku-opt sku-opt2'; b.dataset.id = String(s.id);
        const name = document.createElement('span'); name.className = 'sku-opt-n';
        name.textContent = s.name || s.nombre || ('SKU ' + s.id);
        b.appendChild(name);
        const meta = [s.sku_final_code, s.item_type].filter(Boolean).join(' · ');
        if (meta) {
          const code = document.createElement('span'); code.className = 'sku-opt-c';
          code.textContent = meta; b.appendChild(code);
        }
        b.addEventListener('click', () => {
          input.dataset.skuId = String(s.id);
          res.querySelectorAll('.sku-opt').forEach((o) => o.classList.remove('sel'));
          b.classList.add('sel');
          if (!persistent) { input.value = lblSku(s); res.classList.remove('open'); }
          if (onPick) onPick(s);
        });
        res.appendChild(b);
      });
      res.classList.add('open');
    };
    const query = async (q) => {
      const type = typeSel ? typeSel.value : '';
      const base = { status: 'active', limit: 200 };
      if (q) base.q = q;
      try {
        let rows;
        if (type) {
          rows = rowsOf((await ApiClient.catalog('skus', { ...base, item_type: type })).data);
        } else {
          const [gen, pt] = await Promise.all([   // sin item_type el API omite PT
            ApiClient.catalog('skus', base).catch(() => ({ data: [] })),
            ApiClient.catalog('skus', { ...base, item_type: 'PT' }).catch(() => ({ data: [] })),
          ]);
          const seen = new Set();
          rows = [...rowsOf(gen.data), ...rowsOf(pt.data)]
            .filter((s) => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
        }
        rows = rows.filter((s) => (s.status ?? 'active') === 'active')
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        render(rows);
      } catch (e) { logError('sku/search', e); }
    };
    input.addEventListener('input', () => {
      input.dataset.skuId = '';
      const q = input.value.trim();
      clearTimeout(timer);
      if (persistent) { timer = setTimeout(() => query(q), 250); return; }
      if (q.length < 2) { res.innerHTML = ''; res.classList.remove('open'); return; }
      timer = setTimeout(() => query(q), 250);
    });
    if (typeSel) typeSel.addEventListener('change', () => query(input.value.trim()));
    if (!persistent) {
      // Evita que al pulsar una opción el input pierda foco y se cierre antes del clic.
      res.addEventListener('mousedown', (e) => e.preventDefault());
      input.addEventListener('blur', () => setTimeout(() => res.classList.remove('open'), 180));
    }
    input._skuLoad = () => query('');     // cargar listado inicial (modo persistente)
  }
  function pickedSku(inputId) { return Number(el(inputId).dataset.skuId || 0); }
  function resetSkuSearch(inputId, resultsId) {
    const i = el(inputId); i.value = ''; i.dataset.skuId = '';
    const r = resultsId ? el(resultsId) : null;
    if (r) { r.querySelectorAll('.sku-opt.sel').forEach((o) => o.classList.remove('sel')); }
    if (i._skuLoad && r && r.classList.contains('open')) i._skuLoad();   // recargar lista persistente
    else if (r) { r.innerHTML = ''; r.classList.remove('open'); }
  }

  /* ── Offline / Outbox UI + parada de emergencia ───────────────── */
  function refreshOfflineBadge() {
    const n = Outbox.count();
    const badge = el('offline-badge');
    const offline = !navigator.onLine || n > 0;
    badge.classList.toggle('hidden', !offline);
    el('offline-count').textContent = String(n);
  }
  function wireOutboxEvents() {
    window.addEventListener('online',  refreshOfflineBadge);
    window.addEventListener('offline', refreshOfflineBadge);
    window.addEventListener('outbox:change',  refreshOfflineBadge);
    window.addEventListener('outbox:drained', () => { refreshOfflineBadge(); toast('Cola sincronizada.', 'ok'); });
    window.addEventListener('outbox:halt', (ev) => emergencyStop(ev.detail));
  }
  function emergencyStop({ item, error }) {
    refreshOfflineBadge();
    el('emg-msg').textContent = `Transacción "${item.action}" rechazada: ${error?.message || 'regla del Kardex'}.`;
    el('view-emergency').classList.remove('hidden');
    Sound.alarm();
  }

  /* ── Helpers de render ────────────────────────────────────────── */
  function rowsOf(data) {
    return data?.data?.rows || data?.rows || data?.data || (Array.isArray(data) ? data : []) || [];
  }
  const skeleton = () => `<div class="skel"></div><div class="skel"></div><div class="skel"></div>`;
  const empty = (msg, isErr = false) =>
    `<div class="empty ${isErr ? 'empty-err' : ''}">${msg || 'Sin datos.'}</div>`;
  function setBusy(id, busy) {
    const b = el(id); if (!b) return;
    b.disabled = busy; b.dataset.busy = busy ? '1' : '';
  }
  function setBusyEl(b, busy) { if (b) { b.disabled = busy; b.dataset.busy = busy ? '1' : ''; } }

  /* ── Cableado de botones estáticos ────────────────────────────── */
  function wireStatic() {
    el('hdr-logout').addEventListener('click', doLogout);
    el('hdr-menu-btn').addEventListener('click', openDrawer);
    el('drawer-overlay').addEventListener('click', closeDrawer);
    el('drawer-logout').addEventListener('click', () => { closeDrawer(); doLogout(); });
    el('drawer-hub').addEventListener('click', () => { closeDrawer(); renderHub(); });
    el('drawer-dashboard').addEventListener('click', () => { closeDrawer(); openDashboard(); });
    el('drawer-permisos').addEventListener('click', () => { closeDrawer(); openPermisos(); });
    $$('[data-back]').forEach((b) => b.addEventListener('click', renderHub));
    el('oc-save').addEventListener('click', () => saveOC().catch(() => {}));
    el('oc-back').addEventListener('click', () => openRecepcion().catch(() => {}));
    el('ubicar-scan').addEventListener('click', scanUbicacion);
    el('ubicar-confirm').addEventListener('click', () => confirmUbicar().catch(() => {}));
    // Buscadores de SKU (typeahead). Ubicar/merma recargan lotes al elegir.

    // Buscador y filtro de categoría de la solicitud (recarga las tarjetas).
    let solTimer = null;
    el('sol-sku-q').addEventListener('input', () => {
      if (state.ctx.tipo === 'FAV' && el('sol-sku-q').value.trim()) {   // buscar => salir de "Más usados"
        state.ctx.tipo = ''; renderSolChips();
      }
      clearTimeout(solTimer); solTimer = setTimeout(() => loadSolSkus().catch(() => {}), 250);
    });
    el('sol-total').addEventListener('click', () => el('sol-sheet').classList.toggle('hidden'));
    wireSkuSearch('ubicar-sku-q', 'ubicar-sku-res', (s) => batchesForSku(s.id, el('ubicar-batch')));
    wireSkuSearch('merma-sku-q', 'merma-sku-res', null, { persistent: true });
    el('sol-confirm').addEventListener('click', () => confirmSolicitar().catch(() => {}));
    el('alistar-confirm').addEventListener('click', () => confirmAlistar().catch(() => {}));
    el('ali-all').addEventListener('change', (e) => toggleAliAll(e.target.checked));
    el('cierre-confirm').addEventListener('click', () => confirmCierre().catch(() => {}));
    el('cie-all').addEventListener('change', (e) => toggleCieAll(e.target.checked));
    el('merma-capture').addEventListener('click', captureMerma);
    el('merma-confirm').addEventListener('click', () => confirmMerma().catch(() => {}));
    el('perm-save').addEventListener('click', () => savePermisos().catch(() => {}));
    el('emg-discard').addEventListener('click', () => { Outbox.discardHead(); el('view-emergency').classList.add('hidden'); });
    el('emg-resume').addEventListener('click',  () => { Outbox.resume();      el('view-emergency').classList.add('hidden'); });
    el('numpad-close').addEventListener('click', () => el('numpad').classList.add('hidden'));
  }

  return { boot, wireStatic };
})();

document.addEventListener('DOMContentLoaded', () => { App.wireStatic(); App.boot(); });
