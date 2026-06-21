/**
 * ═══════════════════════════════════════════════════════════════════
 *  JOSEPAN 360 · OMNI · [1003] ALMACÉN Y MERMAS
 *  js/metrology.js — Conversión metrológica EN LA FRONTERA del cliente
 *
 *  Regla Metrológica Industrial de Acero (API CORE):
 *  el operario ve formatos comerciales (Kg, Cajas, Sacos, L...) pero el
 *  payload SIEMPRE viaja en unidades base inmutables:
 *      g  → sólidos / materias primas
 *      ml → líquidos / fluidos
 *      ud → piezas / empaques / producto terminado
 *
 *  La conversión se hace AQUÍ, antes de enviar el JSON al backend.
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const Metrology = (() => {

  /* Factores hacia la unidad base. Amplía según tu catálogo de envases. */
  const FACTORS = Object.freeze({
    // sólidos → g
    g: 1, kg: 1000, mg: 0.001,
    // líquidos → ml
    ml: 1, l: 1000, cl: 10,
    // unidades → ud
    ud: 1, unidad: 1, caja: 1, saco: 1, paquete: 1, pieza: 1,
  });

  /** Unidad base correspondiente a una unidad comercial. */
  function baseUnit(unit) {
    const u = String(unit || '').toLowerCase();
    if (['g', 'kg', 'mg'].includes(u)) return 'g';
    if (['ml', 'l', 'cl'].includes(u)) return 'ml';
    return 'ud';
  }

  /**
   * Convierte una cantidad comercial a su unidad base.
   * Para 'ud' el factor de empaque (uds por caja/saco) debe pasarse explícito.
   * @returns {number} entero en unidad base
   */
  function toBase(qty, unit, packSize = 1) {
    const n = Number(qty);
    if (!isFinite(n) || n < 0) throw new Error('Cantidad no válida.');
    const u = String(unit || 'ud').toLowerCase();
    const factor = FACTORS[u] ?? 1;
    const base = baseUnit(u) === 'ud' ? n * (Number(packSize) || 1) : n * factor;
    // g / ml / ud son enteros en el Kardex.
    return Math.round(base);
  }

  /** Texto legible de la conversión (para confirmaciones en UI). */
  function describe(qty, unit, packSize = 1) {
    return `${qty} ${unit} → ${toBase(qty, unit, packSize)} ${baseUnit(unit)}`;
  }

  /**
   * Formatea una cantidad en unidad base para mostrarla al usuario aplicando
   * pack_size (manual desarrollador §20). sku = { unit_of_measure, pack_size }.
   */
  function formatQty(quantity, sku = {}) {
    const u = String(sku.unit_of_measure || 'ud').toLowerCase();
    const pack = Number(sku.pack_size) || 1;
    const q = Number(quantity) || 0;
    if (u === 'ud' && pack > 1) {
      const tot = q * pack;
      return `${q} ud (${tot >= 1000 ? (tot / 1000).toFixed(2) + ' kg' : tot + ' g'})`;
    }
    if (u === 'g')  return q >= 1000 ? (q / 1000).toFixed(2) + ' kg' : q + ' g';
    if (u === 'ml') return q >= 1000 ? (q / 1000).toFixed(2) + ' L'  : q + ' ml';
    return q + ' ud';
  }

  return { FACTORS, baseUnit, toBase, describe, formatQty };
})();
