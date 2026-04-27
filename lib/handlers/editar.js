// Handler EDITAR
//
// Permite listar las operaciones de un turno+tipo+dia desde HISTORIAL y
// aplicar una edicion sobre la fila origen (INVENTARIO / SALIDAS /
// BAR / GUARDADERO / GASTOS / CAJA), ajustando CAJA con la diferencia
// (delta) y dejando un registro adicional en HISTORIAL con tipo
// EDICION_<TIPO> para auditoria.

const supabase = require('../supabase');
const { parsearFecha, ahoraISO } = require('../helpers');
const {
  getInventarioByNumero,
  upsertCajaDelta,
  insertHistorial,
  syncRetirosFromInventario,
  removeRetiro,
  calcularUtil,
  calcularTotal,
  recomputarFilaInventario,
  toUpper,
  toNumber,
  toCajaFecha
} = require('../db');
const { leerBody } = require('../read_body');

// Tipos que el frontend puede editar (todos menos BUSCAR, VENTAS,
// CONTROL, VERIFICAR, TABLAS).
const TIPOS_EDITABLES = new Set([
  'INGRESO', 'ABONO', 'INTERESES', 'RETIROS', 'SALIDA',
  'DEVOLUCION', 'AUMENTO', 'DESCUENTO', 'GUARDADERO',
  'BAR', 'GASTOS', 'CAJA'
]);

// Mapeo de tipo visible -> tipo guardado en HISTORIAL.
// El usuario ve "RETIROS" pero los handlers lo escriben como
// PEDIR_SIN_PAGAR.
const TIPO_HISTORIAL = {
  RETIROS: 'PEDIR_SIN_PAGAR'
};

function leerParam(req, body, nombre) {
  if (body && body[nombre] !== undefined) return body[nombre];
  if (req && req.query && req.query[nombre] !== undefined) return req.query[nombre];
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const v = url.searchParams.get(nombre);
    if (v !== null) return v;
  } catch (_) {}
  return null;
}

