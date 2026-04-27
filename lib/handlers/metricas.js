// Endpoint admin: dashboard de metricas del negocio.
// Devuelve datos agregados para que el frontend los pinte con Chart.js.
//
// Acepta:
//   desde (ISO date YYYY-MM-DD)  - default: primer dia del mes actual
//   hasta (ISO date YYYY-MM-DD)  - default: hoy
//
// Requiere clave de admin (la misma del panel TABLAS).

const supabase = require('../supabase');
const { exigirAuth } = require('../admin_auth');
const { leerBody } = require('../read_body');
const { recomputarFilaInventario, mesesCalendario } = require('../db');

function leerParam(req, body, n) {
  if (body && body[n] !== undefined) return body[n];
  if (req.query && req.query[n] !== undefined) return req.query[n];
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const v = url.searchParams.get(n);
    if (v !== null) return v;
  } catch (_) {}
  return null;
}

function rangoPorDefecto() {
  const hoy = new Date();
  const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1, 0, 0, 0);
  return {
    desde: ini.toISOString(),
    hasta: hoy.toISOString()
  };
}

function diaISO(d) {
  return d.toISOString().slice(0, 10);
}

async function traerTodo(tabla, columnas, desdeIso, hastaIso, columnaFecha) {
  const PAGINA = 1000;
  let todas = [];
  for (let from = 0; from < 100000; from += PAGINA) {
    let q = supabase.from(tabla).select(columnas).range(from, from + PAGINA - 1);
    if (columnaFecha) {
      if (desdeIso) q = q.gte(columnaFecha, desdeIso);
      if (hastaIso) q = q.lte(columnaFecha, hastaIso);
    }
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    todas = todas.concat(data);
    if (data.length < PAGINA) break;
  }
  return todas;
}

