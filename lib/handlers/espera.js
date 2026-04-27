const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const { getInventarioByNumero, insertHistorial } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      numero: numeroRaw,
      esperar: esperarRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const numero = parseInt(numeroRaw);
    const esperar = (esperarRaw || '').toUpperCase().trim();
    const fecha = parsearFecha(marcaTemporal);

    const empe = await getInventarioByNumero(numero);

    if (!empe) return res.json({ ok: false, mensaje: 'ARTICULO NO ENCONTRADO' });

    await Promise.all([
      supabase.from('INVENTARIO').update({
        ESPERA: esperar
      }).eq('NUMERO', numero),
      insertHistorial({
        fecha,
        oper: turno,
        tipo: 'ESPERA',
        numero,
        nombre: empe['NOMBRE'],
        cc: empe['CC'],
        art: empe['ART'],
        descripcion: empe['DESCRIPCION'],
        detalle: { ESPERA: esperar }
      })
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error ESPERA:', error);
    res.status(500).json({ error: error.message });
  }
};
