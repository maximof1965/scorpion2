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
      valor: valorRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const numero = parseInt(identificador || numeroAlt);
    const valor = parseFloat(valorRaw) || 0;
    const fecha = parsearFecha(marcaTemporal);

    if (valor <= 0) {
      return res.json({ ok: false, mensaje: 'EL VALOR DE LA DEVOLUCION DEBE SER MAYOR A 0' });
    }

    const empe = await getInventarioByNumero(numero);
    if (!empe) return res.json({ ok: false, mensaje: 'ARTICULO NO ENCONTRADO' });

    const vrAb  = parseFloat(empe['VR AB'])  || 0;
    const vrIn  = parseFloat(empe['VR IN'])  || 0;
    const totIn = parseFloat(empe['TOT IN']) || 0;
    const totalDisponible = vrAb + vrIn;

    if (totalDisponible <= 0) {
      return res.json({
        ok: false,
        mensaje: 'NO SE PUEDE HACER LA DEVOLUCION: NO HAY VALOR EN VR AB NI EN VR IN'
      });
    }

    if (valor > totalDisponible) {
      return res.json({
        ok: false,
        mensaje: `NO SE PUEDE: LA DEVOLUCION (${valor}) SUPERA LA SUMA DE VR AB + VR IN (${totalDisponible})`
      });
    }

    // Repartir: primero se descuenta de VR AB, lo que sobre se quita de VR IN.
    const restaAb = Math.min(valor, vrAb);
    const restaIn = valor - restaAb;

    const nuevoVrAb  = vrAb  - restaAb;
    const nuevoVrIn  = vrIn  - restaIn;
    const nuevoTotIn = Math.max(0, totIn - restaIn);

    const rowParcial = {
      ...empe,
      'VR AB': nuevoVrAb,
      'VR IN': nuevoVrIn,
      'TOT IN': nuevoTotIn,
      'FECHA ABON': fecha
    };
    const rowFinal = recomputarFilaInventario(rowParcial, new Date());

    await Promise.all([
      supabase.from('INVENTARIO').update({
        'VR AB': rowFinal['VR AB'],
        'VR IN': rowFinal['VR IN'],
        'TOT IN': rowFinal['TOT IN'],
        'FECHA ABON': fecha,
        TOTAL: rowFinal.TOTAL,
        UTIL: rowFinal.UTIL
      }).eq('NUMERO', numero),
      // CAJA: la devolucion es egreso (operador devuelve dinero al cliente)
      // -> resta del campo RETIRO.
      upsertCajaDelta(fecha, turno, 'RETIRO', -valor),
      insertHistorial({
        fecha,
        oper: turno,
        tipo: 'DEVOLUCION',
        numero,
        nombre: empe['NOMBRE'],
        cc: empe['CC'],
        art: empe['ART'],
        descripcion: empe['DESCRIPCION'],
        valor,
        // Guardamos como se distribuyo para que EDITAR pueda revertir bien.
        detalle: { RESTA_AB: restaAb, RESTA_IN: restaIn }
      })
    ]);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error DEVOLUCION:', error);
    res.status(500).json({ error: error.message });
  }
};
