// Endpoint admin: recalcula TOT IN, TOTAL y UTIL para TODO el INVENTARIO
// y los persiste con la nueva formula (interes acumulado por meses).
//
// Es seguro de correr varias veces. Solo escribe si el valor cambio.
//
// Requiere clave de admin (misma que el panel TABLAS).

const supabase = require('../supabase');
const { exigirAuth } = require('../admin_auth');
const { leerBody } = require('../read_body');
const { recomputarFilaInventario } = require('../db');

module.exports = async (req, res) => {
  const body = await leerBody(req);
  if (!exigirAuth(req, res, body)) return;

  try {
    const PAGINA = 1000;
    let todas = [];
    for (let from = 0; from < 100000; from += PAGINA) {
      const { data, error } = await supabase
        .from('INVENTARIO')
        .select('*')
        .range(from, from + PAGINA - 1)
        .order('NUMERO', { ascending: true });
      if (error) throw error;
      if (!data || data.length === 0) break;
      todas = todas.concat(data);
      if (data.length < PAGINA) break;
    }

    const ahora = new Date();
    let actualizadas = 0;
    let sinCambio = 0;
    const errores = [];

    // Procesa de a lotes pequenos para no saturar.
    for (const row of todas) {
      const recomp = recomputarFilaInventario(row, ahora);
      const cambio =
        Number(row['TOT IN']) !== Number(recomp['TOT IN']) ||
        Number(row.TOTAL)   !== Number(recomp.TOTAL) ||
        Number(row.UTIL)    !== Number(recomp.UTIL);

      if (!cambio) { sinCambio++; continue; }

      const { error } = await supabase
        .from('INVENTARIO')
        .update({
          'TOT IN': recomp['TOT IN'],
          TOTAL:    recomp.TOTAL,
          UTIL:     recomp.UTIL
        })
        .eq('NUMERO', row.NUMERO);
      if (error) {
        errores.push({ numero: row.NUMERO, error: error.message });
      } else {
        actualizadas++;
      }
    }

    return res.json({
      ok: true,
      total: todas.length,
      actualizadas,
      sin_cambio: sinCambio,
      errores: errores.length,
      detalle_errores: errores.slice(0, 20)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
