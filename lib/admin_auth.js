function leerPassword(req, body = null) {
  const headerPwd = req.headers['x-admin-password'];
  if (headerPwd) return headerPwd;
  if (body && body.password) return body.password;
  if (req.body && typeof req.body === 'object' && req.body.password) {
    return req.body.password;
  }
  if (req.query && req.query.password) return req.query.password;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const qp = url.searchParams.get('password');
    if (qp) return qp;
  } catch (_) {}
  return null;
}

function passwordValido(req, body = null) {
  const esperado = process.env.ADMIN_PASSWORD;
  if (!esperado) return false;
  const recibido = leerPassword(req, body);
  if (!recibido) return false;
  return String(recibido) === String(esperado);
}

function exigirAuth(req, res, body = null) {
  if (!passwordValido(req, body)) {
    res.status(401).json({ ok: false, error: 'Clave incorrecta o ADMIN_PASSWORD no configurado en Vercel' });
    return false;
  }
  return true;
}

module.exports = { passwordValido, exigirAuth };
