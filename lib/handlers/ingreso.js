const supabase = require('../supabase');
const { parsearFecha } = require('../helpers');
const {
  toUpper,
  recomputarFilaInventario,
  numeroExisteGlobal,
  upsertCajaDelta,
  insertHistorial,
  siguienteNumeroInventario
} = require('../db');

function add30DiasDesdeFechaISO(fechaIso) {
  const d = new Date(fechaIso);
  if (isNaN(d.getTime())) {
    const f2 = new Date();
    f2.setUTCDate(f2.getUTCDate() + 30);
    return f2.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  d.setUTCDate(d.getUTCDate() + 30);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function esDuplicadoError(err) {
  if (!err) return false;
  const c = err.code;
  if (c === '23505') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('duplicate') || m.includes('unique') || m.includes('already exists');
}

module.exports = async (req, res) => {
  try {
    const {
      identificador,
      'VALOR (ING) ': valorRaw,
      'V RETIRO(ING) ': vRetiroRaw,
      'NOMBRE COMPLETO(ING) ': nombreRaw,
      'CEDULA(ING) ': cedulaRaw,
      'ART(ING)': artRaw,
      DESCRIPCION: descRaw,
      LLEVAR: llevarRaw,
      'Marca temporal': marcaTemporal,
      TURNO: turno
    } = req.query;

    const identStr = identificador != null ? String(identificador).trim() : '';
    const usuarioEscribeNumero = identStr.length > 0;
    const vrPrestado = parseFloat(valorRaw) || 0;
    const vrRetiro = parseFloat(vRetiroRaw) || 0;
    const nombre = toUpper(nombreRaw);
    const cedula = (cedulaRaw || '').trim();
    const art = toUpper(artRaw);
    const descripcion = toUpper(descRaw, 'NULO');
    const llevar = toUpper(llevarRaw);
    const fecha = parsearFecha(marcaTemporal);
    const FECHA_MAX_RETIRO = add30DiasDesdeFechaISO(fecha);

    let numero;
    if (usuarioEscribeNumero) {
      numero = parseInt(identStr, 10);
      if (!Number.isInteger(numero) || numero < 100000 || numero > 999999) {
        return res.json({
          ok: false,
          mensaje: 'EL NUMERO DEBE SER 6 DIGITOS (100000-999999) O VACIO PARA ASIGNAR AUTO'
        });
      }
    }

    if (usuarioEscribeNumero) {
      if (await numeroExisteGlobal(numero)) {
        return res.json({
          ok: false,
          duplicado: true,
          numero,
          mensaje: 'EL NUMERO DE ARTICULO YA ESTA INGRESADO'
        });
      }
    }

    const buildRow = (n) => {
      const rowBase = {
        FECHA: fecha,
        OPER: turno,
        NUMERO: n,
        'VR PR': vrPrestado,
        'VR RT': vrRetiro,
        NOMBRE: nombre,
        CC: cedula,
        ART: art,
        DESCRIPCION: descripcion,
        LLEVAR: llevar,
        'VR IN': 0,
        'TOT IN': 0,
        'FECHA INT': null,
        'VR AB': 0,
        'FECHA ABON': null,
        ESPERA: '',
        RETIROS: '',
        'FECHA RETIRO': null,
        DES: 0,
        AUMENTO: '',
        'FECHA AU': null,
        TOTAL: 0,
        UTIL: 0
      };
      return recomputarFilaInventario(rowBase, new Date(fecha));
    };

    const doHistorialCaja = async (n) => {
      await Promise.all([
        upsertCajaDelta(fecha, turno, 'CONTRATOS', vrPrestado),
        insertHistorial({
          fecha,
          oper: turno,
          tipo: 'INGRESO',
          numero: n,
          nombre,
          cc: cedula,
          art,
          descripcion,
          valor: vrPrestado,
          detalle: { 'VR RT': vrRetiro, LLEVAR: llevar, AUTO: !usuarioEscribeNumero }
        })
      ]);
    };

    if (usuarioEscribeNumero) {
      const row = buildRow(numero);
      const { error: errIns } = await supabase.from('INVENTARIO').insert(row);
      if (errIns) {
        console.error('Error INGRESO insert manual:', errIns);
        if (esDuplicadoError(errIns)) {
          return res.json({
            ok: false,
            duplicado: true,
            numero,
            mensaje: 'EL NUMERO DE ARTICULO YA ESTA INGRESADO'
          });
        }
        return res.status(500).json({ ok: false, mensaje: 'ERROR AL INGRESAR', error: errIns.message });
      }
      await doHistorialCaja(numero);
    } else {
      let nAsignado = null;
      for (let intento = 0; intento < 12; intento += 1) {
        const n = await siguienteNumeroInventario();
        const row = buildRow(n);
        const { error: errIns } = await supabase.from('INVENTARIO').insert(row);
        if (!errIns) {
          nAsignado = n;
          break;
        }
        if (esDuplicadoError(errIns)) {
          // otra caja inserto en paralelo, siguiente intento
          continue;
        }
        console.error('Error INGRESO insert auto:', errIns);
        return res.status(500).json({ ok: false, mensaje: 'ERROR AL INGRESAR (AUTO NUMERO)' });
      }
      if (nAsignado == null) {
        return res.status(500).json({
          ok: false,
          mensaje: 'NO FUE POSIBLE OBTENER UN NUMERO SIN USAR, REINTENTE'
        });
      }
      await doHistorialCaja(nAsignado);
      numero = nAsignado;
    }

    // Código de barras en cliente = Code128 de este NUMERO; misma clave que la fila insertada en INVENTARIO
    return res.json({
      ok: true,
      mensaje: 'INGRESADO CORRECTAMENTE',
      NUMERO: numero,
      FECHA: fecha,
      FECHA_MAX_RETIRO
    });
  } catch (error) {
    console.error('Error INGRESO:', error);
    if (String(error && error.message) === 'RANGO_NUMEROS_AGOTADO' || (error && error.code === 'RANGO')) {
      return res.status(500).json({ ok: false, mensaje: 'RANGO DE NUMEROS (100000-999999) AGOTADO' });
    }
    res.status(500).json({ ok: false, mensaje: 'ERROR INTERNO', error: error.message });
  }
};
