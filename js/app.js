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
    el('hdr-user').textContent = state.user.nombre || state.user.username || state.rol || '—';
    el('hdr-rol').textContent  = state.rol || '—';
    el('app-header').classList.remove('hidden');
    await loadScreens();
    renderHub();
  }

  /* Pantallas visibles del usuario actual (driven por el API CORE). */
  async function loadScreens() {
    try {
      const r = await ApiClient.misPantallas();
      state.screens = r?.data?.screens ?? null;   // '*' | array | null
    } catch (_) {
      state.screens = null;                        // fallback a defaults locales
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
    solicitar:  { t: 'Solicitar Insumos',        d: 'Pedido de traspaso a bodega',    area: 'tienda',     go: openSolicitar },
    recibir:    { t: 'Recepción de Traspaso',    d: 'Verificar y cerrar entrega',     area: 'tienda',     go: openRecibir },
    merma:      { t: 'Registrar Merma',          d: 'Baja con evidencia fotográfica', area: 'mermas',     go: openMerma },
    dashboard:  { t: 'Panel de Traspasos',       d: 'Estado, KPIs e histórico',       area: 'gestion',    go: openDashboard },
  };
  // Orden de aparición en el home (agrupado por área/rol).
  const TILE_ORDER = ['recepcion', 'ubicar', 'picking', 'transporte', 'solicitar', 'recibir', 'merma', 'dashboard'];
  /* Detección robusta de SuperAdmin (rol puede venir como 'SuperAdministrador'). */
  function isSuperAdmin() {
    const r = (state.rol || '').toString().toLowerCase().replace(/[\s_-]/g, '');
    return r.includes('superadmin');
  }
  /* Calcula las pantallas operativas visibles para el usuario actual. */
  function visibleTiles() {
    const all = Object.keys(TILE_META);
    if (isSuperAdmin() || state.screens === '*') return all;     // SuperAdmin ve todo
    if (Array.isArray(state.screens)) return state.screens.filter((k) => TILE_META[k]);
    return ROLE_TILES[state.rol] || [];                                     // fallback local
  }

  function orderTiles(keys) {
    return keys.slice().sort((a, b) => {
      const ia = TILE_ORDER.indexOf(a), ib = TILE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
  function renderHub() {
    const tiles = orderTiles(visibleTiles());
    const wrap = el('hub-tiles');
    wrap.innerHTML = '';
    if (tiles.length === 0 && !isSuperAdmin()) {
      wrap.innerHTML = `<div class="rounded-xl border border-warn/40 bg-warn/10 p-4 text-warn-700">
        Tu rol no tiene pantallas asignadas en este módulo.</div>`;
    }
    // Leyenda de colores por área (solo las áreas visibles)
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
      b.style.borderLeftColor = AREA[m.area].color;       // color por rol/área
      b.innerHTML = `<span class="tile-t">${m.t}</span><span class="tile-d">${m.d}</span>`;
      b.addEventListener('click', m.go);
      wrap.appendChild(b);
    });
    // Tile exclusivo de administración (solo SuperAdmin)
    if (isSuperAdmin()) {
      const b = document.createElement('button');
      b.className = 'tile tile-admin';
      b.innerHTML = `<span class="tile-t">Gestor de Permisos</span>
        <span class="tile-d">Asignar pantallas a roles del API CORE</span>`;
      b.addEventListener('click', openPermisos);
      wrap.appendChild(b);
    }
    view('view-hub');
  }

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

    // Pantallas a gestionar: catálogo registrado en el API CORE (SSOT) que [1003]
    // sabe renderizar. Si el catálogo no responde, se usan las locales.
    const screens = (registered && registered.length)
      ? registered.filter((k) => TILE_META[k])
      : Object.keys(TILE_META);

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
    state.ctx = { items: [], originLocId: null, destLocId: null };
    el('sol-cant').value = '';
    el('sol-notes').value = '';
    resetSkuSearch('sol-sku-q', 'sol-sku-res');
    bindNumpad(el('sol-cant'));
    el('sol-origen-lbl').textContent = 'Resolviendo…';
    el('sol-dest-lbl').textContent = state.interlocutorName || ('Interlocutor ' + (state.interlocutor ?? '—'));
    renderSolItems();
    el('sol-sku-q')._skuLoad();            // muestra el listado de SKUs activos
    await resolveSolEndpoints();
  }
  /* Origen = interlocutor OBRADOR (fábrica). Destino = interlocutor de trabajo. */
  async function resolveSolEndpoints() {
    await ensureCatalog('locations');
    let obrador = null;
    try {
      const fr = await ApiClient.catalog('interlocutors', { type: 'fabrica' });
      const fabricas = rowsOf(fr.data);
      obrador = fabricas.find((i) => /obrador/i.test(intName(i))) || fabricas[0] || null;
    } catch (e) { logError('sol/obrador', e); }
    const locs = state.catalogs.locations;
    const oLoc = obrador ? locs.find((l) => Number(l.interlocutor_id) === Number(obrador.id)) : null;
    const dLoc = locs.find((l) => Number(l.interlocutor_id) === Number(state.interlocutor));
    state.ctx.originLocId = oLoc ? oLoc.id : null;
    state.ctx.destLocId   = dLoc ? dLoc.id : null;
    el('sol-origen-lbl').textContent = obrador ? intName(obrador) : 'Obrador (no encontrado)';
    el('sol-dest-lbl').textContent = (dLoc && dLoc.interlocutor_name) || state.interlocutorName || ('Interlocutor ' + state.interlocutor);
  }
  function intName(i) { return i.commercial_name || i.fiscal_name || i.name || i.nombre || ('Interlocutor ' + i.id); }
  function renderSolItems() {
    const wrap = el('sol-items'); wrap.innerHTML = '';
    state.ctx.items.forEach((it, i) => {
      const r = document.createElement('div'); r.className = 'grid-row';
      r.innerHTML = `<div class="grid-row-head"><b>${it.sku_label}</b>
        <small>${it.quantity_requested} ${Metrology.baseUnit(it.unit)}</small></div>
        <button class="btn-del-sm" data-i="${i}">Quitar</button>`;
      r.querySelector('button').addEventListener('click', () => { state.ctx.items.splice(i, 1); renderSolItems(); });
      wrap.appendChild(r);
    });
  }
  function addSolItem() {
    const item  = pickedSku('sol-sku-q');
    const cant  = Number(el('sol-cant').value);
    const unit  = el('sol-unidad').value;
    if (!item || !cant) { toast('Elige un SKU del listado e indica la cantidad.', 'warn'); return; }
    state.ctx.items.push({
      item_id: item,
      quantity_requested: Metrology.toBase(cant, unit),
      unit,
      sku_label: el('sol-sku-q').dataset.skuId
        ? (el('sol-sku-res').querySelector('.sku-opt.sel')?.textContent || ('SKU ' + item))
        : ('SKU ' + item),
    });
    el('sol-cant').value = '';
    resetSkuSearch('sol-sku-q', 'sol-sku-res');
    renderSolItems();
  }
  async function confirmSolicitar() {
    if (!state.ctx.items.length) { toast('Añade al menos un ítem.', 'warn'); return; }
    if (!state.ctx.originLocId || !state.ctx.destLocId) {
      toast('No se pudo resolver origen/destino. Avisa al encargado.', 'err'); return;
    }
    const payload = {
      location_id_origin: state.ctx.originLocId,
      location_id_destination: state.ctx.destLocId,
      items: state.ctx.items.map((it) => ({
        item_id: it.item_id, item_type: 'sku', quantity_requested: it.quantity_requested,
      })),   // el lote NO se solicita: se asigna por FEFO en el picking
      notes: el('sol-notes').value.trim(),
    };
    await sendTx('traspaso_solicitar', payload, 'Solicitud registrada (SOLICITADO).');
    renderHub();
  }

  // B + C) Picking: bandeja SOLICITADO → iniciar → alistar
  async function openPicking() {
    view('view-picking');
    const list = el('picking-list'); list.innerHTML = skeleton();
    try {
      const r = await ApiClient.traspasos('SOLICITADO');
      const rows = rowsOf(r.data);
      list.innerHTML = rows.length ? '' : empty('Sin solicitudes en tu centro.');
      rows.forEach((t) => {
        const id = tId(t);
        const c = document.createElement('button'); c.className = 'rowcard';
        c.innerHTML = `<div><b>Traspaso #${id}</b><small>${t.notes ?? ''}</small></div><span class="chip">SOLICITADO</span>`;
        c.addEventListener('click', () => iniciarPicking(t));
        list.appendChild(c);
      });
    } catch (e) { logError('picking/list', e); list.innerHTML = empty('No hay traspasos pendientes.'); }
  }
  async function iniciarPicking(t) {
    try {
      await ApiClient.pickingIniciar({ traspaso_id: tId(t) });   // → EN_PICKING (bloqueo)
      state.ctx = { traspaso: t, items: (t.items || []).map((it) => ({ ...it, despachada: null })) };
      renderAlistar();
    } catch (e) { logError('picking/iniciar', e); toast(e.message, 'err'); }
  }
  function renderAlistar() {
    view('view-alistar');
    el('alistar-title').textContent = `Alistar Traspaso #${tId(state.ctx.traspaso)}`;
    const grid = el('alistar-grid'); grid.innerHTML = '';
    state.ctx.items.forEach((it, i) => {
      const sol = it.quantity_requested ?? 0;
      const row = document.createElement('div'); row.className = 'grid-row';
      row.innerHTML = `<div class="grid-row-head"><b>${itemLabel(it)}</b><small>Solicitada: ${sol}</small></div>
        <div class="grid-row-body"><input id="ali-${i}" class="num" inputmode="numeric" placeholder="Despachada" /></div>`;
      grid.appendChild(row);
      setTimeout(() => {
        const input = el(`ali-${i}`); bindNumpad(input);
        input.addEventListener('input', () => {
          let v = Number(input.value);
          if (v > sol) { v = sol; input.value = String(sol); toast('No puede superar lo solicitado.', 'warn'); }
          it.despachada = v; evalAlistarObs();
        });
      }, 0);
    });
    el('alistar-obs-wrap').classList.add('hidden');
  }
  function evalAlistarObs() {
    const faltante = state.ctx.items.some((it) => it.despachada !== null && it.despachada < (it.quantity_requested ?? 0));
    el('alistar-obs-wrap').classList.toggle('hidden', !faltante);
  }
  async function confirmAlistar() {
    const items = state.ctx.items;
    if (items.some((it) => it.despachada === null)) { toast('Indica todas las cantidades.', 'warn'); return; }
    const faltante = items.some((it) => it.despachada < (it.quantity_requested ?? 0));
    const obs = el('alistar-obs').value.trim();
    if (faltante && !obs) { toast('Justifica el faltante en observaciones.', 'warn'); return; }
    const payload = {
      traspaso_id: tId(state.ctx.traspaso),
      notes: obs,
      items: items.map((it) => ({ item_id: it.item_id, batch_id: it.batch_id, quantity_dispatched: it.despachada })),
    };
    await sendTx('picking_alistar', payload, 'Traspaso LISTO_DESPACHO.');
    openPicking();
  }

  // D) Transportista
  async function openTransporte() {
    view('view-transporte');
    await ensureCatalog('rutas');
    const list = el('transporte-list'); list.innerHTML = skeleton();
    try {
      const r = await ApiClient.traspasos('LISTO_DESPACHO');
      const rows = rowsOf(r.data);
      list.innerHTML = rows.length ? '' : empty('Sin órdenes para despacho.');
      rows.forEach((t) => {
        const id = tId(t);
        const c = document.createElement('div'); c.className = 'rowcard col';
        c.innerHTML = `<div class="rowcard-top"><b>Traspaso #${id}</b><span class="chip">${tState(t)}</span></div>`;
        const ctrls = document.createElement('div'); ctrls.className = 'rowcard-ctrls';
        const ruta = document.createElement('select'); ruta.className = 'sel';
        ruta.add(new Option('Selecciona ruta…', ''));
        state.catalogs.rutas.forEach((rt) => ruta.add(new Option(rt.nombre || rt.name || ('Ruta ' + rt.id), rt.id)));
        const goRuta = document.createElement('button'); goRuta.className = 'btn-ok-sm'; goRuta.textContent = 'EN RUTA';
        const goEnt  = document.createElement('button'); goEnt.className = 'btn-prim-sm'; goEnt.textContent = 'ENTREGAR'; goEnt.disabled = true;
        goRuta.addEventListener('click', async () => {
          await sendTx('transporte_ruta', { traspaso_id: id, ruta_id: ruta.value ? Number(ruta.value) : null }, 'En ruta.');
          goRuta.disabled = true; goEnt.disabled = false;
        });
        goEnt.addEventListener('click', async () => {
          await sendTx('transporte_entregar', { traspaso_id: id }, 'Entregado (PENDIENTE_RECEPCION).');
          openTransporte();
        });
        ctrls.append(ruta, goRuta, goEnt);
        c.appendChild(ctrls);
        list.appendChild(c);
      });
    } catch (e) { logError('transporte/list', e); list.innerHTML = empty('No hay traspasos pendientes.'); }
  }

  // E) Recepción y cierre (Encargado de Tienda)
  async function openRecibir() {
    view('view-recibir');
    const list = el('recibir-list'); list.innerHTML = skeleton();
    try {
      const r = await ApiClient.traspasos('PENDIENTE_RECEPCION');
      const rows = rowsOf(r.data);
      list.innerHTML = rows.length ? '' : empty('No hay traspasos pendientes.');
      rows.forEach((t) => {
        const id = tId(t);
        const c = document.createElement('button'); c.className = 'rowcard';
        c.innerHTML = `<div><b>Traspaso #${id}</b><small>${t.notes ?? ''}</small></div><span class="chip">PENDIENTE</span>`;
        c.addEventListener('click', () => openCierre(t));
        list.appendChild(c);
      });
    } catch (e) { logError('recibir/list', e); list.innerHTML = empty('No hay traspasos pendientes.'); }
  }
  function openCierre(t) {
    state.ctx = { traspaso: t, items: (t.items || []).map((it) => ({ ...it, recibida: null })) };
    view('view-cierre');
    el('cierre-title').textContent = `Recepción Traspaso #${tId(t)}`;
    const grid = el('cierre-grid'); grid.innerHTML = '';
    state.ctx.items.forEach((it, i) => {
      const sol = it.quantity_requested ?? 0;
      const des = it.quantity_dispatched ?? 0;
      const row = document.createElement('div'); row.className = 'grid-row';
      row.innerHTML = `<div class="grid-row-head"><b>${itemLabel(it)}</b>
        <small>Solicitada ${sol} · Despachada ${des}</small></div>
        <div class="grid-row-body"><input id="cie-${i}" class="num" inputmode="numeric" placeholder="Recibida" /></div>`;
      grid.appendChild(row);
      setTimeout(() => {
        const input = el(`cie-${i}`); bindNumpad(input);
        input.addEventListener('input', () => { it.recibida = Number(input.value); evalCierreObs(); });
      }, 0);
    });
    el('cierre-obs-wrap').classList.add('hidden');
  }
  function evalCierreObs() {
    const diff = state.ctx.items.some((it) => it.recibida !== null && it.recibida !== (it.quantity_dispatched ?? 0));
    el('cierre-obs-wrap').classList.toggle('hidden', !diff);
  }
  async function confirmCierre() {
    const items = state.ctx.items;
    if (items.some((it) => it.recibida === null)) { toast('Cuenta todos los ítems.', 'warn'); return; }
    const diff = items.some((it) => it.recibida !== (it.quantity_dispatched ?? 0));
    const obs = el('cierre-obs').value.trim();
    if (diff && !obs) { toast('Observaciones obligatorias por diferencia.', 'warn'); return; }
    const payload = {
      traspaso_id: tId(state.ctx.traspaso),
      notes: obs,
      items: items.map((it) => ({ item_id: it.item_id, batch_id: it.batch_id, quantity_received: it.recibida })),
    };
    await sendTx('traspaso_cerrar', payload, 'Traspaso CERRADO. Stock impactado.');
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
      const nItems = (t.items || []).length;
      const c = document.createElement('div'); c.className = 'rowcard';
      c.innerHTML = `<div><b>Traspaso #${tId(t)}</b><small>${nItems} ítem(s)${t.notes ? ' · ' + t.notes : ''}</small></div>
        <span class="chip">${tState(t).replace(/_/g, ' ')}</span>`;
      list.appendChild(c);
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
    el('merma-confirm').disabled = true;
    bindNumpad(el('merma-cant'));
    resetSkuSearch('merma-sku-q', 'merma-sku-res');
    fillSelect(el('merma-batch'), [], lblBatch, 'Elige SKU primero…');
    await ensureCatalogs(['locations']);
    fillSelect(el('merma-loc'), state.catalogs.locations, lblLoc, 'Ubicación…');
  }
  async function captureMerma() {
    try {
      const b64 = await Scanner.capturePhoto(el('merma-cam'));
      state.ctx.foto = b64;
      const img = el('merma-foto-prev');
      img.src = b64; img.classList.remove('hidden');
      el('merma-confirm').disabled = false;   // se habilita SOLO con foto
    } catch (e) { logError('merma/foto', e); toast('No se pudo capturar la imagen.', 'err'); }
  }
  async function confirmMerma() {
    const loc   = Number(el('merma-loc').value);
    const item  = pickedSku('merma-sku-q');
    const batch = Number(el('merma-batch').value);
    const cant  = Number(el('merma-cant').value);
    const unit  = el('merma-unidad').value;
    const razon = el('merma-razon').value;
    const obs   = el('merma-obs').value.trim();
    if (!loc || !item || !batch || !cant) { toast('Completa ubicación, SKU, lote y cantidad.', 'warn'); return; }
    if (!razon) { toast('Selecciona la razón.', 'warn'); return; }
    if (!obs) { toast('Observaciones obligatorias.', 'warn'); return; }
    if (!state.ctx.foto) { toast('La fotografía es obligatoria.', 'warn'); return; }

    const payload = {
      location_id: loc,
      item_id: item,
      item_type: 'sku',
      batch_id: batch,
      quantity: Metrology.toBase(cant, unit),
      reason: `${razon} — ${obs}`,
      file_data: state.ctx.foto,
    };
    await sendTx('merma', payload, 'Merma registrada. Stock decrementado.');
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

  /* Buscador de SKU (typeahead) — necesario con ~1000 SKUs activos.
     opts.persistent=true: muestra siempre el listado y la búsqueda lo filtra.
     Guarda el id elegido en input.dataset.skuId. onPick recibe el SKU. */
  function wireSkuSearch(inputId, resultsId, onPick, opts = {}) {
    const input = el(inputId), res = el(resultsId);
    const persistent = !!opts.persistent;
    let timer = null;
    input.autocomplete = 'off';
    input.dataset.skuId = '';
    const render = (rows) => {
      res.innerHTML = '';
      if (!rows.length) { res.innerHTML = '<div class="sku-empty">Sin coincidencias</div>'; res.classList.add('open'); return; }
      rows.forEach((s) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sku-opt'; b.dataset.id = String(s.id); b.textContent = lblSku(s);
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
      try {
        const r = await ApiClient.catalog('skus', { q, status: 'active', limit: 50 });
        render(rowsOf(r.data).filter((s) => (s.status ?? 'active') === 'active'));
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
    if (!persistent) input.addEventListener('blur', () => setTimeout(() => res.classList.remove('open'), 180));
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

  /* ── Cableado de botones estáticos ────────────────────────────── */
  function wireStatic() {
    el('hdr-logout').addEventListener('click', doLogout);
    $$('[data-back]').forEach((b) => b.addEventListener('click', renderHub));
    el('oc-save').addEventListener('click', () => saveOC().catch(() => {}));
    el('oc-back').addEventListener('click', () => openRecepcion().catch(() => {}));
    el('ubicar-scan').addEventListener('click', scanUbicacion);
    el('ubicar-confirm').addEventListener('click', () => confirmUbicar().catch(() => {}));
    el('sol-add').addEventListener('click', addSolItem);
    // Buscadores de SKU (typeahead). Ubicar/merma recargan lotes al elegir.

    wireSkuSearch('sol-sku-q', 'sol-sku-res', null, { persistent: true });
    wireSkuSearch('ubicar-sku-q', 'ubicar-sku-res', (s) => batchesForSku(s.id, el('ubicar-batch')));
    wireSkuSearch('merma-sku-q', 'merma-sku-res', (s) => batchesForSku(s.id, el('merma-batch')));
    el('sol-confirm').addEventListener('click', () => confirmSolicitar().catch(() => {}));
    el('alistar-confirm').addEventListener('click', () => confirmAlistar().catch(() => {}));
    el('cierre-confirm').addEventListener('click', () => confirmCierre().catch(() => {}));
    el('merma-capture').addEventListener('click', captureMerma);
    el('merma-confirm').addEventListener('click', () => confirmMerma().catch(() => {}));
    el('perm-save').addEventListener('click', () => savePermisos().catch(() => {}));
    el('emg-discard').addEventListener('click', () => { Outbox.discardHead(); el('view-emergency').classList.add('hidden'); });
    el('emg-resume').addEventListener('click',  () => { Outbox.resume();      el('view-emergency').classList.add('hidden'); });
    bindNumpad(el('sol-cant'));
    el('numpad-close').addEventListener('click', () => el('numpad').classList.add('hidden'));
  }

  return { boot, wireStatic };
})();

document.addEventListener('DOMContentLoaded', () => { App.wireStatic(); App.boot(); });
