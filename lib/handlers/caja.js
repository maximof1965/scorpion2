const { parsearFecha } = require('../helpers');
const { setCajaBase, getCaja, insertHistorial, toCajaFecha } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      TIPO: tipo,
      VALOR: valorRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const fecha = parsearFecha(marcaTemporal);

    if (tipo === 'BASE') {
      const valor = parseFloat(valorRaw) || 0;

      await Promise.all([
        setCajaBase(fecha, turno, valor),
        insertHistorial({
          fecha,
          oper: turno,
          tipo: 'CAJA',
          valor,
          detalle: { SUBTIPO: 'BASE' }
        })
      ]);

      return res.json({ ok: true });
    }

    if (tipo === 'CIERRE') {
      const cajaData = await getCaja(fecha, turno);

      if (!cajaData) {
        return res.json({
          FECHA: toCajaFecha(fecha), BASE: 0, RETIRO: 0, GUARDA: 0,
          BAR: 0, CONTRATOS: 0, GASTOS: 0, VENTAS: 0, 'CUADRE CAJA': 0
        });
      }

      return res.json({
        FECHA: cajaData['FECHA'],
        BASE: cajaData['BASE'] || 0,
        RETIRO: cajaData['RETIRO'] || 0,
        GUARDA: cajaData['GUARDA'] || 0,
        BAR: cajaData['BAR'] || 0,
        CONTRATOS: cajaData['CONTRATOS'] || 0,
        GASTOS: cajaData['GASTOS'] || 0,
        VENTAS: cajaData['VENTAS'] || 0,
        'CUADRE CAJA': cajaData['CUADRE CAJA'] || 0
      });
    }

    res.json({ ok: false, mensaje: 'TIPO no válido' });
  } catch (error) {
    console.error('Error CAJA:', error);
    res.status(500).json({ error: error.message });
  }
};
