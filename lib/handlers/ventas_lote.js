const supabase = require('../supabase');
const { ahoraISO } = require('../helpers');
const {
  upsertCajaDelta,
  insertHistorial,
  calcularUtil,
  pickInventarioRow,
  removeRetiro,
  toNumber
} = require('../db');
const { leerBody } = require('../read_body');

function detectarTurnoActual() {
  // Usamos la hora local COLOMBIA (UTC-05:00), no la del servidor
  // (Vercel corre en UTC y nos daria un turno equivocado 5h adelante).
  const ahoraColombia = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const hora = ahoraColombia.getUTCHours();
  if (hora >= 5 && hora < 13) return '1';
  if (hora >= 13 && hora < 21) return '2';
  return '3';
}

function normalizar(ventas) {
  return (Array.isArray(ventas) ? ventas : [])
    .map(v => ({
      numero: parseInt(v.numero, 10),
      valor: toNumber(v.valor)
    }))
    .filter(v => Number.isFinite(v.numero) && v.numero >= 100000 && v.numero <= 999999);
}

module.exports = async (req, res) => {
  try {
    const body = await leerBody(req);
    const ventas = normalizar(body.ventas);

    if (ventas.length === 0) {
      return res.status(400).json({ ok: false, error: 'No hay ventas validas' });
    }

    const numeros = ventas.map(v => v.numero);

    // 1) VALIDACION TOTAL: traer todas las filas existentes en INVENTARIO
    const { data: existentes, error: errBuscar } = await supabase
      .from('INVENTARIO')
      .select('*')
      .in('NUMERO', numeros);
    if (errBuscar) throw errBuscar;

    const setExistentes = new Set((existentes || []).map(r => r.NUMERO));
    const faltantes = numeros.filter(n => !setExistentes.has(n));

    if (faltantes.length > 0) {
      return res.status(409).json({
        ok: false,
        error: 'Algunos articulos no estan en INVENTARIO',
        faltantes
      });
    }

    // 2) PROCESAR todo
    const fecha = ahoraISO();
    const turno = detectarTurnoActual();
    const mapInv = new Map((existentes || []).map(r => [r.NUMERO, r]));

    const filasVendido = [];
    const historiales = [];
    let totalVentas = 0;

    for (const v of ventas) {
      const empe = mapInv.get(v.numero);
      const valorVenta = v.valor;
      totalVentas += valorVenta;
      const util = calcularUtil(empe['VR PR'], valorVenta);

      filasVendido.push(pickInventarioRow(empe, {
        FECHA: fecha,
        OPER: turno,
        'VALOR VENTA': valorVenta,
        'FECHA VENTA': fecha,
        UTIL: util
      }));

      historiales.push({
        FECHA: fecha,
        OPER: turno,
        TIPO: 'VENTAS',
        NUMERO: v.numero,
        NOMBRE: empe['NOMBRE'] || '',
        CC: empe['CC'] || '',
        ART: empe['ART'] || '',
        DESCRIPCION: empe['DESCRIPCION'] || '',
        VALOR: valorVenta,
        DETALLE: JSON.stringify({ UTIL: util })
      });
    }

    // 2.1) Insertar en VENDIDO
    const { error: errInsVend } = await supabase.from('VENDIDO').insert(filasVendido);
    if (errInsVend) throw errInsVend;

    // 2.2) Eliminar de INVENTARIO
    const { error: errDel } = await supabase.from('INVENTARIO').delete().in('NUMERO', numeros);
    if (errDel) throw errDel;

    // 2.3) Eliminar de RETIROS si estaban marcados (tabla pequeña, igual)
    for (const n of numeros) {
      try { await removeRetiro(n); } catch (_) {}
    }

    // 2.4) Insertar en HISTORIAL
    const { error: errHist } = await supabase.from('HISTORIAL').insert(historiales);
    if (errHist) throw errHist;

    // 2.5) Acumular CAJA.VENTAS del turno actual
    if (totalVentas > 0) {
      await upsertCajaDelta(fecha, turno, 'VENTAS', totalVentas);
    }

    return res.json({
      ok: true,
      procesadas: ventas.length,
      total: totalVentas,
      turno
    });
  } catch (error) {
    console.error('Error VENTAS_LOTE:', error);
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
