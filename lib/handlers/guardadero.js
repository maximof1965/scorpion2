const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const { upsertCajaDelta, insertHistorial, toUpper } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      VALOR: valorRaw,
      NOMBRE: nombreRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const valor = parseFloat(valorRaw) || 0;
    const nombre = toUpper(nombreRaw, '');
    const fecha = parsearFecha(marcaTemporal);

    if (!nombre) {
      return res.status(400).json({ ok: false, error: 'NOMBRE es obligatorio' });
    }

    await Promise.all([
      upsertCajaDelta(fecha, turno, 'GUARDA', valor),
      supabase.from('GUARDADERO').insert({ 'MARCA TEMPORAL': fecha, VALOR: valor, NOMBRE: nombre }),
      insertHistorial({ fecha, oper: turno, tipo: 'GUARDADERO', nombre, valor })
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error GUARDADERO:', error);
    res.status(500).json({ error: error.message });
  }
};
