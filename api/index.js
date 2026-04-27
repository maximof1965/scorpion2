const handlers = {
  ingreso: require('../lib/handlers/ingreso'),
  abono: require('../lib/handlers/abono'),
  intereses: require('../lib/handlers/intereses'),
  pedir_sin_pagar: require('../lib/handlers/pedir_sin_pagar'),
  espera: require('../lib/handlers/espera'),
  salida: require('../lib/handlers/salida'),
  aumento: require('../lib/handlers/aumento'),
  ventas: require('../lib/handlers/ventas'),
  devolucion: require('../lib/handlers/devolucion'),
  bar: require('../lib/handlers/bar'),
  guardadero: require('../lib/handlers/guardadero'),
  gastos: require('../lib/handlers/gastos'),
  caja: require('../lib/handlers/caja'),
  buscar: require('../lib/handlers/buscar'),
  verificar: require('../lib/handlers/verificar'),
  control: require('../lib/handlers/control'),
  buscar_live: require('../lib/handlers/buscar_live'),
  ventas_lote: require('../lib/handlers/ventas_lote'),
  admin_login: require('../lib/handlers/admin_login'),
  admin_data: require('../lib/handlers/admin_data'),
  editar: require('../lib/handlers/editar'),
  recalcular_tot_in: require('../lib/handlers/recalcular_tot_in'),
  metricas: require('../lib/handlers/metricas'),
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const segments = url.pathname.split('/').filter(Boolean);
  const route = segments[1] || segments[0];

  if (route === 'health') {
    return res.json({ ok: true, timestamp: new Date().toISOString() });
  }

  const handler = handlers[route];
  if (!handler) {
    return res.status(404).json({ error: `Ruta /api/${route} no encontrada` });
  }

  return handler(req, res);
};