// --------------------------------------------------------------
// LISTADO
// --------------------------------------------------------------
async function listarOperaciones({ turno, tipo, fechaStr, desdeISO, hastaISO }) {
  // Si el frontend manda desde/hasta (ISO completos calculados desde la
  // hora local del navegador) los usamos tal cual. Asi no se pierden
  // operaciones por la diferencia entre la fecha UTC y la fecha local.
  let desde, hasta;
  if (desdeISO && hastaISO) {
    desde = desdeISO;
    hasta = hastaISO;
  } else {
    const fechaBase = (fechaStr && fechaStr.length >= 10)
      ? fechaStr.slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    desde = `${fechaBase}T00:00:00Z`;
    hasta = `${fechaBase}T23:59:59Z`;
  }

  const tipoHist = TIPO_HISTORIAL[tipo] || tipo;
  const turnoStr = String(turno ?? '').trim();

  // Aceptamos variantes de OPER ("1", " 1", "1 ", etc.) por si en algun
  // registro antiguo llego con espacios o en otro formato.
  const opersAceptados = Array.from(new Set([
    turnoStr,
    ` ${turnoStr}`,
    `${turnoStr} `,
    turnoStr.toUpperCase(),
    turnoStr.toLowerCase()
  ]));

  // 1) HISTORIAL es la fuente principal.
  const { data: rowsHist, error } = await supabase
    .from('HISTORIAL')
    .select('*')
    .in('OPER', opersAceptados)
    .eq('TIPO', tipoHist)
    .gte('FECHA', desde)
    .lte('FECHA', hasta)
    .order('FECHA', { ascending: false });

  if (error) throw error;
  let rows = rowsHist || [];

  // 2) AUTO-REPARACION: para RETIROS y SALIDA, cruzamos con la tabla
  //    fuente. Si encontramos una operacion en la tabla fuente que NO
  //    tiene entrada en HISTORIAL, la creamos AHORA (con reintento) y
  //    la incluimos en la respuesta. Asi los operadores recuperan
  //    cualquier operacion que se haya "perdido" de la bitacora por
  //    un glitch pasado.
  const clavesHist = new Set(rows.map(r => `${r.NUMERO}`));

  async function reparar(tablaSrc, fechaCol, tipoGuardado, detalleFn) {
    const { data: extra, error: errX } = await supabase
      .from(tablaSrc)
      .select('*')
      .gte(fechaCol, desde)
      .lte(fechaCol, hasta);
    if (errX || !extra || extra.length === 0) return;

    for (const r of extra) {
      // Filtrar por turno si la fila fuente tiene OPER valido.
      if (r.OPER !== undefined && r.OPER !== null && String(r.OPER).trim() !== '') {
        const op = String(r.OPER).trim();
        if (!opersAceptados.includes(op)) continue;
      }
      if (clavesHist.has(`${r.NUMERO}`)) continue;

      // Crear la entrada faltante en HISTORIAL.
      const fechaFuente = r[fechaCol];
      const nuevoHist = {
        fecha: fechaFuente,
        oper: (r.OPER && String(r.OPER).trim()) || turnoStr,
        tipo: tipoGuardado,
        numero: r.NUMERO,
        nombre: r.NOMBRE || '',
        cc: r.CC || '',
        art: r.ART || '',
        descripcion: r.DESCRIPCION || '',
        valor: r.VALOR ?? null,
        detalle: detalleFn ? detalleFn(r) : ''
      };
      try {
        await insertHistorial(nuevoHist);
        clavesHist.add(`${r.NUMERO}`);
        // Incluirla en el listado para que el operador pueda editarla.
        rows.push({
          FECHA: nuevoHist.fecha,
          OPER: nuevoHist.oper,
          TIPO: nuevoHist.tipo,
          NUMERO: nuevoHist.numero,
          NOMBRE: nuevoHist.nombre,
          CC: nuevoHist.cc,
          ART: nuevoHist.art,
          DESCRIPCION: nuevoHist.descripcion,
          VALOR: nuevoHist.valor,
          DETALLE: typeof nuevoHist.detalle === 'string'
            ? nuevoHist.detalle
            : JSON.stringify(nuevoHist.detalle)
        });
      } catch (e) {
        console.error('[editar/listar] no pude reparar HISTORIAL:', e.message || e);
      }
    }
  }

  if (tipo === 'RETIROS') {
    await reparar('RETIROS', 'FECHA RETIRO', 'PEDIR_SIN_PAGAR',
      (r) => `RETIRO:${r.RETIROS || ''}`);
  } else if (tipo === 'SALIDA') {
    await reparar('SALIDAS', 'FECHA', 'SALIDA',
      (r) => `DES:${r.DES || 0}`);
  }

  // Orden final por fecha DESC.
  rows.sort((a, b) => String(b.FECHA || '').localeCompare(String(a.FECHA || '')));

  return { ok: true, rows };
}

// --------------------------------------------------------------
// HELPERS comunes para las ediciones
// --------------------------------------------------------------
function delta(antes, despues) {
  return toNumber(despues) - toNumber(antes);
}

