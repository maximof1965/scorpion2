const supabase = require('../supabase');
const { buildLoosePattern, toUpper } = require('../db');

// Cantidad maxima de sugerencias. Con el dropdown con scroll ya no tiene
// sentido limitarlo a 8. 25 es un buen balance: mas que suficiente para
// apellidos comunes ("gomez", "garcia") y sigue siendo rapido en red
// lenta. Se puede sobrescribir por query con ?limit=N (tope 50).
const LIMITE_POR_DEFECTO = 25;
const LIMITE_MAXIMO = 50;

module.exports = async (req, res) => {
  try {
    const { campo, q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const limiteParam = parseInt(req.query.limit, 10);
    const limite = Math.min(
      LIMITE_MAXIMO,
      Number.isFinite(limiteParam) && limiteParam > 0 ? limiteParam : LIMITE_POR_DEFECTO
    );

    const termino = toUpper(q);
    let data = [];

    if (campo === 'numero') {
      const digits = termino.replace(/\D/g, '');
      if (!digits) return res.json([]);
      const lower = parseInt(digits + '0'.repeat(Math.max(0, 6 - digits.length)));
      const upper = parseInt(digits + '9'.repeat(Math.max(0, 6 - digits.length)));
      const { data: result } = await supabase
        .from('INVENTARIO')
        .select('*')
        .gte('NUMERO', lower)
        .lte('NUMERO', upper)
        .order('NUMERO', { ascending: true })
        .limit(limite);
      data = result || [];
    } else if (campo === 'cedula') {
      const { data: result } = await supabase
        .from('INVENTARIO')
        .select('*')
        .ilike('CC', `%${termino}%`)
        .order('NUMERO', { ascending: false })
        .limit(limite);
      data = result || [];
    } else if (campo === 'nombre') {
      const { data: exact } = await supabase
        .from('INVENTARIO')
        .select('*')
        .ilike('NOMBRE', `%${termino}%`)
        .order('NOMBRE', { ascending: true })
        .limit(limite);

      data = exact || [];
      if (data.length === 0) {
        const pattern = buildLoosePattern(termino);
        const { data: fallback } = await supabase
          .from('INVENTARIO')
          .select('*')
          .ilike('NOMBRE', `%${pattern}%`)
          .order('NOMBRE', { ascending: true })
          .limit(limite);
        data = fallback || [];
      }
    }

    const resultado = data.map(e => ({
      NUMERO: e['NUMERO'],
      NOMBRE: e['NOMBRE'] || '',
      CC: e['CC'] || '',
      ART: e['ART'] || '',
      'VR PR': e['VR PR'],
      'VR RT': e['VR RT']
    }));

    res.json(resultado);
  } catch (error) {
    console.error('Error BUSCAR_LIVE:', error);
    res.status(500).json({ error: error.message });
  }
};
