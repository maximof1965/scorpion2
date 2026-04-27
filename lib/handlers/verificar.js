const supabase = require('../supabase');

module.exports = async (req, res) => {
  try {
    const { 'Marca temporal': marcaTemporal } = req.query;

    const fechaStr = (marcaTemporal || '').split(' ')[0];
    const partes = fechaStr.split('/');
    if (partes.length < 3) return res.json([]);

    const dia = partes[0].padStart(2, '0');
    const mes = partes[1].padStart(2, '0');
    const anioRaw = partes[2];
    const anio = anioRaw.length === 2 ? '20' + anioRaw : anioRaw;
    const fechaISO = `${anio}-${mes}-${dia}`;

    const [empenosRes, salidasRes] = await Promise.all([
      supabase
        .from('INVENTARIO')
        .select('*')
        .gte('FECHA', `${fechaISO}T00:00:00`)
        .lte('FECHA', `${fechaISO}T23:59:59`),

      supabase
        .from('SALIDAS')
        .select('*')
        .gte('FECHA', `${fechaISO}T00:00:00`)
        .lte('FECHA', `${fechaISO}T23:59:59`)
    ]);

    const empenosData = empenosRes.data || [];
    const salidasData = salidasRes.data || [];
    const numerosEnSalidas = new Set(salidasData.map(s => s['NUMERO']));

    const cmpNumero = (a, b) => {
      const na = Number(a.NUMERO);
      const nb = Number(b.NUMERO);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return String(a.NUMERO).localeCompare(String(b.NUMERO));
    };

    const grupo1 = empenosData
      .filter(e => !numerosEnSalidas.has(e['NUMERO']))
      .map(e => ({
        grupo: 'GRUPO 1',
        FECHA: e['FECHA'],
        OPER: e['OPER'],
        NUMERO: e['NUMERO'],
        'VR PR': e['VR PR'],
        'VR RT': e['VR RT'],
        NOMBRE: e['NOMBRE'] || ''
      }))
      .sort(cmpNumero);

    const grupo2 = salidasData
      .map(s => ({
        grupo: 'GRUPO 2',
        'FECHA SALIDA': s['FECHA'],
        OPER: s['OPER'],
        NUMERO: s['NUMERO'],
        'VR AB': s['VR AB'],
        DES: s['DES']
      }))
      .sort(cmpNumero);

    res.json([...grupo1, ...grupo2]);
  } catch (error) {
    console.error('Error VERIFICAR:', error);
    res.status(500).json({ error: error.message });
  }
};
