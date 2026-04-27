const supabase = require('./supabase');
const { extraerFechaDate } = require('./helpers');

const INVENTARIO_FIELDS = [
  'FECHA', 'OPER', 'NUMERO', 'VR PR', 'VR RT', 'NOMBRE', 'CC', 'ART',
  'DESCRIPCION', 'LLEVAR', 'VR IN', 'TOT IN', 'FECHA INT', 'VR AB',
  'FECHA ABON', 'ESPERA', 'RETIROS', 'FECHA RETIRO', 'DES', 'AUMENTO',
  'FECHA AU', 'TOTAL', 'UTIL'
];

function toCajaFecha(fechaISO) {
  return `${extraerFechaDate(fechaISO)}T00:00:00Z`;
}

function toUpper(value, fallback = '') {
  return (value || fallback).toString().toUpperCase().trim();
}

function toNumber(value, fallback = 0) {
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(num);
}

function buildLoosePattern(texto) {
  return texto
    .split('')
    .filter(Boolean)
    .join('%');
}

function formatDetalle(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}:${value}`)
    .join(' - ');
}

// ----------------------------------------------------------
// CALCULOS DEL NEGOCIO (TOT IN, TOTAL, UTIL)
// ----------------------------------------------------------
//
// TOT IN = pendiente actual de intereses por cobrar al cliente.
//   base                = VR RT - VR PR   (interes de 1 mes)
//   mesesCumplidos      = meses calendario completos desde FECHA hasta hoy
//                         (respeta "mismo dia del mes")
//   interesEsperado     = base * mesesCumplidos
//   TOT IN              = max(0, interesEsperado - VR IN)
//
// IMPORTANTE: al INGRESAR un articulo TOT IN = 0, porque aun no ha
// pasado ningun mes completo. Solo cuando se cumple el primer mes
// (mismo dia del mes siguiente) se carga la primera tanda de interes.
// Si el cliente paga intereses dentro de ese mes, VR IN >= base y
// TOT IN sigue siendo 0 hasta que llegue el siguiente mes.
//
// UTIL = utilidad realmente realizada del contrato.
//   UTIL = VR AB + VR IN - DES - VR PR
//
// TOTAL = lo que el cliente debe pagar para retirar el articulo HOY.
//   TOTAL = VR RT + TOT IN - VR AB - DES
// ----------------------------------------------------------

function mesesCalendario(fechaIni, fechaFin) {
  if (!fechaIni) return 0;
  const ini = (fechaIni instanceof Date) ? fechaIni : new Date(fechaIni);
  const fin = (fechaFin instanceof Date) ? fechaFin : new Date(fechaFin || Date.now());
  if (isNaN(ini.getTime()) || isNaN(fin.getTime())) return 0;

  let meses =
    (fin.getUTCFullYear() - ini.getUTCFullYear()) * 12 +
    (fin.getUTCMonth() - ini.getUTCMonth());

  // Si todavia no llego el "mismo dia del mes", resta 1.
  if (fin.getUTCDate() < ini.getUTCDate()) meses -= 1;

  return Math.max(0, meses);
}

function calcularTotIn(row, hoy) {
  const vrPr = toNumber(row['VR PR']);
  const vrRt = toNumber(row['VR RT']);
  const vrIn = toNumber(row['VR IN']);
  const base = Math.max(0, vrRt - vrPr);
  if (base === 0) return 0;
  const meses = mesesCalendario(row['FECHA'], hoy);
  // Al ingreso (meses=0) TOT IN = 0. Solo al cumplirse el primer mes
  // (mismo dia del mes siguiente) empieza a acumular.
  const esperado = base * meses;
  return Math.max(0, esperado - vrIn);
}

function calcularUtil(rowOrVrPr, vrRt) {
  // Compatibilidad: si recibe (vrPr, vrRt) -> formula vieja (no se usa pero por seguridad)
  if (typeof rowOrVrPr !== 'object' || rowOrVrPr === null) {
    return toNumber(vrRt) - toNumber(rowOrVrPr);
  }
  const row = rowOrVrPr;
  // UTIL = dinero realmente recibido por el negocio - capital prestado.
  // El DESCUENTO (DES) NO se resta aqui: ya esta implicito en VR AB
  // (si el cliente debia 40 y pagamos 2 de descuento, VR AB = 38, que
  //  es exactamente lo que entro). Restar DES contaria el descuento
  //  dos veces y reduciria la utilidad de manera incorrecta.
  return (
    toNumber(row['VR AB']) +
    toNumber(row['VR IN']) -
    toNumber(row['VR PR'])
  );
}

function calcularTotal(row) {
  return (
    toNumber(row['VR RT']) +
    toNumber(row['TOT IN']) -
    toNumber(row['VR AB']) -
    toNumber(row.DES)
  );
}

// Recalcula TOT IN, TOTAL y UTIL de una fila de INVENTARIO en base a la HORA actual.
// Devuelve el row con esos 3 campos sobreescritos.
function recomputarFilaInventario(row, hoy) {
  if (!row) return row;
  const totIn = calcularTotIn(row, hoy);
  const conTotIn = { ...row, 'TOT IN': totIn };
  return {
    ...conTotIn,
    'TOT IN': totIn,
    TOTAL: calcularTotal(conTotIn),
    UTIL: calcularUtil(conTotIn)
  };
}

async function getInventarioByNumero(numero) {
  const { data, error } = await supabase
    .from('INVENTARIO')
    .select('*')
    .eq('NUMERO', numero)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

async function numeroExisteGlobal(numero) {
  const checks = await Promise.all([
    supabase.from('INVENTARIO').select('NUMERO').eq('NUMERO', numero).maybeSingle(),
    supabase.from('SALIDAS').select('NUMERO').eq('NUMERO', numero).maybeSingle(),
    supabase.from('VENDIDO').select('NUMERO').eq('NUMERO', numero).maybeSingle()
  ]);

  return checks.some(({ data }) => !!data);
}

function pickInventarioRow(row, overrides = {}) {
  const base = {};
  for (const field of INVENTARIO_FIELDS) {
    base[field] = row[field] ?? null;
  }
  return { ...base, ...overrides };
}

async function upsertCajaDelta(fechaISO, turno, campo, valor) {
  const fechaCaja = toCajaFecha(fechaISO);

  await supabase
    .from('CAJA')
    .upsert({ FECHA: fechaCaja, TURNO: turno }, { onConflict: 'FECHA,TURNO' });

  const { data: row, error: rowError } = await supabase
    .from('CAJA')
    .select('*')
    .eq('FECHA', fechaCaja)
    .eq('TURNO', turno)
    .single();

  if (rowError) throw rowError;

  const nuevoValor = toNumber(row[campo]) + toNumber(valor);

  const { error } = await supabase
    .from('CAJA')
    .update({ [campo]: nuevoValor })
    .eq('FECHA', fechaCaja)
    .eq('TURNO', turno);

  if (error) throw error;
}

async function setCajaBase(fechaISO, turno, valor) {
  const fechaCaja = toCajaFecha(fechaISO);

  const { error } = await supabase
    .from('CAJA')
    .upsert({ FECHA: fechaCaja, TURNO: turno, BASE: toNumber(valor) }, { onConflict: 'FECHA,TURNO' });

  if (error) throw error;
}

async function getCaja(fechaISO, turno) {
  const fechaCaja = toCajaFecha(fechaISO);
  const { data, error } = await supabase
    .from('CAJA')
    .select('*')
    .eq('FECHA', fechaCaja)
    .eq('TURNO', turno)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data || null;
}

// Insert al HISTORIAL con reintentos automaticos.
// HISTORIAL es la fuente de auditoria #1: si un glitch de red tumba
// este insert y no lo reintentamos, esa operacion se pierde para
// siempre de la bitacora y no aparecera en EDITAR. Por eso hacemos
// 3 reintentos con backoff exponencial antes de rendirnos.
async function insertHistorial({
  fecha,
  oper,
  tipo,
  numero = null,
  nombre = '',
  cc = '',
  art = '',
  descripcion = '',
  valor = null,
  detalle = ''
}) {
  const payload = {
    FECHA: fecha,
    OPER: oper || '',
    TIPO: tipo,
    NUMERO: numero,
    NOMBRE: nombre || '',
    CC: cc || '',
    ART: art || '',
    DESCRIPCION: descripcion || '',
    VALOR: valor,
    DETALLE: formatDetalle(detalle)
  };

  const MAX_INTENTOS = 3;
  let ultimoError = null;
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    const { error } = await supabase.from('HISTORIAL').insert(payload);
    if (!error) return; // OK
    ultimoError = error;
    console.error(
      `[HISTORIAL insert] intento ${intento}/${MAX_INTENTOS} fallo para TIPO=${tipo} NUMERO=${numero}:`,
      error.message || error
    );
    if (intento < MAX_INTENTOS) {
      const espera = 150 * Math.pow(3, intento - 1); // 150ms, 450ms, 1350ms
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw ultimoError;
}

// syncRetirosFromInventario:
// Si el articulo queda marcado para retirar, copiamos su fila al RETIROS.
// El parametro `operActivo` permite sobreescribir la columna OPER con el
// turno del operador que ESTA haciendo la operacion (pedir_sin_pagar o
// abono con RETIRAR). Si no se pasa, se conserva el OPER del inventario
// (que es el del INGRESO original) — util para sync internos donde no
// hubo cambio de estado RETIROS.
async function syncRetirosFromInventario(row, operActivo = null) {
  const needsRetiro = ['RETIRAR', 'RETIRAR, MAÑANA', 'MAÑANA'].includes((row['RETIROS'] || '').toString().toUpperCase());

  if (!needsRetiro) {
    const { error } = await supabase.from('RETIROS').delete().eq('NUMERO', row['NUMERO']);
    if (error) throw error;
    return;
  }

  const payload = pickInventarioRow(row);
  if (operActivo !== null && operActivo !== undefined && String(operActivo).trim() !== '') {
    payload.OPER = String(operActivo).trim();
  }
  const { error } = await supabase
    .from('RETIROS')
    .upsert(payload, { onConflict: 'NUMERO' });

  if (error) throw error;
}

async function removeRetiro(numero) {
  const { error } = await supabase.from('RETIROS').delete().eq('NUMERO', numero);
  if (error) throw error;
}

module.exports = {
  INVENTARIO_FIELDS,
  toCajaFecha,
  toUpper,
  toNumber,
  buildLoosePattern,
  formatDetalle,
  mesesCalendario,
  calcularTotIn,
  calcularUtil,
  calcularTotal,
  recomputarFilaInventario,
  getInventarioByNumero,
  numeroExisteGlobal,
  pickInventarioRow,
  upsertCajaDelta,
  setCajaBase,
  getCaja,
  insertHistorial,
  syncRetirosFromInventario,
  removeRetiro
};
