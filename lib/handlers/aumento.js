const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const {
  getInventarioByNumero,
  upsertCajaDelta,
  insertHistorial,
  recomputarFilaInventario
} = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      identificador,
      numero: numeroAlt,
      aumento: aumentoRaw,
      pago_aumento: pagoAumentoRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const numero = parseInt(identificador || numeroAlt);
    const aumento = parseFloat(aumentoRaw) || 0;
    const pagoAumento = parseFloat(pagoAumentoRaw) || 0;
    const fecha = parsearFecha(marcaTemporal);

    const empe = await getInventarioByNumero(numero);

    if (!empe) return res.json({ ok: false, mensaje: 'ARTICULO NO ENCONTRADO' });

    const nuevoVrPrestado = (empe['VR PR'] || 0) + aumento;
    const nuevoVrRetiro = (empe['VR RT'] || 0) + pagoAumento;
    const historialAumento = empe['AUMENTO']
      ? `${empe['AUMENTO']}-${aumento}-${pagoAumento}`
      : `${aumento}-${pagoAumento}`;

    const rowParcial = {
      ...empe,
      'VR PR': nuevoVrPrestado,
      'VR RT': nuevoVrRetiro,
      AUMENTO: historialAumento,
      'FECHA AU': fecha
    };
    const rowFinal = recomputarFilaInventario(rowParcial, new Date());

    await Promise.all([
      supabase.from('INVENTARIO').update({
        'VR PR': rowFinal['VR PR'],
        'VR RT': rowFinal['VR RT'],
        AUMENTO: rowFinal['AUMENTO'],
        'FECHA AU': rowFinal['FECHA AU'],
        'TOT IN': rowFinal['TOT IN'],
        UTIL: rowFinal.UTIL,
        TOTAL: rowFinal.TOTAL
      }).eq('NUMERO', numero),
      upsertCajaDelta(fecha, turno, 'CONTRATOS', aumento),
      insertHistorial({
        fecha,
        oper: turno,
        tipo: 'AUMENTO',
        numero,
        nombre: empe['NOMBRE'],
        cc: empe['CC'],
        art: empe['ART'],
        descripcion: empe['DESCRIPCION'],
        valor: aumento,
        detalle: { AUMENTO: aumento, PAGO_AUMENTO: pagoAumento }
      })
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error AUMENTO:', error);
    res.status(500).json({ error: error.message });
  }
};
