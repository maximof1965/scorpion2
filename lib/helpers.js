// ZONA HORARIA DEL NEGOCIO
// La app se opera desde Colombia (UTC-05:00). Para que el filtro
// "operaciones de hoy" del frontend coincida con lo que el backend
// almacena, todas las fechas que genera el servidor se expresan en
// hora local Colombia pero serializadas como "...Z" (UTC aparente).
// Asi el sistema es internamente consistente: frontend y backend
// usan la misma hora mural, independiente de la zona del servidor.
const TZ_OFFSET_MIN = 5 * 60; // Colombia = UTC-05:00

function isoSinMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Componentes "mural Colombia" de un Date dado (usa los metodos UTC
// del Date desplazado por el offset, por eso no depende del TZ del
// proceso Node).
function fechaColombia(date) {
  const ajustado = new Date(date.getTime() - TZ_OFFSET_MIN * 60 * 1000);
  const y  = ajustado.getUTCFullYear();
  const m  = String(ajustado.getUTCMonth() + 1).padStart(2, '0');
  const d  = String(ajustado.getUTCDate()).padStart(2, '0');
  const hh = String(ajustado.getUTCHours()).padStart(2, '0');
  const mm = String(ajustado.getUTCMinutes()).padStart(2, '0');
  const ss = String(ajustado.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}Z`;
}

function ahoraISO() {
  return fechaColombia(new Date());
}

// Recibe "DD/MM/YYYY HH:mm:ss" (hora local del operador) y devuelve
// "YYYY-MM-DDTHH:mm:ssZ" conservando la hora tal cual, sin aplicar
// conversion de zona horaria (es el mismo "mural" pero formateado).
function parsearFecha(marcaTemporal) {
  if (!marcaTemporal) return ahoraISO();
  const [fechaStr, horaStr = '00:00:00'] = String(marcaTemporal).split(' ');
  const partes = fechaStr.split('/');
  if (partes.length < 3) return ahoraISO();
  const dia = partes[0].padStart(2, '0');
  const mes = partes[1].padStart(2, '0');
  const anio = partes[2].length === 2 ? '20' + partes[2] : partes[2];
  const hp = horaStr.split(':');
  const hh = (hp[0] || '00').padStart(2, '0');
  const mm = (hp[1] || '00').padStart(2, '0');
  const ss = (hp[2] || '00').padStart(2, '0');
  return `${anio}-${mes}-${dia}T${hh}:${mm}:${ss}Z`;
}

function extraerFechaDate(fechaISO) {
  return fechaISO.split('T')[0];
}

module.exports = { parsearFecha, extraerFechaDate, isoSinMs, ahoraISO, fechaColombia };
