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

  return { FACTORS, baseUnit, toBase, describe };
})();