module.exports = async (req, res) => {
  const body = await leerBody(req);
  if (!exigirAuth(req, res, body)) return;

  try {
    let desde = leerParam(req, body, 'desde');
    let hasta = leerParam(req, body, 'hasta');
    const def = rangoPorDefecto();
    if (!desde) desde = def.desde;
    if (!hasta) hasta = def.hasta;

    // Normaliza a ISO con hora.
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) desde = desde + 'T00:00:00.000Z';
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) hasta = hasta + 'T23:59:59.999Z';

    // ============================================================
    // 1) HISTORIAL del periodo: base para flujo de caja, mix de
    //    operaciones, comparativa por turno y volumen.
    // ============================================================
    const historial = await traerTodo(
      'HISTORIAL',
      'FECHA, OPER, TIPO, NUMERO, NOMBRE, ART, VALOR',
      desde, hasta, 'FECHA'
    );

    // ============================================================
    // 2) INVENTARIO actual: cartera viva, antiguedad, top articulos
    // ============================================================
    const inventario = await traerTodo(
      'INVENTARIO',
      '*',
      null, null, null
    );
    const ahora = new Date();
    const inventarioRecalc = inventario.map(r => recomputarFilaInventario(r, ahora));

    // ============================================================
    // 3) CAJA del periodo: BASE, RETIRO, GUARDA, BAR, CONTRATOS,
    //    GASTOS, VENTAS, CUADRE CAJA por dia/turno.
    // ============================================================
    const caja = await traerTodo(
      'CAJA',
      '*',
      desde, hasta, 'FECHA'
    );

    // ============================================================
    // 4) SALIDAS y VENDIDO del periodo: tasa de salida.
    // ============================================================
    const salidas = await traerTodo('SALIDAS', 'FECHA, OPER, NUMERO, ART, "VR PR", "VR RT", "VR AB"', desde, hasta, 'FECHA');
    const vendido = await traerTodo('VENDIDO', 'FECHA, NUMERO, ART, "VR PR"', desde, hasta, 'FECHA');

    // -------------------------------
    // CALCULOS DE AGREGADOS
    // -------------------------------
    // a) KPIs cabecera
    let carteraActiva = 0;          // suma de TOTAL por cobrar (los pendientes)
    let utilidadEsperadaTotal = 0;  // suma de UTIL futura potencial (VR RT - VR PR)
    let utilidadRealizada = 0;      // suma de UTIL realizada en SALIDAS y VENDIDO del periodo
    let cantidadActivos = inventarioRecalc.length;
    let valorPrestadoVivo = 0;      // suma de VR PR del inventario actual

    for (const r of inventarioRecalc) {
      carteraActiva += Number(r.TOTAL || 0);
      valorPrestadoVivo += Number(r['VR PR'] || 0);
      const utilEsperada = Number(r['VR RT'] || 0) - Number(r['VR PR'] || 0);
      utilidadEsperadaTotal += Math.max(0, utilEsperada);
    }
    for (const s of salidas) {
      const u = Number(s['VR AB'] || 0) - Number(s['VR PR'] || 0);
      utilidadRealizada += u;
    }

    const ticketPromedio = cantidadActivos > 0 ? Math.round(valorPrestadoVivo / cantidadActivos) : 0;

    // b) Flujo de caja DIARIO (a partir de CAJA)
    const flujoPorDia = {}; // { 'YYYY-MM-DD': { ingresos, egresos, cuadre } }
    for (const c of caja) {
      const dia = diaISO(new Date(c.FECHA));
      if (!flujoPorDia[dia]) flujoPorDia[dia] = { ingresos: 0, egresos: 0, cuadre: 0 };
      flujoPorDia[dia].ingresos += Number(c.RETIRO || 0) + Number(c.GUARDA || 0) +
                                   Number(c.BAR || 0) + Number(c.VENTAS || 0);
      flujoPorDia[dia].egresos  += Number(c.CONTRATOS || 0) + Number(c.GASTOS || 0);
      flujoPorDia[dia].cuadre   += Number(c['CUADRE CAJA'] || 0);
    }
    const diasOrden = Object.keys(flujoPorDia).sort();
    const flujoCaja = diasOrden.map(d => ({
      dia: d,
      ingresos: flujoPorDia[d].ingresos,
      egresos:  flujoPorDia[d].egresos,
      cuadre:   flujoPorDia[d].cuadre
    }));

    // c) Mix de operaciones (cantidad y valor por TIPO)
    const mixMap = {};
    for (const h of historial) {
      const t = h.TIPO || 'OTRO';
      if (!mixMap[t]) mixMap[t] = { tipo: t, cantidad: 0, valor: 0 };
      mixMap[t].cantidad++;
      mixMap[t].valor += Number(h.VALOR || 0);
    }
    const mixOperaciones = Object.values(mixMap).sort((a, b) => b.cantidad - a.cantidad);

    // d) Antiguedad de inventario (rangos en dias desde FECHA)
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '91-180': 0, '180+': 0 };
    const valorPorBucket = { '0-30': 0, '31-60': 0, '61-90': 0, '91-180': 0, '180+': 0 };
    const MS_DIA = 86400000;
    for (const r of inventarioRecalc) {
      if (!r.FECHA) continue;
      const dias = Math.floor((ahora.getTime() - new Date(r.FECHA).getTime()) / MS_DIA);
      let key = '180+';
      if (dias <= 30) key = '0-30';
      else if (dias <= 60) key = '31-60';
      else if (dias <= 90) key = '61-90';
      else if (dias <= 180) key = '91-180';
      buckets[key]++;
      valorPorBucket[key] += Number(r['VR PR'] || 0);
    }
    const antiguedadInventario = Object.keys(buckets).map(k => ({
      rango: k,
      cantidad: buckets[k],
      valor: valorPorBucket[k]
    }));

    // e) Top tipos de articulo (ART) por cantidad y valor de inventario actual
    const topMap = {};
    for (const r of inventarioRecalc) {
      const a = (r.ART || 'NN').toString().toUpperCase();
      if (!topMap[a]) topMap[a] = { art: a, cantidad: 0, valor: 0 };
      topMap[a].cantidad++;
      topMap[a].valor += Number(r['VR PR'] || 0);
    }
    const topArticulos = Object.values(topMap)
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 10);

    // f) Comparativa por turno (cantidad y valor de operaciones)
    const turnoMap = {};
    for (const h of historial) {
      const t = String(h.OPER || 'NN');
      if (!turnoMap[t]) turnoMap[t] = { turno: t, cantidad: 0, valor: 0 };
      turnoMap[t].cantidad++;
      turnoMap[t].valor += Number(h.VALOR || 0);
    }
    const turnos = Object.values(turnoMap).sort((a, b) => a.turno.localeCompare(b.turno));

    // g) Tasa de salida vs venta del periodo
    const ingresosPeriodo = historial.filter(h => h.TIPO === 'INGRESO').length;
    const salidasPeriodo  = salidas.length;
    const vendidoPeriodo  = vendido.length;
    const cierres = salidasPeriodo + vendidoPeriodo;
    const tasaSalida = cierres > 0 ? (salidasPeriodo / cierres) : 0;

    // h) Top deudores (clientes con mas plata pendiente en INVENTARIO)
    const deudorMap = {};
    for (const r of inventarioRecalc) {
      const k = (r.NOMBRE || 'SIN NOMBRE').toString().toUpperCase().trim();
      if (!deudorMap[k]) deudorMap[k] = { nombre: k, contratos: 0, total: 0 };
      deudorMap[k].contratos++;
      deudorMap[k].total += Number(r.TOTAL || 0);
    }
    const topDeudores = Object.values(deudorMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    return res.json({
      ok: true,
      periodo: { desde, hasta },
      kpis: {
        cartera_activa: Math.round(carteraActiva),
        contratos_activos: cantidadActivos,
        valor_prestado_vivo: Math.round(valorPrestadoVivo),
        ticket_promedio: ticketPromedio,
        utilidad_esperada_inventario: Math.round(utilidadEsperadaTotal),
        utilidad_realizada_periodo: Math.round(utilidadRealizada),
        ingresos_periodo: ingresosPeriodo,
        salidas_periodo: salidasPeriodo,
        vendidos_periodo: vendidoPeriodo,
        tasa_salida_pct: Math.round(tasaSalida * 1000) / 10
      },
      flujo_caja: flujoCaja,
      mix_operaciones: mixOperaciones,
      antiguedad_inventario: antiguedadInventario,
      top_articulos: topArticulos,
      turnos,
      top_deudores: topDeudores
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
