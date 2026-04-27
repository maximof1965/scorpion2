const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const { insertHistorial } = require('../db');

module.exports = async (req, res) => {
  try {
    const { subtipo, NUMERO, 'Marca temporal': marcaTemporal, TURNO: turno } = req.query;

    const numeros = Array.isArray(NUMERO)
      ? NUMERO.map(n => parseInt(n)).filter(n => !isNaN(n))
      : NUMERO ? [parseInt(NUMERO)].filter(n => !isNaN(n)) : [];

    if (numeros.length === 0) return res.json({ ok: false, mensaje: 'Sin números válidos' });

    const fecha = parsearFecha(marcaTemporal);
    const tabla = subtipo === 'ENVIOS' ? 'XALE' : 'DEV';
    const campo = subtipo === 'ENVIOS' ? 'ENVIOS' : 'DEVOLUCIONES';
    const filas = numeros.map(n => ({ [campo]: n, FECHA: fecha }));

    await Promise.all([
      supabase.from(tabla).insert(filas),
      Promise.all(
        numeros.map(n =>
          insertHistorial({
            fecha,
            oper: turno,
            tipo: subtipo,
            numero: n,
            valor: n,
            detalle: { SUBTIPO: subtipo }
          })
        )
      )
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error CONTROL:', error);
    res.status(500).json({ error: error.message });
  }
};
