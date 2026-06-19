/**
 * ═══════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1003] ALMACÉN Y MERMAS
 *  js/outbox-service.js — Patrón Outbox (resiliencia offline)
 *
 *  • Cola FIFO secuencial en localStorage (clave omni1003_outbox).
 *  • Si no hay red, las transacciones se ENCOLAN en vez de perderse.
 *  • Al reconectar, se drenan en estricto ORDEN CRONOLÓGICO.
 *  • PARADA DE EMERGENCIA: si el API CORE rechaza una transacción por
 *    regla dura (lote inexistente, stock insuficiente, validación), se
 *    DETIENE el drenaje, se conserva el estado y se exige intervención
 *    manual (pantalla roja + sonido grave) para salvaguardar el Kardex.
 *
 *  Eventos emitidos (CustomEvent en window):
 *    outbox:change   → {pending}            (refrescar contador UI)
 *    outbox:halt     → {item, error}        (parada de emergencia)
 *    outbox:drained  → {}                   (cola vacía y sincronizada)
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const Outbox = (() => {

  const KEY = 'omni1003_outbox';
  let draining = false;
  let halted   = false;

  /* ── Persistencia ─────────────────────────────────────────────── */
  function _read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); }
    catch (_) { return []; }
  }
  function _write(queue) {
    localStorage.setItem(KEY, JSON.stringify(queue));
    _emit('outbox:change', { pending: queue.length });
  }
  function _emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  }

  function count()  { return _read().length; }
  function isHalted() { return halted; }

  /**
   * Encola una transacción. action = nombre de acción del proxy
   * (ej. 'merma', 'albaran_recibir', 'traspaso_cerrar').
   */
  function enqueue(action, payload, meta = {}) {
    const queue = _read();
    queue.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      payload,
      meta,
      ts: new Date().toISOString(),
    });
    _write(queue);
    return queue.length;
  }

  /**
   * Intenta una transacción ONLINE primero; si falla por red, la encola.
   * Errores FATALES (validación/conflicto) se propagan: NO se encolan.
   * @returns {Promise<{queued:boolean, data?:object}>}
   */
  async function submit(action, payload, meta = {}) {
    if (!navigator.onLine || count() > 0 || halted) {
      // Si ya hay cola o estamos detenidos, todo va a la cola para conservar el orden.
      enqueue(action, payload, meta);
      if (!halted) drain();
      return { queued: true };
    }
    try {
      const data = await ApiClient.replay(action, payload);
      return { queued: false, data };
    } catch (e) {
      if (e instanceof ApiClient.ApiError && e.type === ApiClient.ERR.NETWORK) {
        enqueue(action, payload, meta);
        return { queued: true };
      }
      throw e; // fatal o de negocio → lo gestiona la vista
    }
  }

  /**
   * Drena la cola en orden. Se detiene ante el primer error fatal.
   */
  async function drain() {
    if (draining || halted || !navigator.onLine) return;
    draining = true;
    try {
      let queue = _read();
      while (queue.length > 0) {
        const item = queue[0];
        try {
          await ApiClient.replay(item.action, item.payload);
          queue.shift();          // éxito → fuera de la cola
          _write(queue);
        } catch (e) {
          if (e instanceof ApiClient.ApiError && e.type === ApiClient.ERR.NETWORK) {
            break;                // sin red → reintentar al reconectar
          }
          // Rechazo duro del backend → PARADA DE EMERGENCIA
          halted = true;
          _emit('outbox:halt', { item, error: e });
          return;
        }
        queue = _read();
      }
      if (queue.length === 0) _emit('outbox:drained', {});
    } finally {
      draining = false;
    }
  }

  /** Tras intervención manual: descartar la transacción atascada y reanudar. */
  function discardHead() {
    const queue = _read();
    queue.shift();
    _write(queue);
    halted = false;
    drain();
  }

  /** Reanudar sin descartar (p. ej. el operario corrigió el stock en el API). */
  function resume() {
    halted = false;
    drain();
  }

  /* ── Drenaje automático al recuperar conexión ─────────────────── */
  window.addEventListener('online', () => { if (!halted) drain(); });

  return { enqueue, submit, drain, count, isHalted, discardHead, resume };
})();
