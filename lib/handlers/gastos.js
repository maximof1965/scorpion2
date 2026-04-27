const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const { upsertCajaDelta, insertHistorial, toUpper } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      VALOR: valorRaw,
      DESCRIPCION: descRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const valor = parseFloat(valorRaw) || 0;
    const descripcion = toUpper(descRaw);
    const fecha = parsearFecha(marcaTemporal);

    await Promise.all([
      upsertCajaDelta(fecha, turno, 'GASTOS', valor),
      supabase.from('GASTOS').insert({ FECHA: fecha, TURNO: turno, VALOR: valor, DESCRIPCION: descripcion }),
      insertHistorial({
        fecha,
        oper: turno,
        tipo: 'GASTOS',
        valor,
        descripcion,
        detalle: { DESCRIPCION: descripcion }
      })
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error GASTOS:', error);
    res.status(500).json({ error: error.message });
  }
};