// Parsear strings tipo "AUMENTO:10 - PAGO_AUMENTO:15" o JSON
function parseDetalle(detalleRaw) {
  if (!detalleRaw) return {};
  if (typeof detalleRaw === 'object') return detalleRaw;
  const s = String(detalleRaw).trim();
  if (!s) return {};
  // Intentar JSON primero
  if (s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.parse(s); } catch (_) { /* sigue al modo texto */ }
  }
  const out = {};
  s.split(/\s+-\s+/).forEach(part => {
    const idx = part.indexOf(':');
    if (idx <= 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

async function ajustarCaja(fechaOrigISO, turnoOrig, campo, deltaValor) {
  if (!deltaValor) return;
  await upsertCajaDelta(fechaOrigISO, turnoOrig, campo, deltaValor);
}

// moverCaja:
// Ajusta CAJA reconociendo si el turno cambio. Si el operador corrigio
// el turno de la operacion original (e.g. apunto mal al hacer la
// transaccion), restamos el monto ORIGINAL del turno viejo y sumamos
// el monto NUEVO en el turno corregido. Si el turno no cambio, se
// aplica el delta clasico (nuevo - viejo) al mismo turno.
async function moverCaja(fechaOrigISO, turnoOrig, turnoNuevo, campo, valorAntes, valorNuevo, signo = 1) {
  if (!campo) return;
  const vAntes = toNumber(valorAntes) * signo;
  const vNuevo = toNumber(valorNuevo) * signo;
  const mismoTurno = String(turnoOrig || '').trim() === String(turnoNuevo || '').trim();

  if (mismoTurno) {
    const d = vNuevo - vAntes;
    if (d) await upsertCajaDelta(fechaOrigISO, turnoOrig, campo, d);
    return;
  }
  if (vAntes) await upsertCajaDelta(fechaOrigISO, turnoOrig, campo, -vAntes);
  if (vNuevo) await upsertCajaDelta(fechaOrigISO, turnoNuevo, campo, vNuevo);
}

// Actualizar la columna OPER del registro ORIGINAL en HISTORIAL.
// Si se cambio el NUMERO en la edicion (caso INGRESO), pasamos
// numeroNuevo para actualizar tambien por ese criterio.
async function actualizarOperHistorial(original, turnoNuevo, numeroNuevo = null) {
  if (!turnoNuevo) return;
  const turnoOrig = String(original.OPER || '').trim();
  if (String(turnoNuevo).trim() === turnoOrig) return;
  const numeroBuscar = numeroNuevo != null ? numeroNuevo : original.NUMERO;

  let q = supabase.from('HISTORIAL')
    .update({ OPER: String(turnoNuevo) })
    .eq('FECHA', original.FECHA)
    .eq('TIPO', original.TIPO)
    .eq('OPER', turnoOrig);
  if (numeroBuscar != null && numeroBuscar !== '') {
    q = q.eq('NUMERO', numeroBuscar);
  }
  const { error } = await q;
  if (error) console.error('[editar] No pude actualizar OPER en HISTORIAL:', error.message || error);
}

async function registrarEdicion({ tipoOriginal, original, resumenCambios, valorAhora, turnoEditor }) {
  // El registro EDICION_XXX lleva el OPER del operador que EDITA
  // (si no vino, usa el original como fallback para no quedar en blanco).
  await insertHistorial({
    fecha: ahoraISO(),
    oper: (turnoEditor && String(turnoEditor).trim()) || original.OPER || '',
    tipo: `EDICION_${tipoOriginal}`,
    numero: original.NUMERO || null,
    nombre: original.NOMBRE || '',
    cc: original.CC || '',
    art: original.ART || '',
    descripcion: original.DESCRIPCION || '',
    valor: valorAhora ?? null,
    detalle: resumenCambios
  });
}

// --------------------------------------------------------------
// EDITORES POR TIPO
// --------------------------------------------------------------

async function editarIngreso(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numeroOrig = parseInt(original.NUMERO, 10);
  if (!numeroOrig) throw new Error('La operacion original no tiene NUMERO');

  const empe = await getInventarioByNumero(numeroOrig);
  if (!empe) throw new Error(`Articulo ${numeroOrig} no existe en INVENTARIO`);

  // El frontend manda el NUMERO (posiblemente corregido) en
  // `nuevo.identificador`. Si difiere del original, cambiamos la PK
  // del articulo despues de validar.
  const numNuevoRaw = nuevo.identificador ?? nuevo.NUMERO ?? nuevo['NUMERO(ING)'];
  const numeroNuevo = parseInt(numNuevoRaw, 10) || numeroOrig;

  if (numeroNuevo !== numeroOrig) {
    if (!Number.isInteger(numeroNuevo) || numeroNuevo <= 0) {
      throw new Error('El nuevo NUMERO no es valido');
    }
    // Validar que el NUMERO nuevo no este en uso en INVENTARIO ni en
    // SALIDAS / VENDIDO (para no chocar con ningun historico activo).
    const yaInventario = await getInventarioByNumero(numeroNuevo);
    if (yaInventario) {
      throw new Error(`El NUMERO ${numeroNuevo} ya existe en INVENTARIO. No se puede reasignar.`);
    }
    const { data: enSalidas } = await supabase
      .from('SALIDAS').select('NUMERO').eq('NUMERO', numeroNuevo).limit(1);
    if (enSalidas && enSalidas.length) {
      throw new Error(`El NUMERO ${numeroNuevo} ya existe en SALIDAS. No se puede reasignar.`);
    }
    const { data: enVendido } = await supabase
      .from('VENDIDO').select('NUMERO').eq('NUMERO', numeroNuevo).limit(1);
    if (enVendido && enVendido.length) {
      throw new Error(`El NUMERO ${numeroNuevo} ya existe en VENDIDO. No se puede reasignar.`);
    }
  }

  const vrPrAntes = toNumber(empe['VR PR']);
  const vrRtAntes = toNumber(empe['VR RT']);
  const vrPrNuevo = toNumber(nuevo['VALOR (ING) '] ?? nuevo.valor_ing ?? vrPrAntes);
  const vrRtNuevo = toNumber(nuevo['V RETIRO(ING) '] ?? nuevo.v_retiro_ing ?? vrRtAntes);

  const updates = {
    'VR PR': vrPrNuevo,
    'VR RT': vrRtNuevo,
    NOMBRE: toUpper(nuevo['NOMBRE COMPLETO(ING) '] ?? empe.NOMBRE),
    CC: (nuevo['CEDULA(ING) '] ?? empe.CC ?? '').toString().trim(),
    ART: toUpper(nuevo['ART(ING)'] ?? empe.ART),
    DESCRIPCION: toUpper(nuevo.DESCRIPCION ?? empe.DESCRIPCION, 'NULO'),
    LLEVAR: toUpper(nuevo.LLEVAR ?? empe.LLEVAR)
  };
  if (numeroNuevo !== numeroOrig) {
    updates.NUMERO = numeroNuevo;
  }
  // Si el operador corrige el turno del INGRESO, actualizamos OPER en
  // la fila de INVENTARIO (el INGRESO es la "firma" del articulo).
  if (cambioTurno) {
    updates.OPER = turnoNuevo;
  }

  const futuro = recomputarFilaInventario({ ...empe, ...updates }, new Date());
  updates['TOT IN'] = futuro['TOT IN'];
  updates.TOTAL    = futuro.TOTAL;
  updates.UTIL     = futuro.UTIL;

  const { error } = await supabase
    .from('INVENTARIO')
    .update(updates)
    .eq('NUMERO', numeroOrig);
  if (error) throw error;

  // Si cambio el NUMERO, actualizar referencias en RETIROS (si existiera
  // una fila apuntando al numero viejo) y en HISTORIAL para que la
  // trazabilidad quede consistente.
  if (numeroNuevo !== numeroOrig) {
    try {
      await supabase.from('RETIROS').update({ NUMERO: numeroNuevo }).eq('NUMERO', numeroOrig);
    } catch (_) {}
    try {
      await supabase.from('HISTORIAL').update({ NUMERO: numeroNuevo }).eq('NUMERO', numeroOrig);
    } catch (_) {}
  }

  // Caja: ajustar CONTRATOS por el VR PR (traspasa si cambio el turno).
  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'CONTRATOS', vrPrAntes, vrPrNuevo);

  // Actualizar OPER en HISTORIAL del registro original.
  await actualizarOperHistorial(original, turnoNuevo, numeroNuevo);

  await registrarEdicion({
    tipoOriginal: 'INGRESO',
    original: { ...original, NUMERO: numeroNuevo },
    valorAhora: vrPrNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      NUMERO_ANT: numeroOrig, NUMERO_NEW: numeroNuevo,
      'VR PR_ANT': vrPrAntes, 'VR PR_NEW': vrPrNuevo,
      'VR RT_ANT': vrRtAntes, 'VR RT_NEW': vrRtNuevo,
      NOMBRE: updates.NOMBRE, CC: updates.CC, ART: updates.ART,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarAbono(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numero = parseInt(original.NUMERO, 10);
  const empe = await getInventarioByNumero(numero);
  if (!empe) throw new Error(`Articulo ${numero} no existe en INVENTARIO`);

  const abonoAntes = toNumber(original.VALOR);
  const abonoNuevo = toNumber(nuevo.ABONO ?? nuevo.abono ?? abonoAntes);
  const desAntes = toNumber(empe.DES);
  const desNuevo = toNumber(nuevo['DESCUENTO(ABO)'] ?? nuevo.descuento ?? desAntes);
  const retiroNuevo = (nuevo['RETIRO(ABO)'] ?? '').toString().toUpperCase().trim();

  const dAbono = delta(abonoAntes, abonoNuevo);

  const updates = {
    'VR AB': toNumber(empe['VR AB']) + dAbono,
    DES: desNuevo
  };
  if (retiroNuevo) {
    updates.RETIROS = retiroNuevo;
    updates['FECHA RETIRO'] = ahoraISO();
  }

  const futuro = recomputarFilaInventario({ ...empe, ...updates }, new Date());
  updates['TOT IN'] = futuro['TOT IN'];
  updates.TOTAL    = futuro.TOTAL;
  updates.UTIL     = futuro.UTIL;

  const { error } = await supabase
    .from('INVENTARIO')
    .update(updates)
    .eq('NUMERO', numero);
  if (error) throw error;

  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'RETIRO', abonoAntes, abonoNuevo);

  // Si el abono marca RETIRAR, OPER de tabla RETIROS = turno corregido.
  await syncRetirosFromInventario(futuro, retiroNuevo ? turnoNuevo : null);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'ABONO',
    original,
    valorAhora: abonoNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      ABONO_ANT: abonoAntes, ABONO_NEW: abonoNuevo,
      DES_ANT: desAntes, DES_NEW: desNuevo,
      RETIRO: retiroNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarIntereses(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numero = parseInt(original.NUMERO, 10);
  const empe = await getInventarioByNumero(numero);
  if (!empe) throw new Error(`Articulo ${numero} no existe en INVENTARIO`);

  const intAntes = toNumber(original.VALOR);
  const intNuevo = toNumber(nuevo.intereses ?? nuevo.INTERESES ?? intAntes);
  const d = delta(intAntes, intNuevo);

  const updates = {
    'VR IN': toNumber(empe['VR IN']) + d
  };
  const futuro = recomputarFilaInventario({ ...empe, ...updates }, new Date());
  updates['TOT IN'] = futuro['TOT IN'];
  updates.TOTAL    = futuro.TOTAL;
  updates.UTIL     = futuro.UTIL;

  const { error } = await supabase
    .from('INVENTARIO')
    .update(updates)
    .eq('NUMERO', numero);
  if (error) throw error;

  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'RETIRO', intAntes, intNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'INTERESES',
    original,
    valorAhora: intNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      INT_ANT: intAntes, INT_NEW: intNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarAumento(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numero = parseInt(original.NUMERO, 10);
  const empe = await getInventarioByNumero(numero);
  if (!empe) throw new Error(`Articulo ${numero} no existe en INVENTARIO`);

  const det = parseDetalle(original.DETALLE);
  const aumAntes  = toNumber(original.VALOR);
  const pagoAntes = toNumber(det.PAGO_AUMENTO ?? aumAntes);

  const aumNuevo  = toNumber(nuevo.aumento ?? nuevo.AUMENTO ?? aumAntes);
  const pagoNuevo = toNumber(nuevo.pago_aumento ?? nuevo.PAGO_AUMENTO ?? nuevo['PAGO AUMENTO'] ?? pagoAntes);

  const dAum  = delta(aumAntes, aumNuevo);
  const dPago = delta(pagoAntes, pagoNuevo);

  const updates = {
    'VR PR': toNumber(empe['VR PR']) + dAum,
    'VR RT': toNumber(empe['VR RT']) + dPago
  };
  const futuro = recomputarFilaInventario({ ...empe, ...updates }, new Date());
  updates['TOT IN'] = futuro['TOT IN'];
  updates.TOTAL    = futuro.TOTAL;
  updates.UTIL     = futuro.UTIL;

  const { error } = await supabase
    .from('INVENTARIO')
    .update(updates)
    .eq('NUMERO', numero);
  if (error) throw error;

  // CAJA.CONTRATOS: traspasa si hubo cambio de turno.
  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'CONTRATOS', aumAntes, aumNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'AUMENTO',
    original,
    valorAhora: aumNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      AUM_ANT: aumAntes, AUM_NEW: aumNuevo,
      PAGO_ANT: pagoAntes, PAGO_NEW: pagoNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarDevolucion(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numero = parseInt(original.NUMERO, 10);
  const empe = await getInventarioByNumero(numero);
  if (!empe) throw new Error(`Articulo ${numero} no existe en INVENTARIO`);

  const devAntes = toNumber(original.VALOR);
  const devNuevo = toNumber(nuevo.valor ?? nuevo.VALOR ?? devAntes);

  if (devNuevo <= 0) throw new Error('La devolucion debe ser mayor a 0');

  // 1) REVERTIR la devolucion original sumando de vuelta a VR AB / VR IN
  //    segun como se hizo originalmente (guardado en DETALLE).
  const det = parseDetalle(original.DETALLE);
  let restaAbAnt = toNumber(det.RESTA_AB);
  let restaInAnt = toNumber(det.RESTA_IN);
  if (!restaAbAnt && !restaInAnt && devAntes > 0) {
    // Devolucion vieja sin detalle estructurado: asumimos que todo se quito de VR AB.
    restaAbAnt = devAntes;
  }

  const vrAbReset  = toNumber(empe['VR AB'])  + restaAbAnt;
  const vrInReset  = toNumber(empe['VR IN'])  + restaInAnt;
  const totInReset = toNumber(empe['TOT IN']) + restaInAnt;

  // 2) Validar y APLICAR la nueva devolucion sobre el estado revertido.
  const totalDisponible = vrAbReset + vrInReset;
  if (devNuevo > totalDisponible) {
    throw new Error(`NO SE PUEDE: la devolucion (${devNuevo}) supera VR AB + VR IN (${totalDisponible})`);
  }

  const restaAbNew = Math.min(devNuevo, vrAbReset);
  const restaInNew = devNuevo - restaAbNew;

  const updates = {
    'VR AB':  vrAbReset  - restaAbNew,
    'VR IN':  vrInReset  - restaInNew
  };
  const futuro = recomputarFilaInventario({ ...empe, ...updates }, new Date());
  updates['TOT IN'] = futuro['TOT IN'];
  updates.TOTAL    = futuro.TOTAL;
  updates.UTIL     = futuro.UTIL;

  const { error } = await supabase
    .from('INVENTARIO')
    .update(updates)
    .eq('NUMERO', numero);
  if (error) throw error;

  // 3) CAJA: la devolucion es egreso -> resta de RETIRO. moverCaja con
  //    signo -1 hace: turno viejo +devAntes (revertir), turno nuevo -devNuevo.
  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'RETIRO', devAntes, devNuevo, -1);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'DEVOLUCION',
    original,
    valorAhora: devNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      DEV_ANT: devAntes, DEV_NEW: devNuevo,
      RESTA_AB: restaAbNew, RESTA_IN: restaInNew,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarSalida(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numero = parseInt(original.NUMERO, 10);

  const { data: salidaRow, error: errSel } = await supabase
    .from('SALIDAS')
    .select('*')
    .eq('NUMERO', numero)
    .maybeSingle();
  if (errSel) throw errSel;
  if (!salidaRow) throw new Error(`Articulo ${numero} no encontrado en SALIDAS`);

  const valAntes = toNumber(original.VALOR);
  const valNuevo = toNumber(nuevo.valor ?? nuevo.VALOR ?? valAntes);
  const desAntes = toNumber(salidaRow.DES);
  const desNuevo = toNumber(nuevo.descuento ?? desAntes);
  const d = delta(valAntes, valNuevo);

  const updates = {
    'VR AB': toNumber(salidaRow['VR AB']) + d,
    DES: desNuevo
  };
  // En SALIDAS el TOT IN ya esta congelado: solo recalculamos TOTAL y UTIL.
  const futuro = { ...salidaRow, ...updates };
  updates.TOTAL = calcularTotal(futuro);
  updates.UTIL  = calcularUtil(futuro);
  // La fila SALIDAS conserva el OPER del operador que hizo la SALIDA;
  // si el operador corrige el turno, actualizamos ese OPER.
  if (cambioTurno) updates.OPER = turnoNuevo;

  const { error } = await supabase
    .from('SALIDAS')
    .update(updates)
    .eq('NUMERO', numero);
  if (error) throw error;

  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'RETIRO', valAntes, valNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'SALIDA',
    original,
    valorAhora: valNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      VAL_ANT: valAntes, VAL_NEW: valNuevo,
      DES_ANT: desAntes, DES_NEW: desNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarRetiro(original, nuevo, ctx = {}) {
  // Tipo "RETIROS" en frontend = PEDIR_SIN_PAGAR en HISTORIAL.
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const numero = parseInt(original.NUMERO, 10);
  const empe = await getInventarioByNumero(numero);
  if (!empe) throw new Error(`Articulo ${numero} no existe en INVENTARIO`);

  const retiroNuevo = (nuevo['RETIRO(PEDIR)'] ?? nuevo.RETIRO ?? '').toString().toUpperCase().trim();

  const updates = {
    RETIROS: retiroNuevo,
    'FECHA RETIRO': ahoraISO()
  };
  const futuro = { ...empe, ...updates };

  const { error } = await supabase
    .from('INVENTARIO')
    .update(updates)
    .eq('NUMERO', numero);
  if (error) throw error;

  // La tabla RETIROS guarda el OPER del operador que marco el retiro.
  // Si el operador corrige el turno, sincronizamos con el turno nuevo.
  await syncRetirosFromInventario(futuro, turnoNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'RETIROS',
    original,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      RETIROS: retiroNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarBar(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const valAntes = toNumber(original.VALOR);
  const valNuevo = toNumber(nuevo.VALOR ?? nuevo.valor ?? valAntes);

  // BAR usa (MARCA TEMPORAL, VALOR) como PK natural. No tiene OPER.
  const { error } = await supabase
    .from('BAR')
    .update({ VALOR: valNuevo })
    .eq('MARCA TEMPORAL', original.FECHA)
    .eq('VALOR', valAntes);
  if (error) throw error;

  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'BAR', valAntes, valNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'BAR',
    original,
    valorAhora: valNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      VAL_ANT: valAntes, VAL_NEW: valNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarGuardadero(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const valAntes = toNumber(original.VALOR);
  const valNuevo = toNumber(nuevo.VALOR ?? nuevo.valor ?? valAntes);
  const nombreNuevo = toUpper(nuevo.NOMBRE ?? original.NOMBRE);

  const { error } = await supabase
    .from('GUARDADERO')
    .update({ VALOR: valNuevo, NOMBRE: nombreNuevo })
    .eq('MARCA TEMPORAL', original.FECHA)
    .eq('VALOR', valAntes);
  if (error) throw error;

  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'GUARDA', valAntes, valNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'GUARDADERO',
    original,
    valorAhora: valNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      VAL_ANT: valAntes, VAL_NEW: valNuevo, NOMBRE: nombreNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarGastos(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const valAntes = toNumber(original.VALOR);
  const valNuevo = toNumber(nuevo.VALOR ?? nuevo.valor ?? valAntes);
  const descAntes = (original.DESCRIPCION || '').toString();
  const descNuevo = toUpper(nuevo.DESCRIPCION ?? descAntes);

  const updatePayload = { VALOR: valNuevo, DESCRIPCION: descNuevo };
  if (cambioTurno) updatePayload.TURNO = turnoNuevo;

  const { error } = await supabase
    .from('GASTOS')
    .update(updatePayload)
    .eq('FECHA', original.FECHA)
    .eq('TURNO', turnoOrig)
    .eq('VALOR', valAntes)
    .eq('DESCRIPCION', descAntes);
  if (error) throw error;

  await moverCaja(original.FECHA, turnoOrig, turnoNuevo, 'GASTOS', valAntes, valNuevo);

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'GASTOS',
    original,
    valorAhora: valNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      VAL_ANT: valAntes, VAL_NEW: valNuevo,
      DESC_ANT: descAntes, DESC_NEW: descNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarCaja(original, nuevo, ctx = {}) {
  // Solo editamos el subtipo BASE (CIERRE no escribe en CAJA).
  // CAJA tiene PK (FECHA, TURNO). Si se cambia TURNO, hay que MOVER
  // la fila al turno nuevo (insert-or-update) y dejar la anterior en 0.
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  const fechaCaja = toCajaFecha(original.FECHA);
  const valAntes = toNumber(original.VALOR);
  const valNuevo = toNumber(nuevo.VALOR ?? nuevo.valor);

  if (!cambioTurno) {
    const { error } = await supabase
      .from('CAJA')
      .update({ BASE: valNuevo })
      .eq('FECHA', fechaCaja)
      .eq('TURNO', turnoOrig);
    if (error) throw error;
  } else {
    // 1) Poner BASE=0 en el turno viejo.
    const { error: e1 } = await supabase
      .from('CAJA')
      .update({ BASE: 0 })
      .eq('FECHA', fechaCaja)
      .eq('TURNO', turnoOrig);
    if (e1) throw e1;
    // 2) Upsert BASE=valNuevo en el turno nuevo (crear la fila si no existe).
    const { error: e2 } = await supabase
      .from('CAJA')
      .upsert({ FECHA: fechaCaja, TURNO: turnoNuevo, BASE: valNuevo }, { onConflict: 'FECHA,TURNO' });
    if (e2) throw e2;
  }

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'CAJA',
    original,
    valorAhora: valNuevo,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      SUBTIPO: 'BASE',
      VAL_ANT: valAntes,
      VAL_NEW: valNuevo,
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

async function editarDescuento(original, nuevo, ctx = {}) {
  const turnoOrig = String(original.OPER || '').trim();
  const turnoNuevo = (String(ctx.turnoCorregido || turnoOrig).trim()) || turnoOrig;
  const cambioTurno = turnoNuevo !== turnoOrig;

  await actualizarOperHistorial(original, turnoNuevo);

  await registrarEdicion({
    tipoOriginal: 'DESCUENTO',
    original,
    turnoEditor: ctx.turnoEditor,
    resumenCambios: {
      NOTA: 'Editado manualmente, sin cambios automaticos',
      ...(cambioTurno ? { TURNO_ANT: turnoOrig, TURNO_NEW: turnoNuevo } : {})
    }
  });
}

const EDITORES = {
  INGRESO: editarIngreso,
  ABONO: editarAbono,
  INTERESES: editarIntereses,
  AUMENTO: editarAumento,
  DEVOLUCION: editarDevolucion,
  SALIDA: editarSalida,
  RETIROS: editarRetiro,
  BAR: editarBar,
  GUARDADERO: editarGuardadero,
  GASTOS: editarGastos,
  CAJA: editarCaja,
  DESCUENTO: editarDescuento
};

// --------------------------------------------------------------
// HANDLER PRINCIPAL
// --------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    const body = await leerBody(req);
    const accion = leerParam(req, body, 'accion') || 'list';

    if (accion === 'tipos') {
      return res.json({ ok: true, tipos: Array.from(TIPOS_EDITABLES) });
    }

    if (accion === 'list') {
      const turno = leerParam(req, body, 'turno');
      const tipo = (leerParam(req, body, 'tipo') || '').toString().toUpperCase();
      const fechaStr = leerParam(req, body, 'fecha');
      const desdeISO = leerParam(req, body, 'desde');
      const hastaISO = leerParam(req, body, 'hasta');

      if (!turno) return res.status(400).json({ ok: false, error: 'Falta turno' });
      if (!TIPOS_EDITABLES.has(tipo)) {
        return res.status(400).json({ ok: false, error: `Tipo no editable: ${tipo}` });
      }

      const data = await listarOperaciones({ turno, tipo, fechaStr, desdeISO, hastaISO });
      return res.json({ ok: true, ...data, tipo, turno });
    }

    if (accion === 'aplicar') {
      const tipo = (leerParam(req, body, 'tipo') || '').toString().toUpperCase();
      const original = leerParam(req, body, 'original');
      const nuevo = leerParam(req, body, 'nuevo');
      // Turno corregido: si el operador se equivoco al elegir el turno
      // al hacer la operacion, aqui viene el turno correcto.
      const turnoCorregido = (leerParam(req, body, 'turnoCorregido') || '').toString().trim();
      // Turno del operador que esta editando (para auditoria).
      const turnoEditor = (leerParam(req, body, 'turnoEditor') || '').toString().trim();

      if (!TIPOS_EDITABLES.has(tipo)) {
        return res.status(400).json({ ok: false, error: `Tipo no editable: ${tipo}` });
      }
      if (!original || typeof original !== 'object') {
        return res.status(400).json({ ok: false, error: 'Falta "original"' });
      }
      if (!nuevo || typeof nuevo !== 'object') {
        return res.status(400).json({ ok: false, error: 'Falta "nuevo"' });
      }

      const editor = EDITORES[tipo];
      if (!editor) return res.status(400).json({ ok: false, error: `Sin editor para ${tipo}` });

      await editor(original, nuevo, { turnoCorregido, turnoEditor });
      return res.json({ ok: true, mensaje: 'EDICION APLICADA' });
    }

    return res.status(400).json({ ok: false, error: `Accion desconocida: ${accion}` });
  } catch (err) {
    console.error('Error EDITAR:', err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
