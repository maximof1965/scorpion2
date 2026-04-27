const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const {
  getInventarioByNumero,
  upsertCajaDelta,
  insertHistorial,
  calcularUtil,
  pickInventarioRow,
  removeRetiro,
} = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      numero: numeroRaw,
      valor_venta: valorVentaRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno,
    } = req.query;

    const numero = parseInt(numeroRaw);
    const valorVenta = parseFloat(valorVentaRaw) || 0;
    const fecha = parsearFecha(marcaTemporal);

    const empe = await getInventarioByNumero(numero);

    if (!empe)
      return res.json({ ok: false, mensaje: 'ARTICULO NO ENCONTRADO' });

    const vendidoRow = {
      ...empe,
      FECHA: fecha,
      OPER: turno,
      'VALOR VENTA': valorVenta,
      'FECHA VENTA': fecha,
      UTIL: calcularUtil(empe['VR PR'], valorVenta),
    };

    const { error: insertError } = await supabase.from('VENDIDO').insert(
      pickInventarioRow(vendidoRow, {
        'VALOR VENTA': vendidoRow['VALOR VENTA'],
        'FECHA VENTA': vendidoRow['FECHA VENTA'],
      })
    );
    if (insertError) throw insertError;

    const { error: deleteError } = await supabase
      .from('INVENTARIO')
      .delete()
      .eq('NUMERO', numero);
    if (deleteError) throw deleteError;

    await Promise.all([
      upsertCajaDelta(fecha, turno, 'VENTAS', valorVenta),
      insertHistorial({
        fecha,
        oper: turno,
        tipo: 'VENTAS',
        numero,
        nombre: empe['NOMBRE'],
        cc: empe['CC'],
        art: empe['ART'],
        descripcion: empe['DESCRIPCION'],
        valor: valorVenta,
        detalle: { UTIL: vendidoRow.UTIL },
      }),
    ]);

    await removeRetiro(numero);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error VENTAS:', error);
    res.status(500).json({ error: error.message });
  }
};
