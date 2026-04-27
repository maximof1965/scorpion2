const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const { getInventarioByNumero, insertHistorial, syncRetirosFromInventario } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      numero: numeroRaw,
      'RETIRO(PEDIR)': retiroRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const numero = parseInt(numeroRaw);
    const retiro = (retiroRaw || '').toUpperCase().trim();
    const fecha = parsearFecha(marcaTemporal);

    const empe = await getInventarioByNumero(numero);

    if (!empe) return res.json({ ok: false, mensaje: 'ARTICULO NO ENCONTRADO' });

    const rowFinal = {
      ...empe,
      RETIROS: retiro,
      'FECHA RETIRO': fecha
    };

    // Orden secuencial para garantizar trazabilidad en HISTORIAL:
    //   1) actualizamos INVENTARIO (la accion de negocio)
    //   2) registramos SIEMPRE en HISTORIAL (con reintentos dentro)
    //   3) sincronizamos la tabla RETIROS
    // Si el paso 2 fallara despues de reintentos, propagamos el error
    // para que el frontend lo vea; pero si llegamos al paso 3, la
    // operacion quedo 100% auditada.
    const { error: updError } = await supabase.from('INVENTARIO').update({
      RETIROS: retiro,
      'FECHA RETIRO': fecha
    }).eq('NUMERO', numero);
    if (updError) throw updError;

    await insertHistorial({
      fecha,
      oper: turno,
      tipo: 'PEDIR_SIN_PAGAR',
      numero,
      nombre: empe['NOMBRE'],
      cc: empe['CC'],
      art: empe['ART'],
      descripcion: empe['DESCRIPCION'],
      detalle: { RETIRO: retiro }
    });

    // OPER de la tabla RETIROS = operador que hizo el PEDIR_SIN_PAGAR
    // (no el del INGRESO). Asi la trazabilidad en RETIROS es correcta.
    await syncRetirosFromInventario(rowFinal, turno);

    res.json({ ok: true });
  } catch (error) {
    console.error('Error PEDIR_SIN_PAGAR:', error);
    res.status(500).json({ error: error.message });
  }
};
