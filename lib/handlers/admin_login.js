const { passwordValido } = require('../admin_auth');
const { leerBody } = require('../read_body');

module.exports = async (req, res) => {
  const body = await leerBody(req);
  const ok = passwordValido(req, body);
  if (!ok) {
    return res.status(401).json({
      ok: false,
      error: process.env.ADMIN_PASSWORD
        ? 'Clave incorrecta'
        : 'Falta configurar ADMIN_PASSWORD en Vercel'
    });
  }
  return res.json({ ok: true });
};
