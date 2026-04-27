const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const {
  getInventarioByNumero,
  upsertCajaDelta,
  insertHistorial,
  pickInventarioRow,
  recomputarFilaInventario,
  removeRetiro
} = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      numero: numeroRaw,
      valor: valorRaw,
      descuento: descuentoRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const numero = parseInt(numeroRaw);
    const valor = parseFloat(valorRaw) || 0;
    const descuento = parseFloat(descuentoRaw) || 0;
    const fecha = parsearFecha(marcaTemporal);

    const empe = await getInventarioByNumero(numero);

    if (!empe) return res.json({ ok: false, mensaje: 'ARTICULO NO ENCONTRADO' });

    // Cuando el cliente recoge: congelamos TOT IN al valor del momento de salida
    // y recalculamos UTIL con el VR AB final (incluye el pago de salida).
    const rowParcial = {
      ...empe,
      FECHA: fecha,
      OPER: turno,
      'VR AB': (empe['VR AB'] || 0) + valor,
      'FECHA ABON': fecha,
      DES: descuento || empe.DES || 0
    };
    // Calculamos TOT IN al instante de la salida (no FECHA actualizada,
    // sino la FECHA original del contrato del cliente).
    const totInCongelado = recomputarFilaInventario(
      { ...rowParcial, FECHA: empe.FECHA },
      new Date()
    )['TOT IN'];
    const rowSalida = recomputarFilaInventario({ ...rowParcial, 'TOT IN': totInCongelado }, new Date());

    const { error: insertError } = await supabase
      .from('SALIDAS')
      .insert(pickInventarioRow(rowSalida));
    if (insertError) throw insertError;

    const { error: deleteError } = await supabase
      .from('INVENTARIO')
      .delete()
      .eq('NUMERO', numero);
    if (deleteError) throw deleteError;

    // Secuencia para garantizar que HISTORIAL quede registrado aunque
    // CAJA o RETIROS fallen despues (insertHistorial tiene reintentos).
    await upsertCajaDelta(fecha, turno, 'RETIRO', valor);
    await insertHistorial({
      fecha,
      oper: turno,
      tipo: 'SALIDA',
      numero,
      nombre: empe['NOMBRE'],
      cc: empe['CC'],
      art: empe['ART'],
      descripcion: empe['DESCRIPCION'],
      valor,
      detalle: { DES: descuento }
    });
    await removeRetiro(numero);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error SALIDA:', error);
    res.status(500).json({ error: error.message });
  }
};
