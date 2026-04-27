const supabase = require('../supabase');
const { exigirAuth } = require('../admin_auth');
const { leerBody } = require('../read_body');
const { recomputarFilaInventario } = require('../db');

// Campos que NO se pueden editar manualmente porque son derivados.
const CAMPOS_DERIVADOS_INVENTARIO = ['TOT IN', 'TOTAL', 'UTIL'];

// Orden de las tablas en la vista TABLAS del admin (prod):
//   - INVENTARIO: se ordena por NUMERO DESC (el NUMERO mas alto es el articulo
//     mas reciente que ingreso). Asi el ultimo ingreso queda siempre arriba.
//   - Las demas tablas son bitacoras: se ordenan por la fecha de la OPERACION
//     (no por la fecha original del contrato) para que la operacion mas
//     reciente aparezca primero.
//       RETIROS -> FECHA RETIRO     (cuando se hizo el "PEDIR SIN PAGAR")
//       SALIDAS -> FECHA            (en SALIDA se sobreescribe con la fecha de la salida)
//       VENDIDO -> FECHA VENTA      (cuando se vendio)
//       HISTORIAL, CAJA, GASTOS, XALE, DEV -> FECHA
//       BAR, GUARDADERO -> MARCA TEMPORAL
// Orden de desempate secundario por una columna inmutable para que sea estable.
const TABLAS = {
  INVENTARIO: {
    pk: ['NUMERO'],
    orden: [{ col: 'NUMERO', asc: false }]
  },
  RETIROS: {
    pk: ['NUMERO'],
    orden: [
      { col: 'FECHA RETIRO', asc: false },
      { col: 'NUMERO', asc: false }
    ]
  },
  SALIDAS: {
    pk: ['NUMERO'],
    orden: [
      { col: 'FECHA', asc: false },
      { col: 'NUMERO', asc: false }
    ]
  },
  VENDIDO: {
    pk: ['NUMERO'],
    orden: [
      { col: 'FECHA VENTA', asc: false },
      { col: 'NUMERO', asc: false }
    ]
  },
  CAJA: {
    pk: ['FECHA', 'TURNO'],
    orden: [
      { col: 'FECHA', asc: false },
      { col: 'TURNO', asc: false }
    ]
  },
  XALE: {
    pk: ['ENVIOS', 'FECHA'],
    orden: [{ col: 'FECHA', asc: false }]
  },
  DEV: {
    pk: ['DEVOLUCIONES', 'FECHA'],
    orden: [{ col: 'FECHA', asc: false }]
  },
  GUARDADERO: {
    pk: ['MARCA TEMPORAL', 'VALOR'],
    orden: [{ col: 'MARCA TEMPORAL', asc: false }]
  },
  HISTORIAL: {
    pk: null,
    orden: [{ col: 'FECHA', asc: false }]
  },
  BAR: {
    pk: ['MARCA TEMPORAL', 'VALOR'],
    orden: [{ col: 'MARCA TEMPORAL', asc: false }]
  },
  GASTOS: {
    pk: ['FECHA', 'TURNO', 'VALOR', 'DESCRIPCION'],
    orden: [
      { col: 'FECHA', asc: false },
      { col: 'VALOR', asc: false }
    ]
  }
};

function leerParam(req, body, nombre) {
  if (body && body[nombre] !== undefined) return body[nombre];
  if (req.query && req.query[nombre] !== undefined) return req.query[nombre];
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const v = url.searchParams.get(nombre);
    if (v !== null) return v;
  } catch (_) {}
  return null;
}

function aplicarFiltroPk(query, tablaCfg, where) {
  for (const col of tablaCfg.pk) {
    if (where[col] === undefined || where[col] === null) {
      throw new Error(`Falta el campo ${col} para identificar la fila`);
    }
    query = query.eq(col, where[col]);
  }
  return query;
}

