const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const { upsertCajaDelta, insertHistorial } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      VALOR: valorRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const valor = parseFloat(valorRaw) || 0;
    const fecha = parsearFecha(marcaTemporal);

    await Promise.all([
      upsertCajaDelta(fecha, turno, 'BAR', valor),
      supabase.from('BAR').insert({ 'MARCA TEMPORAL': fecha, VALOR: valor }),
      insertHistorial({ fecha, oper: turno, tipo: 'BAR', valor })
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error BAR:', error);
    res.status(500).json({ error: error.message });
  }
};
