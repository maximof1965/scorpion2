const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const {
  toUpper,
  recomputarFilaInventario,
  numeroExisteGlobal,
  upsertCajaDelta,
  insertHistorial
} = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      identificador,
      'VALOR (ING) ': valorRaw,
      'V RETIRO(ING) ': vRetiroRaw,
      'NOMBRE COMPLETO(ING) ': nombreRaw,
      'CEDULA(ING) ': cedulaRaw,
      'ART(ING)': artRaw,
      DESCRIPCION: descRaw,
      LLEVAR: llevarRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const numero = parseInt(identificador);
    const vrPrestado = parseFloat(valorRaw) || 0;
    const vrRetiro = parseFloat(vRetiroRaw) || 0;
    const nombre = toUpper(nombreRaw);
    const cedula = (cedulaRaw || '').trim();
    const art = toUpper(artRaw);
    const descripcion = toUpper(descRaw, 'NULO');
    const llevar = toUpper(llevarRaw);
    const fecha = parsearFecha(marcaTemporal);

    if (await numeroExisteGlobal(numero)) {
      return res.json({
        ok: false,
        duplicado: true,
        numero,
        mensaje: 'EL NUMERO DE ARTICULO YA ESTA INGRESADO'
      });
    }

    const rowBase = {
      FECHA: fecha,
      OPER: turno,
      NUMERO: numero,
      'VR PR': vrPrestado,
      'VR RT': vrRetiro,
      NOMBRE: nombre,
      CC: cedula,
      ART: art,
      DESCRIPCION: descripcion,
      LLEVAR: llevar,
      'VR IN': 0,
      'TOT IN': 0,
      'FECHA INT': null,
      'VR AB': 0,
      'FECHA ABON': null,
      ESPERA: '',
      RETIROS: '',
      'FECHA RETIRO': null,
      DES: 0,
      AUMENTO: '',
      'FECHA AU': null,
      TOTAL: 0,
      UTIL: 0
    };
    // Calcula TOT IN inicial (= 0 al ingreso, pues meses=0), TOTAL y UTIL.
    const row = recomputarFilaInventario(rowBase, new Date(fecha));

    await Promise.all([
      supabase.from('INVENTARIO').insert(row),
      upsertCajaDelta(fecha, turno, 'CONTRATOS', vrPrestado),
      insertHistorial({
        fecha,
        oper: turno,
        tipo: 'INGRESO',
        numero,
        nombre,
        cc: cedula,
        art,
        descripcion,
        valor: vrPrestado,
        detalle: { 'VR RT': vrRetiro, LLEVAR: llevar }
      })
    ]);

    res.json({ mensaje: 'INGRESADO CORRECTAMENTE' });
  } catch (error) {
    console.error('Error INGRESO:', error);
    res.status(500).json({ mensaje: 'ERROR INTERNO', error: error.message });
  }
};
