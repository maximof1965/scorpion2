const supabase = require('../supabase');
const { buildLoosePattern, toUpper, recomputarFilaInventario } = require('../db');

module.exports = async (req, res) => {
  try {
    const {
      numero: numeroRaw,
      nombre_completo: nombreRaw,
      cedula: cedulaRaw
    } = req.query;

    const numero = numeroRaw ? parseInt(numeroRaw) : null;
    const cedula = (cedulaRaw || '').trim();
    const nombre = toUpper(nombreRaw);

    if (!numero && !cedula && !nombre) return res.json([]);

    let data = [];

    if (numero) {
      const { data: result, error } = await supabase
        .from('INVENTARIO')
        .select('*')
        .eq('NUMERO', numero)
        .limit(10);
      if (error) throw error;
      data = result || [];
    } else if (cedula) {
      const { data: result, error } = await supabase
        .from('INVENTARIO')
        .select('*')
        .eq('CC', cedula)
        .limit(10);
      if (error) throw error;
      data = result || [];
    } else if (nombre) {
      const exactLike = await supabase
        .from('INVENTARIO')
        .select('*')
        .ilike('NOMBRE', `%${nombre}%`)
        .limit(10);

      if (exactLike.error) throw exactLike.error;
      data = exactLike.data || [];

      if (data.length === 0) {
        const pattern = buildLoosePattern(nombre);
        const { data: fallback, error } = await supabase
          .from('INVENTARIO')
          .select('*')
          .ilike('NOMBRE', `%${pattern}%`)
          .limit(10);
        if (error) throw error;
        data = fallback || [];
      }
    }

    // Recalcular TOT IN, TOTAL y UTIL al vuelo (avanzan con el tiempo).
    const ahora = new Date();
    data = data.map(r => recomputarFilaInventario(r, ahora));

    const resultado = data.map(e => ({
      FECHA: e['FECHA'],
      OPER: e['OPER'],
      NUMERO: e['NUMERO'],
      'VR PR': e['VR PR'],
      'VR RT': e['VR RT'],
      NOMBRE: e['NOMBRE'] || '',
      CC: e['CC'] || '',
      ART: e['ART'],
      DESCRIPCION: e['DESCRIPCION'],
      LLEVAR: e['LLEVAR'],
      'VR IN': e['VR IN'],
      'TOT IN': e['TOT IN'],
      'FECHA INT': e['FECHA INT'],
      'VR AB': e['VR AB'],
      'FECHA ABON': e['FECHA ABON'],
      ESPERA: e['ESPERA'],
      RETIROS: e['RETIROS'],
      'FECHA RETIRO': e['FECHA RETIRO'],
      'DES.': e['DES'],
      AUMENTO: e['AUMENTO'],
      'FECHA AU': e['FECHA AU'],
      TOTAL: e['TOTAL'],
      UTIL: e['UTIL']
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error BUSCAR:', error);
    res.status(500).json({ error: error.message });
  }
};