module.exports = async (req, res) => {
  const body = await leerBody(req);
  if (!exigirAuth(req, res, body)) return;

  const accion = leerParam(req, body, 'accion') || 'list';
  const tabla = leerParam(req, body, 'tabla');

  if (accion === 'tablas') {
    return res.json({
      ok: true,
      tablas: Object.keys(TABLAS).map(name => ({
        name,
        pk: TABLAS[name].pk,
        editable: TABLAS[name].pk !== null
      }))
    });
  }

  if (!tabla || !TABLAS[tabla]) {
    return res.status(400).json({ ok: false, error: `Tabla no permitida: ${tabla}` });
  }
  const cfg = TABLAS[tabla];

  try {
    if (accion === 'list') {
      // Trae TODAS las filas paginando de a 1000 (PostgREST limita a 1000 por consulta).
      const PAGINA = 1000;
      let todas = [];
      const ordenes = Array.isArray(cfg.orden)
        ? cfg.orden
        : (cfg.orden ? [cfg.orden] : []);
      for (let from = 0; from < 50000; from += PAGINA) {
        let q = supabase.from(tabla).select('*').range(from, from + PAGINA - 1);
        for (const o of ordenes) {
          q = q.order(o.col, { ascending: o.asc, nullsFirst: false });
        }
        const { data, error } = await q;
        if (error) throw error;
        if (!data || data.length === 0) break;
        todas = todas.concat(data);
        if (data.length < PAGINA) break;
      }
      // INVENTARIO: recalcular TOT IN, TOTAL y UTIL al vuelo (van creciendo con el tiempo).
      if (tabla === 'INVENTARIO') {
        const ahora = new Date();
        todas = todas.map(r => recomputarFilaInventario(r, ahora));
      }
      return res.json({ ok: true, tabla, rows: todas });
    }

    if (accion === 'update') {
      if (!cfg.pk) return res.status(400).json({ ok: false, error: 'Tabla no editable' });
      const where = leerParam(req, body, 'where');
      let set = leerParam(req, body, 'set');
      if (!where || !set) return res.status(400).json({ ok: false, error: 'Faltan where/set' });

      // En INVENTARIO bloqueamos edicion manual de campos derivados;
      // se recalculan automaticamente al final.
      if (tabla === 'INVENTARIO') {
        const setLimpio = { ...set };
        for (const c of CAMPOS_DERIVADOS_INVENTARIO) delete setLimpio[c];
        set = setLimpio;

        // Aplicamos el update y luego recalculamos los derivados con la fila actualizada.
        let q = supabase.from(tabla).update(set);
        q = aplicarFiltroPk(q, cfg, where);
        const { error } = await q;
        if (error) throw error;

        // Recalcular para esta fila concreta.
        const numero = where.NUMERO;
        const { data: actual, error: err2 } = await supabase
          .from('INVENTARIO').select('*').eq('NUMERO', numero).maybeSingle();
        if (!err2 && actual) {
          const recomputado = recomputarFilaInventario(actual, new Date());
          await supabase.from('INVENTARIO').update({
            'TOT IN': recomputado['TOT IN'],
            TOTAL:    recomputado.TOTAL,
            UTIL:     recomputado.UTIL
          }).eq('NUMERO', numero);
        }
        return res.json({ ok: true });
      }

      let q = supabase.from(tabla).update(set);
      q = aplicarFiltroPk(q, cfg, where);
      const { error } = await q;
      if (error) throw error;
      return res.json({ ok: true });
    }

    if (accion === 'insert') {
      const rows = leerParam(req, body, 'rows');
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ ok: false, error: 'Faltan rows' });
      }
      const { error } = await supabase.from(tabla).insert(rows);
      if (error) throw error;
      return res.json({ ok: true, insertadas: rows.length });
    }

    if (accion === 'delete') {
      if (!cfg.pk) return res.status(400).json({ ok: false, error: 'Tabla no editable' });
      const where = leerParam(req, body, 'where');
      if (!where) return res.status(400).json({ ok: false, error: 'Falta where' });

      let q = supabase.from(tabla).delete();
      q = aplicarFiltroPk(q, cfg, where);
      const { error } = await q;
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Accion desconocida: ' + accion });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
