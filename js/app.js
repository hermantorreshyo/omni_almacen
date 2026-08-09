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
    // Al abandonar la solicitud, vaciar los cambios pendientes del borrador.
    const solActivo = el('view-solicitar') && !el('view-solicitar').classList.contains('hidden');
    if (solActivo && id !== 'view-solicitar' && state.ctx && state.ctx.timers) flushDraft().catch(() => {});
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
        if (!state.interlocutorName && state.interlocutor) {   // red de seguridad
          try {
            await ensureCatalog('interlocutors');
            const me = (state.catalogs.interlocutors || []).find((x) => Number(x.id) === Number(state.interlocutor));
            if (me) state.interlocutorName = intName(me);
          } catch (_) {}
        }
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
      const nombreSede = sel.selectedOptions[0] ? sel.selectedOptions[0].text : null;
      // Re-login con la sede elegida → JWT con el rol de ESA sede (API CORE v6.8).
      const r = await ApiClient.loginSede(state._creds.usuario, state._creds.password, id, nombreSede);
      setIdentity(r.data);
      state.interlocutor = id;
      state.interlocutorName = (r.data && r.data.interlocutor_name) || nombreSede;
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
    state.interlocutorType = null;   // se recalcula por sede (requestable_for)
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
    entregas:   { t: 'Mis Rutas',                 d: 'Tiendas y productos de tus rutas', area: 'transporte', go: openEntregas },
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
    renderRutaBanner(visible);
  }
  /* Banner de ruta del día en el home, para quien reparte (tiene "Mis Rutas"). */
  async function renderRutaBanner(visible) {
    const box = el('hub-ruta'); if (!box) return;
    const v = visible || visibleTiles();
    const esConductor = isSuperAdmin() || v.includes('entregas');
    if (!esConductor) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="hub-ruta-load">Cargando tu ruta de hoy…</div>';
    try {
      const r = await ApiClient.misRutas();
      const routes = (r.data && (r.data.routes || r.data)) || [];
      const grp = routes.find((g) => g.delivery_route && g.delivery_route.name) || null;
      const dr = grp ? grp.delivery_route : null;
      const nombre = dr ? dr.name : null;
      const rutaId = dr ? dr.id : null;
      const pendientes = routes.reduce((n, g) => n + ((g.stops || []).length), 0);
      // ¿Ruta ya iniciada? El core lo refleja en el grupo; respaldo local por si el
      // conductor acaba de iniciarla en esta sesión.
      // Fuente de verdad: el core expone is_started/can_change explícitos (v6.16).
      const iniciada = dr ? (dr.is_started === true || dr.can_change === false) : false;
      let acciones = '';
      if (!nombre) {
        acciones = '<button id="hub-ruta-btn" class="btn-amber-sm">Elegir ruta</button>';
      } else if (iniciada) {
        acciones = '<span class="hub-ruta-started">● En curso</span>';
      } else {
        acciones = `<div class="hub-ruta-acts">
          <button id="hub-ruta-start" class="btn-prim-sm">Iniciar ruta</button>
          <button id="hub-ruta-btn" class="btn-amber-sm">Cambiar</button></div>`;
      }
      box.innerHTML = `
        <div class="hub-ruta-main">
          <div class="hub-ruta-k">Ruta de hoy</div>
          <div class="hub-ruta-v">${nombre || 'Sin ruta seleccionada'}</div>
          ${nombre ? `<div class="hub-ruta-sub">${pendientes} entrega${pendientes === 1 ? '' : 's'} pendiente${pendientes === 1 ? '' : 's'}${iniciada ? ' · iniciada' + (dr && dr.started_at ? ' ' + fmtDT(dr.started_at) : '') : ''}</div>` : ''}
        </div>
        ${acciones}`;
      const bChg = el('hub-ruta-btn'); if (bChg) bChg.addEventListener('click', () => openRutaSelector());
      const bStart = el('hub-ruta-start'); if (bStart) bStart.addEventListener('click', () => iniciarRutaHoy(rutaId, nombre));
    } catch (e) {
      logError('hub/ruta', e);
      box.innerHTML = `<div class="hub-ruta-main"><div class="hub-ruta-v">Ruta de hoy</div></div>
        <button id="hub-ruta-btn" class="btn-amber-sm">Elegir ruta</button>`;
      el('hub-ruta-btn').addEventListener('click', () => openRutaSelector());
    }
  }
  async function iniciarRutaHoy(rutaId, nombre) {
    if (rutaId == null) { toast('Primero elige una ruta.', 'warn'); return; }
    if (!confirm(`Al iniciar la ruta "${nombre || rutaId}" ya no podrás cambiarla hoy. ¿Iniciar?`)) return;
    try {
      await ApiClient.iniciarRuta(rutaId);
      toast('Ruta iniciada. ¡Buen viaje!', 'ok');
      renderHub();   // el próximo routes/mine trae is_started=true (fuente de verdad)
    } catch (e) { logError('ruta/iniciar', e); toast(e.message || 'No se pudo iniciar la ruta.', 'err'); }
  }
  /* Selector de ruta del día: lista rutas con su disponibilidad (today_driver). */
  /* Historial de rutas ejecutadas (v6.15). Un solo endpoint; el core filtra por rol. */
  function openRutaHist() {
    view('view-ruta-hist');
    const t = new Date(), f = new Date(Date.now() - 7 * 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    if (!el('rh-from').value) el('rh-from').value = iso(f);
    if (!el('rh-to').value) el('rh-to').value = iso(t);
    loadRutaHist();
  }
  async function loadRutaHist() {
    const list = el('rh-list'); list.innerHTML = skeleton();
    const q = {};
    if (el('rh-from').value) q.date_from = el('rh-from').value;
    if (el('rh-to').value) q.date_to = el('rh-to').value;
    try {
      const r = await ApiClient.rutaHistorial(q);
      const rows = rowsOf(r.data)
        .sort((a, b) => String(b.assignment_date || '').localeCompare(String(a.assignment_date || '')));
      if (!rows.length) { list.innerHTML = empty('Sin rutas en el rango seleccionado.'); return; }
      list.innerHTML = '';
      rows.forEach((h) => list.appendChild(rutaHistCard(h)));
    } catch (e) { logError('ruta-hist', e); list.innerHTML = apiErrorBox([e]); }
  }
  function rutaHistCard(h) {
    const c = document.createElement('div'); c.className = 'rowcard col';
    const dels = h.deliveries || [];
    const fecha = h.assignment_date || '';
    // route_source: "ruta_por_defecto" (lo normal) o "seleccionada_ese_dia".
    const porDefecto = h.route_source === 'ruta_por_defecto';
    const origen = porDefecto ? 'Ruta por defecto' : 'Ruta elegida';
    // started_at puede ser null cuando operó con su ruta por defecto (no es un error).
    const inicio = h.started_at ? ('Inicio ' + fmtDT(h.started_at)) : (porDefecto ? 'Sin inicio explícito' : 'Sin iniciar');
    c.innerHTML = `<div class="rowcard-top"><b>${h.route_name || ('Ruta ' + (h.route_id ?? ''))}</b>
        <span class="chip">${fecha}</span></div>
      <small class="tp-sub">${h.driver_name || 'Conductor ' + (h.driver_user_id ?? '')} · ${origen} · ${inicio} · ${dels.length} entrega${dels.length === 1 ? '' : 's'}</small>`;
    const det = document.createElement('div'); det.className = 'dash-det';
    if (!dels.length) det.innerHTML = '<div class="td-empty">Sin entregas registradas.</div>';
    else dels.forEach((d) => {
      const row = document.createElement('div'); row.className = 'td-item';
      const enRuta = d.at_en_ruta ? fmtDT(d.at_en_ruta) : '—';
      const entregado = d.at_pendiente_recepcion ? fmtDT(d.at_pendiente_recepcion) : '—';
      row.innerHTML = `<div class="td-item-main">
          <div class="td-item-meta">Traspaso #${d.transfer_id}</div>
          <div class="td-item-name">${d.dest_name || ('Tienda ' + (d.dest_interlocutor_id ?? ''))}</div>
        </div>
        <div class="rh-times"><span>Salió: ${enRuta}</span><span>Entregó: ${entregado}</span></div>`;
      det.appendChild(row);
    });
    c.appendChild(det);
    return c;
  }
  async function openRutaSelector() {
    view('view-ruta-sel');
    const list = el('ruta-sel-list'); list.innerHTML = skeleton();
    try {
      const r = await ApiClient.deliveryRoutes();
      const rutas = rowsOf(r.data);
      if (!rutas.length) { list.innerHTML = empty('No hay rutas configuradas.'); return; }
      const miId = Number(state.user && (state.user.user_id ?? state.user.id));
      list.innerHTML = '';
      rutas.forEach((rt) => {
        const tomadaPor = rt.today_driver_id ?? null;
        const libre = tomadaPor == null;
        const mia = tomadaPor != null && Number(tomadaPor) === miId;
        const card = document.createElement('div'); card.className = 'rowcard col rsel-card' + (mia ? ' rsel-mine' : '');
        const estado = mia ? '✓ Es tu ruta de hoy' : (libre ? 'Libre' : `Tomada por ${rt.today_driver_name || 'otro conductor'}`);
        card.innerHTML = `<div class="rowcard-top"><b>${rt.name || ('Ruta ' + rt.id)}</b>
          <span class="chip ${mia ? '' : (libre ? 'chip-ok' : 'chip-amb')}">${estado}</span></div>
          <small class="tp-sub">${[rt.origin_name ? 'Sale de ' + rt.origin_name : null, rt.stores_count != null ? rt.stores_count + ' tienda' + (rt.stores_count === 1 ? '' : 's') : null].filter(Boolean).join(' · ')}</small>`;
        if (!mia) {
          const btn = document.createElement('button');
          btn.className = libre ? 'btn-prim-sm' : 'btn-amber-sm';
          btn.textContent = libre ? 'Tomar esta ruta' : 'Tomar (ya asignada)';
          btn.addEventListener('click', () => tomarRuta(rt, libre));
          const ctr = document.createElement('div'); ctr.className = 'rowcard-ctrls'; ctr.appendChild(btn);
          card.appendChild(ctr);
        }
        list.appendChild(card);
      });
    } catch (e) { logError('ruta-sel', e); list.innerHTML = apiErrorBox([e]); }
  }
  async function tomarRuta(rt, libre) {
    if (!libre && !confirm('Esta ruta ya fue tomada por otro conductor hoy. ¿Tomarla de todas formas?')) return;
    try {
      await ApiClient.seleccionarRuta(rt.id);
      toast(`Ahora trabajas la ruta "${rt.name || rt.id}" hoy.`, 'ok');
      renderHub();   // vuelve al home con el banner actualizado
    } catch (e) {
      logError('ruta-sel/tomar', e);
      // 409 ERR_STATE: la ruta ya la tomó otro conductor hoy.
      toast(e.message || 'No se pudo tomar la ruta.', e.code === 'ERR_STATE' ? 'warn' : 'err');
      openRutaSelector();
    }
  }
  /* Muestra en el menú los accesos según permisos (dashboard / gestor_permisos). */
  function renderDrawer(visible) {
    const v = visible || visibleTiles();
    const dash = el('drawer-dashboard'), perm = el('drawer-permisos');
    if (dash) dash.classList.toggle('hidden', !v.includes('dashboard'));
    if (perm) perm.classList.toggle('hidden', !v.includes('gestor_permisos'));
    const mh = el('drawer-merma-hist');
    if (mh) mh.classList.toggle('hidden', !v.includes('merma'));   // mismo permiso que registrar merma
    const rh = el('drawer-ruta-hist');
    if (rh) rh.classList.toggle('hidden', !(isSuperAdmin() || v.includes('entregas') || v.includes('transporte')));
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

  /* ── Cambiar contraseña ───────────────────────────────────────────── */
  function pwPolicy(pw) {
    const user = (state.user?.username || state.user?.nombre || '').toLowerCase();
    return {
      len: pw.length >= 8 && pw.length <= 72,
      letter: /[a-zA-Z\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc\u00f1\u00c1\u00c9\u00cd\u00d3\u00da\u00dc\u00d1]/.test(pw),
      num: /[0-9]/.test(pw),
      user: pw.length > 0 && pw.toLowerCase() !== user,
    };
  }
  function openPassword() {
    view('view-password');
    ['pw-cur', 'pw-new', 'pw-conf'].forEach((id) => { el(id).value = ''; });
    el('pw-msg').textContent = ''; el('pw-msg').className = 'pw-msg';
    updatePwRules();
  }
  function updatePwRules() {
    const p = pwPolicy(el('pw-new').value);
    const set = (id, ok) => { const e = el(id); if (e) e.className = ok ? 'ok' : ''; };
    set('pw-r-len', p.len); set('pw-r-letter', p.letter); set('pw-r-num', p.num); set('pw-r-user', p.user);
    const conf = el('pw-conf').value;
    const match = conf.length > 0 && conf === el('pw-new').value;
    const ok = p.len && p.letter && p.num && p.user && match && el('pw-cur').value.length > 0;
    el('pw-submit').disabled = !ok;
    return ok;
  }
  async function submitPassword() {
    const cur = el('pw-cur').value, nw = el('pw-new').value, cf = el('pw-conf').value;
    const msg = el('pw-msg');
    if (nw !== cf) { msg.textContent = 'La confirmaci\u00f3n no coincide.'; msg.className = 'pw-msg err'; return; }
    const p = pwPolicy(nw);
    if (!(p.len && p.letter && p.num && p.user)) { msg.textContent = 'La nueva contrase\u00f1a no cumple la pol\u00edtica.'; msg.className = 'pw-msg err'; return; }
    setBusy('pw-submit', true);
    try {
      await ApiClient.changePassword({ current_password: cur, new_password: nw });
      msg.textContent = 'Contrase\u00f1a actualizada correctamente.'; msg.className = 'pw-msg ok';
      ['pw-cur', 'pw-new', 'pw-conf'].forEach((id) => { el(id).value = ''; });
      updatePwRules();
      toast('Contrase\u00f1a actualizada. Tus otras sesiones se cerraron.', 'ok');
      setTimeout(() => renderHub(), 1200);
    } catch (e) {
      logError('password/change', e);
      msg.textContent = e.message || 'No se pudo cambiar la contrase\u00f1a.'; msg.className = 'pw-msg err';
    } finally { setBusy('pw-submit', false); }
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
    state.ctx = { qty: {}, skus: [], stock: {}, fabricas: [], draftId: null, rows: {}, timers: {} };
    el('sol-notes').value = '';
    el('sol-ctx-user').textContent = state.user?.nombre || state.user?.username || '—';
    el('sol-ctx-int').textContent  = state.interlocutorName || ('Interlocutor ' + (state.interlocutor ?? '—'));
    el('sol-ctx-rol').textContent  = state.rol || '—';
    state.ctx.tipo = 'FAV';
    renderSolChips();
    el('sol-sku-q').value = '';
    el('sol-sheet').classList.add('hidden');
    setDraftStatus('');
    fillSelect(el('sol-origen'), [], intName, 'Cargando fábricas…');
    el('sol-sku-res').innerHTML = skeleton();
    updateSolCta();
    await loadFabricas();
    await resolveSolEndpoints();
    await recoverDraft();          // ¿hay un borrador en curso de esta tienda?
    await loadSolStock();
    await loadSolSkus();
    updateSolCta();
  }
  /* Recupera el BORRADOR abierto de la tienda (siempre al abrir la pantalla).
     El JWT ya scopea a la sede, no hace falta enviar interlocutor_id. */
  async function recoverDraft() {
    try {
      const r = await ApiClient.traspasos('BORRADOR');
      const draft = rowsOf(r.data)[0];
      if (!draft) return;
      state.ctx.draftId = tId(draft);
      const det = await ApiClient.traspasoDetalle(state.ctx.draftId);
      const items = det?.data?.items || det?.data?.details || [];
      state.ctx.draftMeta = state.ctx.draftMeta || {};
      items.forEach((it) => {
        const iid = String(it.item_id);
        state.ctx.qty[iid] = Number(it.quantity_requested ?? 0);
        if (it.id != null) state.ctx.rows[iid] = it.id;   // itemRowId real
        // Guardar metadatos del ítem para mostrar el NOMBRE en el resumen aunque el
        // SKU no esté en el catálogo cargado (mismo patrón que en mermas).
        state.ctx.draftMeta[iid] = {
          id: it.item_id,
          name: it.item_name || it.name || it.sku_name || null,
          sku_final_code: it.sku_final_code || it.item_code || '',
          unit_of_measure: it.unit_of_measure || it.unit || 'ud',
        };
      });
      if (det?.data?.transfer?.notes) el('sol-notes').value = det.data.transfer.notes;
      if (items.length) {
        setDraftStatus('saved');
        el('sol-sheet').classList.remove('hidden');   // muestra el resumen con lo pendiente
        toast(`Tienes una solicitud sin enviar (${items.length} ítem${items.length > 1 ? 's' : ''}). La continuamos.`, 'ok');
      }
    } catch (e) { logError('draft/recover', e); }
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
  /* Tipo de la sede activa (para requestable_for). Se resuelve una vez y se cachea. */
  async function sedeType() {
    if (state.interlocutorType) return state.interlocutorType;
    const id = state.interlocutor;
    if (!id) return null;
    try {
      const r = await ApiClient.catalog('interlocutors', {});
      const me = rowsOf(r.data).find((x) => Number(x.id) === Number(id));
      if (me && me.type) { state.interlocutorType = me.type; return me.type; }
    } catch (e) { logError('sede/type', e); }
    return null;
  }
  async function fetchAllSkus(base) {
    const type = await sedeType();
    if (type) base = { ...base, requestable_for: type };   // oculta SKU no solicitables por esta sede
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
        const st = await sedeType();
        const p = { ...base, item_type: type };
        if (st) p.requestable_for = st;
        rows = rowsOf((await ApiClient.catalog('skus', p)).data);
      } else {
        rows = await fetchAllSkus(base);   // incluye requestable_for + fusión con PT
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
      card.id = `sol-card-${s.id}`;
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
    scheduleDraftSync(id);                          // guardado incremental (debounced)
  }
  /* ── Guardado incremental (borrador) ─────────────────────────────────── */
  function setDraftStatus(s) {
    const el0 = el('sol-draft-status'); if (!el0) return;
    el0.textContent = s === 'saving' ? 'Guardando…' : s === 'saved' ? '✓ Guardado' : s === 'error' ? '⚠ Sin guardar' : '';
    el0.className = 'sol-draft-status' + (s === 'error' ? ' err' : s === 'saved' ? ' ok' : '');
  }
  function scheduleDraftSync(id) {
    if (!state.ctx.originLocId || !state.ctx.destLocId) return;   // sin endpoints no hay borrador
    state.ctx.timers = state.ctx.timers || {};
    clearTimeout(state.ctx.timers[id]);
    setDraftStatus('saving');
    // Primer ítem sin borrador aún → crear YA (no esperar al debounce), para que
    // no se pierda si el usuario sale enseguida. Los ajustes posteriores sí van debounced.
    const q = state.ctx.qty[id] || 0;
    if (q > 0 && !state.ctx.draftId && !state.ctx._creating && state.ctx.rows[String(id)] == null) {
      syncDraftItem(id).catch(() => {});
      return;
    }
    state.ctx.timers[id] = setTimeout(() => syncDraftItem(id).catch(() => {}), 600);
  }
  function ingestRows(d) {
    (d?.items || d?.details || []).forEach((it) => {
      if (it.item_id != null && it.id != null) state.ctx.rows[String(it.item_id)] = it.id;
    });
  }
  async function ensureDraft(firstId) {
    if (state.ctx.draftId) return state.ctx.draftId;
    if (state.ctx._creating) return state.ctx._creating;
    const body = {
      location_id_origin: state.ctx.originLocId,
      location_id_destination: state.ctx.destLocId,
      items: [{ item_id: Number(firstId), quantity_requested: state.ctx.qty[firstId] || 0 }],
      notes: el('sol-notes').value.trim(),
    };
    state.ctx._creating = ApiClient.draftCrear(body).then((r) => {
      const d = r?.data ?? {};
      state.ctx.draftId = d.transfer_id ?? d.id ?? null;
      ingestRows(d);
      state.ctx._creating = null;
      return state.ctx.draftId;
    }).catch((e) => { state.ctx._creating = null; throw e; });
    return state.ctx._creating;
  }
  async function syncDraftItem(id) {
    const q = state.ctx.qty[id] || 0;
    try {
      if (q > 0) {
        if (!state.ctx.draftId) {
          await ensureDraft(id);
          if (state.ctx.rows[String(id)] == null) await refreshDraftRows();
        } else if (state.ctx.rows[String(id)] == null) {
          const r = await ApiClient.draftItemsAdd({ transfer_id: state.ctx.draftId, items: [{ item_id: Number(id), quantity_requested: q }] });
          ingestRows(r?.data ?? {});
          if (state.ctx.rows[String(id)] == null) await refreshDraftRows();
        } else {
          await ApiClient.draftItemUpdate({ transfer_id: state.ctx.draftId, row_id: state.ctx.rows[String(id)], quantity_requested: q });
        }
      } else {
        const row = state.ctx.rows[String(id)];
        if (state.ctx.draftId && row != null) {
          await ApiClient.draftItemRemove(state.ctx.draftId, row);
          delete state.ctx.rows[String(id)];
        }
      }
      setDraftStatus('saved');
    } catch (e) {
      logError('draft/sync', e);
      // El core rechaza SKU no solicitables por este tipo de sede.
      if (e && (e.code === 'ERR_SKU_NOT_REQUESTABLE' || /no está disponible para solicitar/i.test(e.message || ''))) {
        delete state.ctx.qty[id];                    // deshacer la selección inválida
        const card = document.getElementById(`sol-card-${id}`);
        if (card) { const v = card.querySelector('.stp-val'); if (v) v.value = '0'; card.classList.remove('picked'); }
        toast(e.message || 'Ese ítem no puede solicitarse desde esta sede.', 'err');
        updateSolCta();
        return;
      }
      setDraftStatus('error'); throw e;
    }
  }
  async function refreshDraftRows() {
    if (!state.ctx.draftId) return;
    try { ingestRows((await ApiClient.traspasoDetalle(state.ctx.draftId))?.data ?? {}); }
    catch (e) { logError('draft/refresh', e); }
  }
  async function flushDraft() {
    Object.values(state.ctx.timers || {}).forEach(clearTimeout);
    for (const id of Object.keys(state.ctx.qty || {})) { try { await syncDraftItem(id); } catch (_) {} }
  }
  async function discardDraft() {
    if (!state.ctx.draftId) { state.ctx.qty = {}; state.ctx.rows = {}; renderSolCards(); updateSolCta(); return; }
    if (!confirm('¿Descartar el borrador y empezar de cero?')) return;
    try { await ApiClient.draftDescartar(state.ctx.draftId); } catch (e) { logError('draft/descartar', e); }
    state.ctx.draftId = null; state.ctx.qty = {}; state.ctx.rows = {};
    setDraftStatus(''); renderSolCards(); updateSolCta();
    toast('Borrador descartado.', 'ok');
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
      const s = byId[id] || (state.ctx.draftMeta && state.ctx.draftMeta[id]) || {};
      const unit = skuUnit(s);
      const r = document.createElement('div'); r.className = 'sol-sum-row';
      r.innerHTML = `<span class="sol-sum-n">${s.name || s.sku_final_code || ('SKU ' + id)}<span class="sol-sum-u">${s.sku_final_code || ''}</span></span>
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
    setBusy('sol-confirm', true);
    try {
      await flushDraft();                          // asegura que el borrador está al día
      freqBump(ids);
      if (state.ctx.draftId) {
        await ApiClient.draftEnviar({ transfer_id: state.ctx.draftId });   // BORRADOR → SOLICITADO
        toast('Solicitud enviada (SOLICITADO).', 'ok');
        renderHub();
      } else {
        // Fallback: si el borrador no se pudo crear, envío en una sola llamada.
        const payload = {
          location_id_origin: state.ctx.originLocId,
          location_id_destination: state.ctx.destLocId,
          items: ids.map((id) => ({ item_id: Number(id), item_type: 'sku', quantity_requested: state.ctx.qty[id] })),
          notes: el('sol-notes').value.trim(),
        };
        await ApiClient.traspasoSolicitar(payload);
        toast('Solicitud registrada (SOLICITADO).', 'ok');
        renderHub();
      }
    } catch (e) { logError('sol/enviar', e); toast(e.message || 'No se pudo enviar la solicitud.', 'err'); }
    finally { setBusy('sol-confirm', false); }
  }


  // Helpers de traspaso (resolver interlocutores y fecha)
  /* Política de visualización: el dato viaja a 4 decimales; en pantalla se muestra a 2. */
  function fmtQty(v) {
    const n = Number(v);
    if (!isFinite(n)) return '0';
    return (Math.round(n * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function intNameById(id) {
    const f = (state.catalogs.interlocutors || []).find((x) => Number(x.id) === Number(id));
    return f ? intName(f) : (id != null ? 'Interlocutor ' + id : '—');
  }
  /* Nombre del solicitante (destino) de un traspaso: usa campos del propio
     traspaso si vienen, y si no, resuelve por catálogo. */
  function solicitanteName(t) {
    return t.dest_sede || t.dest_interlocutor_name || t.interlocutor_name_dest ||
           t.destination_name || intNameById(destIntOf(t));
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

  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d)) return String(s);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
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
    // Consolidación SOLO de vista: agrupar por tienda destino + fecha (día).
    const groups = {};
    mias.forEach((t) => {
      const dest = destIntOf(t);
      const dia = String(transferDate(t) || '').slice(0, 10);
      const key = `${dest}|${dia}`;
      (groups[key] = groups[key] || { dest, dia, traspasos: [] }).traspasos.push(t);
    });
    const orden = Object.values(groups).sort((a, b) => String(b.dia).localeCompare(String(a.dia)));
    list.innerHTML = '';
    orden.forEach((g) => {
      const varios = g.traspasos.length > 1;
      const algunoEnPicking = g.traspasos.some((t) => String(tState(t)).toUpperCase() === 'EN_PICKING');
      const c = document.createElement('button'); c.className = 'rowcard';
      const badge = algunoEnPicking
        ? '<span class="chip chip-amb">EN PREPARACIÓN</span>'
        : '<span class="chip">SOLICITADO</span>';
      const nombre = g.traspasos[0].dest_sede || intNameById(g.dest);
      const sub = varios
        ? `${g.traspasos.length} pedidos${g.dia ? ' · ' + fmtDate(g.dia) : ''}`
        : `Traspaso #${tId(g.traspasos[0])}${g.dia ? ' · ' + fmtDate(g.dia) : ''}`;
      c.innerHTML = `<div><b>${nombre}</b><small>${sub}</small></div>${badge}`;
      c.addEventListener('click', () => openAlistarGroup(g).catch(() => {}));
      list.appendChild(c);
    });
  }
  /* Abre el picking consolidado de un grupo (varios traspasos de la misma tienda+fecha). */
  async function openAlistarGroup(g) {
    // Inicia (SOLICITADO→EN_PICKING) los traspasos que aún estén en SOLICITADO.
    for (const t of g.traspasos) {
      if (String(tState(t)).toUpperCase() !== 'EN_PICKING') {
        try { await ApiClient.pickingIniciar({ traspaso_id: tId(t) }); }
        catch (e) { if (e && e.code !== 'ERR_STATE') logError('picking/iniciar', e); }
      }
    }
    try {
      let header = g.traspasos[0], allItems = [];
      for (const t of g.traspasos) {
        let items = [];
        try {
          const r = await ApiClient.traspasoDetalle(tId(t));
          const d = r?.data ?? {};
          if (t === g.traspasos[0] && d.transfer) header = d.transfer;
          items = d.items || d.details || [];
        } catch (e) { logError('picking/detalle', e); items = await transferItems(t); }
        // Cada ítem recuerda a qué traspaso pertenece (rastro para guardar/despachar).
        items.forEach((it) => allItems.push(enrichPickItem(it, t)));
      }
      // El core ya entrega ordenado por traspaso; reordenamos el conjunto por área.
      state.ctx = {
        grupo: g, traspaso: g.traspasos[0], header, items: allItems,
        origenId: header.interlocutor_id_origin ?? originIntOf(header) ?? null,
        multi: g.traspasos.length > 1,
      };
      reordenarPorArea();
      renderAlistar();
    } catch (e) { logError('picking/abrir-grupo', e); toast(e.message || 'No se pudo abrir el alistado.', 'err'); }
  }
  /* Enriquece un ítem de picking con su área y el traspaso de origen. */
  function enrichPickItem(it, t) {
    const yaGuardado = it.quantity_picked != null;
    const picked = Number(it.quantity_picked ?? it.quantity_requested ?? 0);
    return {
      ...it,
      _tid: tId(t),                                     // traspaso al que pertenece
      areaId: it.area_id != null ? Number(it.area_id) : null,
      area: it.area_name || null,
      areaType: it.area_type || null,
      areaSeq: it.area_pick_sequence != null ? Number(it.area_pick_sequence) : null,
      sku_code: it.sku_final_code || '',
      despachada: picked,
      obs: it.picking_notes || '',
      nodespacho: picked <= 0 && yaGuardado,
      confirmed: yaGuardado,
      done: yaGuardado,
    };
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
      // v6.19: al abrir un SOLICITADO, mover a EN_PICKING de inmediato (PUT /picking {items:[]}),
      // para que un refresco no pierda que el picking empezó. Si ya está EN_PICKING
      // (otra pestaña/carrera), el core responde ERR_STATE → se ignora y se continúa.
      if (start) {
        try { await ApiClient.pickingIniciar({ traspaso_id: tId(t) }); }
        catch (e) { if (e && e.code !== 'ERR_STATE') logError('picking/iniciar', e); }
      }
      let header = t, items = [];
      try {
        const r = await ApiClient.traspasoDetalle(tId(t));
        const d = r?.data ?? {};
        header = d.transfer || t;
        items = d.items || d.details || [];
      } catch (e) { logError('picking/detalle', e); items = await transferItems(t); }
      const enriched = items.map((it) => {
        const yaGuardado = it.quantity_picked != null;   // el core ya tenía un valor guardado
        const picked = Number(it.quantity_picked ?? it.quantity_requested ?? 0);
        return {
          ...it,
          // v6.21: el picking agrupa por ÁREA (organización física), no por categoría.
          // v6.23: el área es una entidad real (area_id + area_name). Se agrupa por area_id.
          areaId: it.area_id != null ? Number(it.area_id) : null,   // null = "Sin Clasificar"
          area: it.area_name || null,                               // nombre para mostrar
          areaType: it.area_type || null,                           // descriptor secundario (ícono/color)
          areaSeq: it.area_pick_sequence != null ? Number(it.area_pick_sequence) : null,
          sku_code: it.sku_final_code || '',
          despachada: picked,
          obs: it.picking_notes || '',
          nodespacho: picked <= 0 && yaGuardado,           // reabre marcado si ya iba en 0
          confirmed: yaGuardado,                            // ya persistido en el core
          done: yaGuardado,                                 // restaura el check al reabrir
        };
      });
      // El core YA entrega los ítems ordenados (por área y su orden de recorrido; los
      // "Sin Clasificar" al final). No se reordena aquí.
      state.ctx = {
        traspaso: t, header, items: enriched,
        origenId: header.interlocutor_id_origin ?? originIntOf(header) ?? null,   // sede donde se hace el picking
      };
      renderAlistar();
    } catch (e) { logError('picking/abrir', e); toast(e.message || 'No se pudo abrir el alistado.', 'err'); }
  }
  /* Áreas reales de la sede de origen para el desplegable (v6.23). Cacheado por sede. */
  async function loadAreas(sedeId) {
    state._areasBySede = state._areasBySede || {};
    if (state._areasBySede[sedeId]) return state._areasBySede[sedeId];
    let arr = [];
    try {
      const r = await ApiClient.catalogAreas(sedeId);
      arr = Array.isArray(r.data) ? r.data : (r.data && r.data.areas) || [];
    } catch (e) { logError('picking/areas', e); }
    state._areasBySede[sedeId] = arr;
    return arr;
  }
  /* Nombre legible de un area_type (descriptor secundario). */
  function areaTipoNombre(a) {
    if (!a) return '';
    return String(a).replace(/_/g, ' ').replace(/^\\w/, (c) => c.toUpperCase());
  }
  /* Rellena el desplegable con las áreas reales de la sede. Devuelve cuántas hay. */
  async function fillAreaSelect(sel, sedeId) {
    const areas = await loadAreas(sedeId);
    areas.forEach((a) => {
      const o = document.createElement('option'); o.value = a.id; o.textContent = a.name || areaTipoNombre(a.area_type);
      o.dataset.name = a.name || areaTipoNombre(a.area_type); sel.appendChild(o);
    });
    return areas.length;
  }
  /* Clasifica un SKU "Sin Clasificar" en un área real (area_id), sede de ORIGEN. */
  async function clasificarItem(it, areaId, areaName, idx) {
    const sede = state.ctx.origenId;
    if (!sede) { toast('No se pudo determinar la sede de origen.', 'err'); return; }
    const sel = el(`ali-area-${idx}`); if (sel) sel.disabled = true;
    try {
      await ApiClient.clasificarSku({ sku_id: it.item_id, interlocutor_id: sede, area_id: areaId });
      it.areaId = Number(areaId);
      it.area = areaName || null;
      it.areaSeq = null;   // el orden fino lo define la sede; basta reubicar por área
      toast(`Clasificado en "${areaName || 'área'}".`, 'ok');
      reordenarPorArea();
      renderAlistar();
    } catch (e) {
      logError('picking/clasificar', e);
      toast(e.message || 'No se pudo clasificar el ítem.', 'err');
      if (sel) sel.disabled = false;
    }
  }
  /* Quita la clasificación de un ítem (vuelve a "Sin Clasificar"). */
  async function desclasificarItem(it, idx) {
    const sede = state.ctx.origenId;
    if (!sede) { toast('No se pudo determinar la sede de origen.', 'err'); return; }
    const sel = el(`ali-area-${idx}`); if (sel) sel.disabled = true;
    try {
      await ApiClient.clasificarSku({ sku_id: it.item_id, interlocutor_id: sede });   // sin area_id = quitar
      it.areaId = null; it.area = null; it.areaSeq = null;
      toast('Ítem devuelto a "Sin Clasificar".', 'ok');
      reordenarPorArea();
      renderAlistar();
    } catch (e) {
      logError('picking/desclasificar', e);
      toast(e.message || 'No se pudo quitar la clasificación.', 'err');
      if (sel) sel.disabled = false;
    }
  }
  /* Reordena los ítems del picking por área tras una clasificación manual. */
  function reordenarPorArea() {
    state.ctx.items.sort((a, b) => {
      const an = a.areaId == null, bn = b.areaId == null;
      if (an !== bn) return an ? 1 : -1;                 // Sin Clasificar al final
      const sa = a.areaSeq, sb = b.areaSeq;
      if (sa != null && sb != null && sa !== sb) return sa - sb;
      if (sa != null && sb == null) return -1;
      if (sa == null && sb != null) return 1;
      return String(a.area || '').localeCompare(String(b.area || '')) ||
             String(itemLabel(a)).localeCompare(String(itemLabel(b)));
    });
  }
  function renderAlistar() {
    view('view-alistar');
    const h = state.ctx.header;
    const g = state.ctx.grupo;
    const nombreDest = g ? (g.traspasos[0].dest_sede || intNameById(g.dest)) : intNameById(destIntOf(h));
    if (state.ctx.multi) {
      el('alistar-title').textContent = `Alistar · ${nombreDest}`;
      el('alistar-sub').textContent = `${g.traspasos.length} pedidos (${g.traspasos.map((t) => '#' + tId(t)).join(', ')})${g.dia ? ' · ' + fmtDate(g.dia) : ''}`;
    } else {
      el('alistar-title').textContent = `Alistar Traspaso #${tId(state.ctx.traspaso)}`;
      el('alistar-sub').textContent = `Solicita: ${nombreDest}${transferDate(h) ? ' · ' + fmtDT(transferDate(h)) : ''}`;
    }
    const grid = el('alistar-grid'); grid.innerHTML = '';
    // Agrupamiento por ÁREA real (v6.23): clave = area_id; encabezado = area_name.
    const areaLabel = (it) => it.area || 'Sin Clasificar';
    const areaCount = {};
    state.ctx.items.forEach((it) => { const k = it.areaId != null ? 'a' + it.areaId : '__none__'; areaCount[k] = (areaCount[k] || 0) + 1; });
    let lastArea = '__init__', catIdx = -1;
    const CAT_COLORS = ['#642a72', '#2563eb', '#0a7d54', '#b45309', '#be185d', '#0e7490', '#7c3aed'];
    state.ctx.items.forEach((it, i) => {
      const sol = Number(it.quantity_requested ?? 0);
      const areaKey = it.areaId != null ? 'a' + it.areaId : '__none__';
      if (areaKey !== lastArea) {                           // banda de área
        lastArea = areaKey; catIdx++;
        const color = it.areaId != null ? CAT_COLORS[catIdx % CAT_COLORS.length] : '#9ca3af';
        const hd = document.createElement('div'); hd.className = 'ali-cat' + (it.areaId != null ? '' : ' ali-cat-none');
        hd.style.setProperty('--cat', color);
        hd.innerHTML = `<span class="ali-cat-dot"></span><span class="ali-cat-name">${areaLabel(it)}</span><span class="ali-cat-n">${areaCount[areaKey]}</span>`;
        grid.appendChild(hd);
      }
      const color = it.area ? CAT_COLORS[catIdx % CAT_COLORS.length] : '#9ca3af';
      const card = document.createElement('div'); card.className = 'ali-card ali-grouped' + (it.nodespacho ? ' ali-nd-on' : '') + (it.done ? ' ali-done' : ''); card.id = `ali-card-${i}`;
      card.style.setProperty('--cat', color);
      card.innerHTML = `
        <label class="ali-check"><input type="checkbox" id="ali-chk-${i}" ${it.done ? 'checked' : ''} /><span class="ali-head">
          <span class="ali-meta">${[it.sku_code, it.category_name].filter(Boolean).join(' · ')}${state.ctx.multi ? ` · <b class="ali-ped">Pedido #${it._tid}</b>` : ''}</span>
          <b class="ali-name">${itemLabel(it)}</b>
        </span></label>
        <div class="ali-clasif${it.areaId != null ? ' ali-clasif-set' : ''}"><span class="ali-clasif-lbl">${it.areaId == null ? 'Clasificar en área:' : 'Área:'}</span><select id="ali-area-${i}" class="ali-area-sel"><option value="">${it.areaId == null ? 'Elegir área…' : 'Sin clasificar'}</option></select></div>
        <div class="oc-card-sub">Solicitada: <b>${fmtQty(sol)}</b>${it.batch_reference ? ` · Lote ${it.batch_reference}` : ''}</div>
        <div class="oc-row2">
          <div><div class="field-label">Despachada</div>
            <input id="ali-qty-${i}" class="num" type="number" min="0" step="0.01" inputmode="decimal" value="${it.despachada}" /></div>
          <div><div class="field-label">Observación</div><input id="ali-obs-${i}" class="txt" placeholder="Opcional…" value="${(it.obs || '').replace(/"/g, '&quot;')}" /></div>
        </div>
        <div id="ali-warn-${i}" class="ali-warn hidden">⚠️ Mayor al solicitado</div>
        <label class="ali-nd"><input type="checkbox" id="ali-nd-${i}" ${it.nodespacho ? 'checked' : ''} /><span>No despachado</span></label>`;
      grid.appendChild(card);
      setTimeout(() => {
        const q = el(`ali-qty-${i}`), chk = el(`ali-chk-${i}`), obs = el(`ali-obs-${i}`), warn = el(`ali-warn-${i}`), nd = el(`ali-nd-${i}`);
        const sync = () => {
          const v = Math.max(0, Number(q.value) || 0);      // sin tope superior; 0 permitido
          it.despachada = Math.round(v * 100) / 100;        // 2 decimales
          it.confirmed = true;                              // teclear = confirmar → se guarda
          warn.classList.toggle('hidden', it.despachada <= sol);
          const distinto = it.despachada !== sol;
          obs.classList.toggle('obs-req', distinto && !it.nodespacho);
          obs.placeholder = distinto ? 'Obligatoria: explica la diferencia…' : 'Opcional…';
          scheduleAliSave();                                // autoguardado
        };
        q.addEventListener('input', sync);
        obs.addEventListener('input', () => { it.obs = obs.value; it.confirmed = true; scheduleAliSave(); });
        nd.addEventListener('change', () => {
          it.nodespacho = nd.checked;
          card.classList.toggle('ali-nd-on', nd.checked);
          if (nd.checked) { it.despachada = 0; q.value = '0'; q.disabled = true; if (!obs.value.trim()) { obs.value = 'No despachado'; it.obs = 'No despachado'; } }
          else { q.disabled = false; }
          sync();
        });
        if (it.nodespacho) q.disabled = true;
        // Desplegable de área (en TODAS las tarjetas): permite clasificar o reubicar.
        const areaSel = el(`ali-area-${i}`);
        if (areaSel) {
          fillAreaSelect(areaSel, state.ctx.origenId).then((n) => {
            if (!n) {   // la sede de origen no tiene áreas configuradas
              const cont = areaSel.closest('.ali-clasif');
              if (cont) cont.innerHTML = '<span class="ali-clasif-empty">Esta sede no tiene áreas configuradas. Contacta al administrador.</span>';
              return;
            }
            if (it.areaId != null) areaSel.value = String(it.areaId);   // preselecciona el área actual
          });
          areaSel.addEventListener('change', () => {
            const opt = areaSel.selectedOptions[0];
            const val = areaSel.value;
            if (val === String(it.areaId ?? '')) return;   // sin cambios
            if (val) clasificarItem(it, val, opt ? (opt.dataset.name || opt.textContent) : '', i);
            else desclasificarItem(it, i);                  // "Sin clasificar" → quitar área
          });
        }
        chk.addEventListener('change', () => {
          it.done = chk.checked;
          card.classList.toggle('ali-done', chk.checked);
          // Marcar el ítem es confirmarlo: persistir su cantidad actual (tecleada o la
          // precargada por defecto). Antes esto no guardaba y se perdía el ítem al salir.
          if (chk.checked) { it.confirmed = true; scheduleAliSave(); }
          updateAliProgress();
        });
      }, 0);
    });
    el('ali-all').checked = false;
    updateAliProgress();
  }
  /* Autoguardado del alistamiento (PATCH /picking-items) — NO cambia de estado.
     El pedido pasa a LISTO_DESPACHO solo con el botón Confirmar. */
  function scheduleAliSave() {
    clearTimeout(state.ctx._aliTimer);
    setAliStatus('saving');
    state.ctx._aliTimer = setTimeout(() => {
      savePickingItems().then(() => setAliStatus('saved')).catch(() => setAliStatus('error'));
    }, 700);
  }
  function setAliStatus(s) {
    const e = el('ali-save-status'); if (!e) return;
    e.textContent = s === 'saving' ? 'Guardando…' : s === 'saved' ? '✓ Guardado' : s === 'error' ? '⚠ Sin guardar' : '';
    e.className = 'ali-save-status' + (s === 'error' ? ' err' : s === 'saved' ? ' ok' : '');
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
  /* Guarda el avance del picking (PATCH /picking-items, no cambia de estado).
     Permite alistar en varias visitas: el picker sale y vuelve sin perder lo hecho. */
  async function savePickingItems() {
    // Solo se guardan los ítems confirmados o no despachados. Se agrupan por traspaso
    // de origen (_tid) → un PATCH por traspaso, para soportar picking consolidado.
    const items = state.ctx.items.filter((it) => it.confirmed || it.nodespacho);
    if (!items.length) return { ok: true, data: null };
    const porTraspaso = {};
    items.forEach((it) => {
      const tid = it._tid ?? tId(state.ctx.traspaso);
      const q = it.nodespacho ? 0 : Math.round((Number(it.despachada) || 0) * 100) / 100;
      const o = { item_id: it.item_id, batch_id: it.batch_id, quantity_picked: q };
      const note = it.nodespacho
        ? ('NO DESPACHADO' + (it.obs.trim() && it.obs.trim() !== 'No despachado' ? ' — ' + it.obs.trim() : ''))
        : it.obs.trim();
      if (note) o.notes = note;
      (porTraspaso[tid] = porTraspaso[tid] || []).push(o);
    });
    const results = await Promise.all(Object.entries(porTraspaso).map(([tid, its]) =>
      ApiClient.pickingItems({ traspaso_id: Number(tid), items: its })));
    return results[0] || { ok: true, data: null };
  }
  async function guardarAvancePicking() {
    setBusy('alistar-save', true);
    try {
      const r = await savePickingItems();
      const n = r?.data?.items_updated;
      toast(n != null ? `Avance guardado (${n} ítems).` : 'Avance guardado.', 'ok');
    } catch (e) { logError('picking/avance', e); toast(e.message || 'No se pudo guardar el avance.', 'err'); }
    finally { setBusy('alistar-save', false); }
  }
  async function confirmAlistar() {
    const items = state.ctx.items;
    if (!items.every((it) => it.done)) { toast('Marca todos los ítems como alistados.', 'warn'); return; }
    const diff = items.find((it) => !it.nodespacho && Number(it.despachada) !== Number(it.quantity_requested ?? 0) && !it.obs.trim());
    if (diff) {
      const menor = Number(diff.despachada) < Number(diff.quantity_requested ?? 0);
      toast(`Observación obligatoria en "${itemLabel(diff)}" por despachar ${menor ? 'menos' : 'más'} de lo solicitado.`, 'warn');
      return;
    }

    const nd = items.filter((it) => it.nodespacho);

    // 1) Guardar la cantidad confirmada y la observación por ítem (un PATCH por traspaso).
    await savePickingItems();

    // 2) Despachar → LISTO_DESPACHO. Un PUT /dispatch por cada traspaso del grupo,
    //    con sus propios ítems y sus notas.
    const traspasos = state.ctx.grupo ? state.ctx.grupo.traspasos : [state.ctx.traspaso];
    const buildNotes = (its) => its.filter((it) => it.obs.trim() || it.nodespacho)
      .map((it) => `${itemLabel(it)}: ${it.nodespacho ? 'NO DESPACHADO' : ''}${it.obs.trim() && it.obs.trim() !== 'No despachado' ? (it.nodespacho ? ' — ' : '') + it.obs.trim() : ''}`)
      .join(' | ');
    try {
      for (const t of traspasos) {
        const tid = tId(t);
        const its = items.filter((it) => (it._tid ?? tid) === tid);
        if (!its.length) continue;
        const payload = {
          traspaso_id: tid,
          notes: buildNotes(its),
          items: its.map((it) => {
            const q = it.nodespacho ? 0 : Math.round((Number(it.despachada) || 0) * 100) / 100;
            const o = { item_id: it.item_id, batch_id: it.batch_id, quantity_dispatched: q };
            const note = it.nodespacho ? ('NO DESPACHADO' + (it.obs.trim() && it.obs.trim() !== 'No despachado' ? ' — ' + it.obs.trim() : '')) : it.obs.trim();
            if (note) o.notes = note;
            return o;
          }),
        };
        await ApiClient.pickingAlistar(payload);   // PUT /dispatch por traspaso
      }
      if (nd.length) toast(`${nd.length} ítem(s) marcados como NO DESPACHADO.`, 'warn');
      toast(traspasos.length > 1 ? `${traspasos.length} pedidos despachados.` : 'Traspaso LISTO_DESPACHO (en tránsito).', 'ok');
      openPicking();
    } catch (e) { logError('picking/despachar', e); toast(e.message || 'No se pudo despachar.', 'err'); }
  }

  // D) Transportista: pedidos listos para transportar / en ruta (origen = mi sede).
  async function openTransporte() {
    view('view-transporte');
    const list = el('transporte-list'); list.innerHTML = skeleton();
    // Tablero de monitoreo de SOLO LECTURA (v6.13): pedidos LISTO_DESPACHO / EN_RUTA
    // de todos los conductores. Sin acciones. Requiere logistics.dispatch (Chofer Logístico).
    try {
      const r = await ApiClient.transportMonitor();
      const rows = rowsOf(r.data);
      if (!rows.length) { list.innerHTML = empty('No hay pedidos en ruta en este momento.'); return; }
      // Ordenar: primero EN_RUTA, luego LISTO_DESPACHO; dentro, por ruta y destino.
      const rank = (s) => (String(s).toUpperCase() === 'EN_RUTA' ? 0 : 1);
      rows.sort((a, b) => rank(a.state) - rank(b.state)
        || String(a.delivery_route_name || '').localeCompare(String(b.delivery_route_name || ''))
        || String(a.dest_name || '').localeCompare(String(b.dest_name || '')));
      list.innerHTML = '';
      rows.forEach((m) => list.appendChild(monitorCard(m)));
    } catch (e) {
      logError('transporte/monitor', e);
      if (e && e.code === 'ERR_FORBIDDEN') { list.innerHTML = empty('No tienes permiso para ver el monitoreo de transporte.'); return; }
      list.innerHTML = apiErrorBox([e]);
    }
  }
  /* Fila del tablero de monitoreo (solo lectura, sin botones de acción). */
  function monitorCard(m) {
    const st = String(m.state || '').toUpperCase();
    const c = document.createElement('div'); c.className = 'rowcard col mon-card';
    const driver = m.driver_name || m.driver_username || 'Sin conductor';
    const ruta = m.delivery_route_name || (m.is_manual_override ? 'Asignación manual' : '—');
    const tEnv = m.at_listo_despacho ? fmtDT(m.at_listo_despacho) : null;
    const tRuta = m.at_en_ruta ? fmtDT(m.at_en_ruta) : null;
    c.innerHTML = `<div class="rowcard-top"><b>${m.dest_name || ('Tienda ' + (m.dest_interlocutor_id ?? ''))}</b>
      <span class="chip ${st === 'EN_RUTA' ? 'chip-amb' : ''}">${st.replace(/_/g, ' ')}</span></div>
      <small class="tp-sub">Traspaso #${m.transfer_id} · ${ruta}${m.is_manual_override ? ' · manual' : ''}</small>
      <div class="mon-row"><span class="mon-k">Conductor</span><span class="mon-v">${driver}</span></div>
      ${tEnv ? `<div class="mon-row"><span class="mon-k">Enviado</span><span class="mon-v">${tEnv}</span></div>` : ''}
      ${tRuta ? `<div class="mon-row"><span class="mon-k">En ruta</span><span class="mon-v">${tRuta}</span></div>` : ''}`;
    return c;
  }

  // F) Repartidor: entregas en tránsito de su sede → marcar entregado.
  async function openEntregas() { return openRutaHoy(); }
  async function openRutaHoy() {
    view('view-entregas');
    const wrap = el('ruta-hoy'); wrap.innerHTML = skeleton();
    try {
      const r = await ApiClient.misRutas();
      const routes = (r.data && (r.data.routes || r.data)) || [];
      if (!Array.isArray(routes) || !routes.length) {
        wrap.innerHTML = empty('No tienes ninguna ruta asignada.');
        return;
      }
      wrap.innerHTML = '';
      routes.forEach((grp) => wrap.appendChild(routeCard(grp)));
    } catch (e) {
      logError('mis-rutas', e);
      if (e && (e.code === 'ERR_NOT_FOUND' || e.status === 404)) return openRutaHoyLegacy();
      wrap.innerHTML = apiErrorBox([e]);
    }
  }
  /* Tarjeta de una ruta (o del grupo de traspasos asignados a mano: delivery_route=null). */
  function routeCard(grp) {
    const ruta = grp.delivery_route || null;
    const card = document.createElement('div'); card.className = 'trip-card';
    const stops = (grp.stops || []).slice().sort((a, b) => Number(a.stop_sequence ?? 0) - Number(b.stop_sequence ?? 0));
    // Consolidar SOLO de vista: agrupar paradas por tienda destino (varios traspasos → una parada).
    const byDest = {}; const orderKeys = [];
    stops.forEach((s) => {
      const k = String(s.dest_interlocutor_id ?? s.dest_name ?? s.transfer_id);
      if (!byDest[k]) { byDest[k] = { dest_name: s.dest_name, dest_interlocutor_id: s.dest_interlocutor_id, stop_sequence: s.stop_sequence, entregas: [] }; orderKeys.push(k); }
      byDest[k].entregas.push(s);
    });
    const grupos = orderKeys.map((k) => byDest[k]);
    const titulo = ruta ? (ruta.name || ('Ruta ' + ruta.id)) : 'Entregas puntuales';
    const sub = ruta ? (ruta.status ? String(ruta.status).replace(/_/g, ' ') : '') : 'Asignadas manualmente';
    card.innerHTML = `
      <div class="trip-head">
        <div>
          <div class="trip-name">${titulo}</div>
          <div class="trip-meta">${sub}${grupos.length ? ' · ' + grupos.length + ' parada' + (grupos.length > 1 ? 's' : '') : ''}</div>
        </div>
      </div>
      <div class="trip-stops"></div>`;
    const cont = card.querySelector('.trip-stops');
    if (!grupos.length) { cont.innerHTML = empty('Esta ruta no tiene entregas pendientes.'); return card; }
    grupos.forEach((g, i) => cont.appendChild(stopCard(g, i + 1)));
    return card;
  }
  /* Tarjeta de una parada = una TIENDA con una o varias entregas (traspasos) consolidadas.
     Muestra todos los productos de sus traspasos y un botón que actúa sobre todos. */
  function stopCard(g, orden) {
    const entregas = g.entregas || [];
    // Estado del grupo: si alguno está LISTO_DESPACHO → toca enviar; si alguno EN_RUTA → entregar.
    const estados = entregas.map((e) => String(e.state || '').toUpperCase());
    const card = document.createElement('div'); card.className = 'stop-card';
    let accionHtml = '';
    const hayListo = estados.includes('LISTO_DESPACHO');
    const hayRuta = estados.includes('EN_RUTA');
    const todosPendRec = estados.length && estados.every((s) => s === 'PENDIENTE_RECEPCION');
    const todosCerrado = estados.length && estados.every((s) => s === 'CERRADO');
    if (hayListo) accionHtml = `<button class="btn-ok stop-act" data-act="salida">Marcar como enviado${entregas.length > 1 ? ' (' + entregas.length + ')' : ''}</button>`;
    else if (hayRuta) accionHtml = `<button class="btn-ok stop-act" data-act="entregar">Marcar como entregado${entregas.length > 1 ? ' (' + entregas.length + ')' : ''}</button>`;
    else if (todosPendRec) accionHtml = '<div class="stop-done">✓ Entregado · pendiente de recepción</div>';
    else if (todosCerrado) accionHtml = '<div class="stop-done">✓ Recibido en tienda</div>';
    const pedidosTxt = entregas.length > 1
      ? `${entregas.length} pedidos (${entregas.map((e) => '#' + (e.transfer_id ?? e.id)).join(', ')})`
      : `Traspaso #${entregas[0] ? (entregas[0].transfer_id ?? entregas[0].id) : ''} · ${estados[0] ? estados[0].replace(/_/g, ' ') : ''}`;
    // Todos los productos de todas las entregas de esta tienda.
    const filas = [];
    entregas.forEach((e) => (e.items || []).forEach((it) => filas.push({ it, tid: e.transfer_id ?? e.id })));
    card.innerHTML = `
      <div class="stop-head">
        <span class="stop-seq">${g.stop_sequence ?? orden}</span>
        <div class="stop-main">
          <div class="stop-name">${g.dest_name || ('Tienda ' + (g.dest_interlocutor_id ?? ''))}</div>
          <div class="stop-meta">${pedidosTxt}</div>
        </div>
      </div>
      <div class="stop-items">
        ${filas.length ? filas.map(({ it, tid }) => `
          <div class="stop-item">
            <div class="stop-item-main">
              <div class="stop-item-meta">${[it.sku_final_code, it.category_name].filter(Boolean).join(' · ')}${entregas.length > 1 ? ' · Pedido #' + tid : ''}</div>
              <div class="stop-item-name">${it.item_name || it.name || ('SKU ' + (it.item_id ?? ''))}</div>
            </div>
            <div class="stop-item-qty">${fmtQty(it.quantity_dispatched ?? it.quantity_requested ?? 0)}<span>${it.unit_of_measure || it.unit || 'ud'}</span></div>
          </div>`).join('') : '<div class="td-empty">Sin productos.</div>'}
      </div>
      ${accionHtml}`;
    const btn = card.querySelector('.stop-act');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      const act = btn.dataset.act;
      // Actuar sobre TODOS los traspasos de la tienda que estén en el estado que toca.
      const objetivo = act === 'salida' ? 'LISTO_DESPACHO' : 'EN_RUTA';
      const ids = entregas.filter((e) => String(e.state || '').toUpperCase() === objetivo).map((e) => e.transfer_id ?? e.id);
      try {
        for (const id of ids) {
          if (act === 'salida') await ApiClient.traspasoSalida({ traspaso_id: id });
          else await ApiClient.transporteEntregar({ traspaso_id: id });
        }
        toast(act === 'salida'
          ? `${ids.length} pedido(s) marcados como enviados.`
          : `${ids.length} pedido(s) entregados. La tienda ya puede recibirlos.`, 'ok');
        openRutaHoy();
      } catch (e) { logError('mis-rutas/accion', e); toast(e.message || 'No se pudo completar la acción.', 'err'); btn.disabled = false; }
    });
    return card;
  }
  /* Fallback al listado por sede si /routes/today no está disponible. */
  async function openRutaHoyLegacy() {
    await ensureCatalogs(['interlocutors', 'locations']);
    const wrap = el('ruta-hoy'); wrap.innerHTML = skeleton();
    const { rows, errs, allFailed } = await fetchTransfers(['EN_RUTA', 'LISTO_DESPACHO']);
    if (allFailed) { logError('ruta-hoy/legacy', errs[0]); wrap.innerHTML = apiErrorBox(errs); return; }
    wrap.innerHTML = rows.length ? '' : empty('No tienes entregas pendientes.');
    rows.forEach((t) => wrap.appendChild(entregaCard(t)));
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
        `<div class="dash-det-row"><span>${itemLabel(it)}</span><b>${fmtQty(it.quantity_dispatched ?? it.quantity_requested ?? 0)}</b></div>`).join('')
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
    // Orden alfabético por nombre del producto → fácil de leer/verificar para quien recibe.
    items = items.slice().sort((a, b) => String(itemLabel(a)).localeCompare(String(itemLabel(b)), 'es', { sensitivity: 'base' }));
    state.ctx = {
      traspaso: t, header,
      items: items.map((it) => ({ ...it, recibida: Number(it.quantity_dispatched ?? it.quantity_requested ?? 0), obs: '', done: false })),
    };
    view('view-cierre');
    el('cierre-title').textContent = `Recepción Traspaso #${tId(t)}`;
    el('cierre-sub').textContent = `Desde: ${header.origin_sede || intNameById(originIntOf(header))}${transferDate(header) ? ' · ' + fmtDT(transferDate(header)) : ''}`;
    const grid = el('cierre-grid'); grid.innerHTML = '';
    let lastInicial = null;
    state.ctx.items.forEach((it, i) => {
      const ped = Number(it.quantity_requested ?? 0);
      const env = Number(it.quantity_dispatched ?? it.quantity_requested ?? 0);
      const faltante = env < ped;
      const pickObs = it.picking_notes || '';
      // Banda con la inicial del nombre (como una agenda), para ubicarse en listas largas.
      const inicial = (String(itemLabel(it)).trim()[0] || '#').toUpperCase();
      if (inicial !== lastInicial) {
        lastInicial = inicial;
        const band = document.createElement('div'); band.className = 'cie-inicial'; band.dataset.inicial = inicial;
        band.textContent = inicial;
        grid.appendChild(band);
      }
      it.recibida = env;            // por defecto se recibe lo despachado
      it.disp = 'recibido';         // recibido | no_recibido | devuelto
      const card = document.createElement('div'); card.className = 'ali-card'; card.id = `cie-card-${i}`;
      card.innerHTML = `
        <label class="ali-check"><input type="checkbox" id="cie-chk-${i}" /><b>${itemLabel(it)}</b></label>
        <div class="cie-qty-grid">
          <div class="cie-qty-box">
            <span class="cie-qty-lbl">Pedida</span>
            <span class="cie-qty-big">${fmtQty(ped)}</span>
          </div>
          <div class="cie-qty-box">
            <span class="cie-qty-lbl">Despachada</span>
            <span class="cie-qty-big ${faltante ? 'cie-qty-warn' : ''}">${fmtQty(env)}${faltante ? ' ⚠️' : ''}</span>
          </div>
        </div>
        ${faltante ? `<div class="cie-falta">Llegan ${fmtQty(ped - env)} ${it.unit || 'ud'} menos de lo pedido.</div>` : ''}
        ${it.batch_reference ? `<div class="oc-card-sub">Lote ${it.batch_reference}</div>` : ''}
        ${pickObs ? `<div class="cie-pickobs"><b>Nota del almacén:</b> ${pickObs}</div>` : ''}
        <label class="cie-flag"><input type="checkbox" id="cie-nr-${i}" /><span>No recibido en tienda <em class="cie-hint">· se registra como merma en tránsito</em></span></label>
        <label class="cie-flag"><input type="checkbox" id="cie-dv-${i}" /><span>Devuelto a bodega <em class="cie-hint">· reingresa al origen</em></span></label>
        <div class="field-label">Observación / novedad (si hay diferencia o daño)</div>
        <input id="cie-obs-${i}" class="txt" placeholder="Escribe aquí cualquier objeción o novedad…" />`;
      grid.appendChild(card);
      setTimeout(() => {
        const chk = el(`cie-chk-${i}`), obs = el(`cie-obs-${i}`), nr = el(`cie-nr-${i}`), dv = el(`cie-dv-${i}`);
        obs.addEventListener('input', () => { it.obs = obs.value; });
        const applyDisp = () => {
          it.disp = nr.checked ? 'no_recibido' : dv.checked ? 'devuelto' : 'recibido';
          it.recibida = it.disp === 'recibido' ? env : 0;
          card.classList.toggle('cie-nr-on', it.disp !== 'recibido');
          const def = it.disp === 'no_recibido' ? 'No recibido en tienda' : it.disp === 'devuelto' ? 'Devuelto a bodega' : '';
          if (def && !obs.value.trim()) { obs.value = def; it.obs = def; }
        };
        nr.addEventListener('change', () => { if (nr.checked) dv.checked = false; applyDisp(); });
        dv.addEventListener('change', () => { if (dv.checked) nr.checked = false; applyDisp(); });
        chk.addEventListener('change', () => {
          it.done = chk.checked; card.classList.toggle('ali-done', chk.checked); updateCieProgress();
        });
      }, 0);
    });
    el('cie-all').checked = false;
    updateCieProgress();
    // Buscador rápido: filtra por nombre y oculta las bandas de inicial vacías.
    const buscar = el('cie-buscar');
    if (buscar) {
      buscar.value = '';
      buscar.oninput = () => {
        const q = buscar.value.trim().toLowerCase();
        state.ctx.items.forEach((it, i) => {
          const card = el(`cie-card-${i}`);
          if (card) card.style.display = (!q || String(itemLabel(it)).toLowerCase().includes(q)) ? '' : 'none';
        });
        // Ocultar bandas de inicial que se quedaron sin tarjetas visibles.
        el('cierre-grid').querySelectorAll('.cie-inicial').forEach((band) => {
          let vis = false, n = band.nextElementSibling;
          while (n && !n.classList.contains('cie-inicial')) { if (n.style.display !== 'none') { vis = true; break; } n = n.nextElementSibling; }
          band.style.display = vis ? '' : 'none';
        });
      };
    }
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
    const dispLabel = (d) => d === 'no_recibido' ? 'NO RECIBIDO' : d === 'devuelto' ? 'DEVUELTO A BODEGA' : '';
    const notes = items.filter((it) => it.obs.trim() || it.disp !== 'recibido')
      .map((it) => {
        const tag = dispLabel(it.disp);
        const extra = it.obs.trim() && it.obs.trim() !== tag ? it.obs.trim() : '';
        return `${itemLabel(it)}: ${[tag, extra].filter(Boolean).join(' — ')}`;
      }).join(' | ');
    const payload = {
      traspaso_id: tId(state.ctx.traspaso),
      reception_date: new Date().toISOString().slice(0, 10),
      notes,
      items: items.map((it) => {
        const o = {
          item_id: it.item_id,
          batch_id: it.batch_id,
          quantity_received: it.disp === 'recibido' ? Number(it.recibida) : 0,
          disposition: it.disp,          // recibido | no_recibido | devuelto (para el core)
        };
        const tag = dispLabel(it.disp);
        const note = [tag, it.obs.trim() && it.obs.trim() !== tag ? it.obs.trim() : ''].filter(Boolean).join(' — ');
        if (note) o.notes = note;
        return o;
      }),
    };
    await sendTx('traspaso_cerrar', payload, 'Traspaso CERRADO.');
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
      await ensureCatalogs(['interlocutors', 'locations']);   // para resolver nombres de sede
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
      const solicitante = solicitanteName(t);                  // el destino es quien solicitó
      const origen = intNameById(originIntOf(t));
      const fecha = transferDate(t) ? fmtDT(transferDate(t)) : '';
      const c = document.createElement('div'); c.className = 'rowcard rowcard-exp';
      c.innerHTML = `<div class="td-head">
          <b>${solicitante} · #${tId(t)}</b>
          <small class="td-route">${origen} → ${solicitante}${fecha ? ' · ' + fecha : ''}</small>
          <small>${n != null ? n + ' ítem(s)' : 'ver detalle'}${t.notes ? ' · ' + t.notes : ''}</small>
        </div>
        <span class="chip">${tState(t).replace(/_/g, ' ')}</span>`;
      const det = document.createElement('div'); det.className = 'dash-det hidden';
      c.addEventListener('click', async () => {
        det.classList.toggle('hidden');
        if (!det.dataset.loaded) {
          det.innerHTML = '<div class="skel"></div>';
          const items = await transferItems(t);
          det.dataset.loaded = '1';
          det.innerHTML = items.length ? '' : '<div class="td-empty">Sin ítems.</div>';
          items.forEach((it) => {
            const row = document.createElement('div'); row.className = 'td-item';
            const meta = [it.sku_final_code, it.category_name].filter(Boolean).join(' · ');
            row.innerHTML = `
              <div class="td-item-main">
                ${meta ? `<div class="td-item-meta">${meta}</div>` : ''}
                <div class="td-item-name">${it.item_name || it.name || ('SKU ' + (it.item_id ?? ''))}</div>
              </div>
              <div class="td-item-qty">${fmtQty(it.quantity_requested ?? it.quantity ?? 0)}<span>${it.unit || 'ud'}</span></div>`;
            det.appendChild(row);
          });
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
  const MEDIA_BASE = 'https://api.omni.josepan.app/storage/multimedia/';
  function openMermaHist() {
    view('view-merma-hist');
    const to = new Date();
    const from = new Date(); from.setDate(from.getDate() - 30);
    const iso = (d) => d.toISOString().slice(0, 10);
    if (!el('mh-to').value) el('mh-to').value = iso(to);
    if (!el('mh-from').value) el('mh-from').value = iso(from);
    loadMermaHist();
  }
  async function loadMermaHist() {
    const list = el('mh-list'); list.innerHTML = skeleton();
    el('mh-total').classList.add('hidden');
    const kpis = el('mh-kpis'); if (kpis) kpis.innerHTML = '';
    const params = { interlocutor_id: state.interlocutor };   // solo mi sede
    const f = el('mh-from').value, t = el('mh-to').value;
    if (f) params.date_from = f;
    if (t) params.date_to = t;
    try {
      const r = await ApiClient.kardexMermas(params);
      let rows = rowsOf(r.data)
        .sort((a, b) => String(b.created_at || b.movement_date || '').localeCompare(String(a.created_at || a.movement_date || '')));
      if (!rows.length) { list.innerHTML = empty('Sin mermas en el rango seleccionado.'); return; }
      // Nombre legible del SKU: si el kardex no lo trae, cruzar con el catálogo.
      // El kardex puede traer el id del SKU en distintos campos, o el nombre directo.
      // El kardex ya viene enriquecido por el core (item_name, sku_final_code,
      // category_name, unit_of_measure). Se lee directo, sin cruzar con el catálogo.
      rows = rows.map((m) => ({
        ...m,
        _name: m.item_name || m.sku_name || null,
        _skuid: m.item_id ?? null,
      }));

      const total = rows.reduce((s, m) => s + Math.abs(Number(m.quantity ?? m.cantidad ?? 0)), 0);
      const tot = el('mh-total');
      tot.classList.remove('hidden');
      tot.innerHTML = `<div class="mh-total-n">${rows.length}</div><div>registros · <b>${fmtQty(total)}</b> uds dadas de baja</div>`;
      renderMermaKpis(rows);
      list.innerHTML = '';
      rows.forEach((m) => list.appendChild(mermaHistCard(m)));
    } catch (e) { logError('merma/hist', e); list.innerHTML = apiErrorBox([e]); }
  }
  /* Mapa item_id → nombre desde el catálogo (para el historial de mermas). */
  /* KPIs por causa (motivo). El motivo puede venir como "Motivo — observación";
     se agrupa por la parte anterior al guion. */
  function renderMermaKpis(rows) {
    const wrap = el('mh-kpis'); if (!wrap) return;
    const norm = (m) => String(m.reason || m.motivo || 'Otro').split('—')[0].split(' - ')[0].trim() || 'Otro';
    const agg = {};
    rows.forEach((m) => {
      const k = norm(m);
      const q = Math.abs(Number(m.quantity ?? m.cantidad ?? 0));
      if (!agg[k]) agg[k] = { n: 0, q: 0 };
      agg[k].n += 1; agg[k].q += q;
    });
    const entries = Object.entries(agg).sort((a, b) => b[1].q - a[1].q);
    wrap.innerHTML = '';
    entries.forEach(([causa, v]) => {
      const card = document.createElement('div'); card.className = 'mh-kpi';
      card.innerHTML = `<div class="mh-kpi-q">${fmtQty(v.q)}</div>
        <div class="mh-kpi-c">${causa}</div>
        <div class="mh-kpi-n">${v.n} registro${v.n > 1 ? 's' : ''}</div>`;
      wrap.appendChild(card);
    });
  }
  function mermaHistCard(m) {
    const qty = Math.abs(Number(m.quantity ?? m.cantidad ?? 0));
    const fecha = m.created_at || m.movement_date || m.fecha || '';
    const foto = m.file_name || m.evidence || m.multimedia || m.file;
    const c = document.createElement('div'); c.className = 'rowcard col';
    const codigo = m.sku_final_code || m.item_code || '';
    const nombre = m._name || m.item_name || m.sku_name || codigo || 'Producto sin nombre';
    c.innerHTML = `<div class="rowcard-top"><b>${nombre}</b>
      <span class="mh-qty">−${fmtQty(qty)} ${m.unit_of_measure || m.unit || 'ud'}</span></div>
      <small class="tp-sub">${[codigo, m.reason || m.motivo || '—'].filter(Boolean).join(' · ')}${fecha ? ' · ' + fmtDT(fecha) : ''}</small>`;
    const det = document.createElement('div'); det.className = 'dash-det hidden';
    det.innerHTML = `
      ${m.batch_reference ? `<div class="dash-det-row"><span>Lote</span><b>${m.batch_reference}</b></div>` : ''}
      ${m.location_name ? `<div class="dash-det-row"><span>Ubicación</span><b>${m.location_name}</b></div>` : ''}
      ${m.responsible_user || m.created_by_user ? `<div class="dash-det-row"><span>Responsable</span><b>${m.responsible_user || m.created_by_user}</b></div>` : ''}
      ${m.notes ? `<div class="dash-det-row"><span>Notas</span><b>${m.notes}</b></div>` : ''}
      ${foto ? `<a class="mh-foto-link" href="${MEDIA_BASE}${encodeURIComponent(foto)}" target="_blank" rel="noopener"><img class="mh-foto" src="${MEDIA_BASE}${encodeURIComponent(foto)}" alt="evidencia" loading="lazy" /></a>` : ''}`;
    const see = document.createElement('button'); see.className = 'btn-ghost btn-see'; see.textContent = 'Ver detalle';
    see.addEventListener('click', () => det.classList.toggle('hidden'));
    c.append(see, det);
    return c;
  }
  // Orden fijo para tabular. PARA_PROMOCION y PARA_CONSUMO no son pérdida real:
  // el core las trata como traslado (no descuenta como merma). El resto sí es baja.
  const MERMA_MOTIVOS = [
    { v: 'PARA_PROMOCION',      t: 'Para promoción' },
    { v: 'PARA_CONSUMO',        t: 'Para consumo interno' },
    { v: 'Caducidad',           t: 'Caducidad' },
    { v: 'Deterioro',           t: 'Deterioro' },
    { v: 'Error de producción', t: 'Error de producción' },
    { v: 'Otro',                t: 'Otro' },
  ];
  async function openMerma() {
    view('view-merma');
    state.ctx = { qty: {}, skus: [], tipo: '', motivo: '', foto: null };
    el('mrm-ctx-user').textContent = state.user?.nombre || state.user?.username || '—';
    el('mrm-ctx-int').textContent  = state.interlocutorName || ('Interlocutor ' + (state.interlocutor ?? '—'));
    el('mrm-ctx-rol').textContent  = state.rol || '—';
    el('mrm-q').value = '';
    el('mrm-obs').value = '';
    setMrmFoto(null);
    el('mrm-cam-wrap').classList.add('hidden');
    el('mrm-sheet').classList.add('hidden');
    renderMrmChips();
    renderMrmMotivos();
    updateMrmCta();
    await loadMrmSkus();
  }
  function renderMrmChips() {
    const wrap = el('mrm-chips'); wrap.innerHTML = '';
    SKU_TYPES.filter((t) => t.v !== 'FAV').forEach((t) => {
      const b = document.createElement('button');
      b.className = 'chip-f' + (state.ctx.tipo === t.v ? ' on' : '');
      b.textContent = t.c || t.t;
      b.addEventListener('click', () => { state.ctx.tipo = t.v; renderMrmChips(); loadMrmSkus().catch(() => {}); });
      wrap.appendChild(b);
    });
  }
  function renderMrmMotivos() {
    const wrap = el('mrm-motivos'); wrap.innerHTML = '';
    MERMA_MOTIVOS.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'chip-f' + (state.ctx.motivo === m.v ? ' on' : '');
      b.textContent = m.t;
      b.addEventListener('click', () => { state.ctx.motivo = m.v; renderMrmMotivos(); updateMrmCta(); });
      wrap.appendChild(b);
    });
  }
  async function loadMrmSkus() {
    const type = state.ctx.tipo || '';
    const q = el('mrm-q').value.trim();
    const base = { status: 'active', limit: 200 };
    if (q) base.q = q;
    el('mrm-cards').innerHTML = skeleton();
    try {
      const rows = type
        ? rowsOf((await ApiClient.catalog('skus', { ...base, item_type: type })).data)
            .filter((s) => (s.status ?? 'active') === 'active')
        : await fetchAllSkus(base);
      state.ctx.skus = rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      renderMrmCards();
    } catch (e) { logError('merma/skus', e); el('mrm-cards').innerHTML = apiErrorBox([e]); }
  }
  function renderMrmCards() {
    const wrap = el('mrm-cards');
    const rows = state.ctx.skus;
    wrap.innerHTML = '';
    if (!rows.length) { wrap.innerHTML = empty('Sin productos para ese filtro.'); return; }
    rows.forEach((s) => {
      const unit = skuUnit(s);
      const qty = state.ctx.qty[s.id] || 0;
      const step = unit === 'ud' ? 1 : 100;
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
          <div class="sol-card-m"><span>Cantidad a dar de baja (${unit})</span></div>
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
      card.querySelector('.minus').addEventListener('click', () => setMrmQty(s.id, cur() - step, val, card));
      card.querySelector('.plus').addEventListener('click',  () => setMrmQty(s.id, cur() + step, val, card));
      card.querySelectorAll('.stp-q[data-add]').forEach((q) =>
        q.addEventListener('click', () => setMrmQty(s.id, cur() + Number(q.dataset.add), val, card)));
      card.querySelector('.stp-pad').addEventListener('click', () => openNumpad(val));
      val.addEventListener('input', () => setMrmQty(s.id, val.value, null, card));
      wrap.appendChild(card);
    });
  }
  function setMrmQty(id, q, val, card) {
    q = Math.max(0, Number(q) || 0);
    q = Math.round(q * 100) / 100;
    if (q === 0) delete state.ctx.qty[id]; else state.ctx.qty[id] = q;
    if (val) val.value = String(q);
    if (card) card.classList.toggle('picked', q > 0);
    updateMrmCta();
  }
  function updateMrmCta() {
    const ids = Object.keys(state.ctx.qty || {});
    el('mrm-total-n').textContent = String(ids.length);
    const m = state.ctx.motivo;
    const btn = el('mrm-confirm');
    btn.disabled = !ids.length || !m;
    btn.textContent = m === 'PARA_PROMOCION' ? 'REGISTRAR PROMOCIÓN →'
                    : m === 'PARA_CONSUMO'   ? 'REGISTRAR CONSUMO INTERNO →'
                    : 'REGISTRAR MERMA →';
    if (!ids.length) el('mrm-sheet').classList.add('hidden');
    const sec = el('mrm-sec-motivo');
    if (sec) { sec.classList.toggle('done', !!m); const req = sec.querySelector('.mrm-req'); if (req) req.textContent = m ? '· listo ✓' : '· elige uno'; }
    renderMrmSummary();
  }
  function renderMrmSummary() {
    const wrap = el('mrm-summary'); if (!wrap) return;
    const byId = Object.fromEntries((state.ctx.skus || []).map((s) => [String(s.id), s]));
    const ids = Object.keys(state.ctx.qty || {});
    wrap.innerHTML = ids.length ? '' : '<div class="sol-sum-row"><span class="sol-sum-n">Sin productos seleccionados.</span></div>';
    ids.forEach((id) => {
      const s = byId[id] || {};
      const r = document.createElement('div'); r.className = 'sol-sum-row';
      r.innerHTML = `<span class="sol-sum-n">${s.name || ('SKU ' + id)}<span class="sol-sum-u">${s.sku_final_code || ''}</span></span>
        <span class="sol-sum-q">${state.ctx.qty[id]} ${skuUnit(s)}</span>`;
      wrap.appendChild(r);
    });
  }
  function setMrmFoto(b64) {
    state.ctx.foto = b64;
    const img = el('mrm-foto-prev');
    if (b64) { img.src = b64; img.classList.remove('hidden'); el('mrm-foto-clear').classList.remove('hidden'); }
    else { img.classList.add('hidden'); el('mrm-foto-clear').classList.add('hidden'); }
  }
  async function captureMerma() {
    try {
      const cam = await Scanner.startCamera(el('merma-cam'));   // abre el recuadro en vivo
      state.ctx._cam = cam;
      el('mrm-shoot').onclick = () => { setMrmFoto(cam.snapshot()); state.ctx._cam = null; };
      el('mrm-cancel').onclick = () => { cam.cancel(); state.ctx._cam = null; };
    } catch (e) {
      logError('merma/cam', e);
      toast('No se pudo abrir la cámara. Usa "Subir imagen".', 'warn');
    }
  }
  async function uploadMerma(file) {
    if (!file) return;
    try { setMrmFoto(await Scanner.compressFile(file)); }
    catch (e) { logError('merma/upload', e); toast('No se pudo cargar la imagen.', 'err'); }
  }
  /* Un POST /inventory/scrap por SKU. Ubicación y lote los resuelve el API. */
  async function confirmMerma() {
    const ids = Object.keys(state.ctx.qty || {});
    if (!ids.length) { toast('Indica la cantidad de al menos un producto.', 'warn'); return; }
    if (!state.ctx.motivo) { toast('Selecciona el motivo.', 'warn'); return; }
    const especial = state.ctx.motivo === 'PARA_CONSUMO' || state.ctx.motivo === 'PARA_PROMOCION';
    const obs = el('mrm-obs').value.trim();
    const byId = Object.fromEntries((state.ctx.skus || []).map((s) => [String(s.id), s]));
    setBusy('mrm-confirm', true);
    try {
      for (const id of ids) {
        const s = byId[id] || {};
        const payload = {
          item_id: Number(id),
          item_type: 'sku',
          quantity: Metrology.toBase(state.ctx.qty[id], skuUnit(s)),
          // PARA_CONSUMO / PARA_PROMOCION van EXACTOS: el core los trata como traslado,
          // no como pérdida. El resto de motivos sí decrementan como merma.
          reason: especial ? state.ctx.motivo : (obs ? `${state.ctx.motivo} — ${obs}` : state.ctx.motivo),
        };
        if (state.ctx.foto) payload.file_data = state.ctx.foto;
        await ApiClient.merma(payload);
      }
      toast(state.ctx.motivo === 'PARA_CONSUMO' ? 'Consumo interno registrado. Stock trasladado.'
          : state.ctx.motivo === 'PARA_PROMOCION' ? 'Promoción registrada. Stock trasladado.'
          : 'Merma registrada. Stock decrementado.', 'ok');
      renderHub();
    } catch (e) {
      logError('merma/registrar', e);
      toast(e.message || 'No se pudo registrar la merma.', 'err');
    } finally { setBusy('mrm-confirm', false); }
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
    el('drawer-merma-hist').addEventListener('click', () => { closeDrawer(); openMermaHist(); });
    el('drawer-ruta-hist').addEventListener('click', () => { closeDrawer(); openRutaHist(); });
    el('rh-load').addEventListener('click', () => loadRutaHist());
    el('drawer-password').addEventListener('click', () => { closeDrawer(); openPassword(); });
    ['pw-cur', 'pw-new', 'pw-conf'].forEach((id) => el(id).addEventListener('input', updatePwRules));
    el('pw-submit').addEventListener('click', () => submitPassword());
    el('mh-apply').addEventListener('click', () => loadMermaHist().catch(() => {}));
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
    el('sol-discard').addEventListener('click', () => discardDraft());
    wireSkuSearch('ubicar-sku-q', 'ubicar-sku-res', (s) => batchesForSku(s.id, el('ubicar-batch')));
    el('sol-confirm').addEventListener('click', () => confirmSolicitar().catch(() => {}));
    el('alistar-confirm').addEventListener('click', () => confirmAlistar().catch(() => {}));
    el('ali-all').addEventListener('change', (e) => toggleAliAll(e.target.checked));
    el('cierre-confirm').addEventListener('click', () => confirmCierre().catch(() => {}));
    el('cie-all').addEventListener('change', (e) => toggleCieAll(e.target.checked));
    // Mermas
    let mrmTimer = null;
    el('mrm-q').addEventListener('input', () => {
      clearTimeout(mrmTimer); mrmTimer = setTimeout(() => loadMrmSkus().catch(() => {}), 250);
    });
    el('mrm-total').addEventListener('click', () => el('mrm-sheet').classList.toggle('hidden'));
    el('mrm-capture').addEventListener('click', captureMerma);
    el('mrm-upload-btn').addEventListener('click', () => el('mrm-file').click());
    el('mrm-file').addEventListener('change', (e) => { uploadMerma(e.target.files[0]); e.target.value = ''; });
    el('mrm-foto-clear').addEventListener('click', () => setMrmFoto(null));
    el('mrm-confirm').addEventListener('click', () => confirmMerma().catch(() => {}));
    el('perm-save').addEventListener('click', () => savePermisos().catch(() => {}));
    el('emg-discard').addEventListener('click', () => { Outbox.discardHead(); el('view-emergency').classList.add('hidden'); });
    el('emg-resume').addEventListener('click',  () => { Outbox.resume();      el('view-emergency').classList.add('hidden'); });
    el('numpad-close').addEventListener('click', () => el('numpad').classList.add('hidden'));
  }

  return { boot, wireStatic };
})();

document.addEventListener('DOMContentLoaded', () => { App.wireStatic(); App.boot(); });
