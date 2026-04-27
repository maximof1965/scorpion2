/* ============================================================
   IMPORTADOR DE INVENTARIO  Sheets/Excel  ->  Supabase
   ------------------------------------------------------------
   Uso:
     node scripts/importar_inventario.js [ruta_csv] [opciones]

   Opciones:
     --dry-run        No inserta nada, solo valida y reporta.
     --modo=skip      (DEFAULT) Si NUMERO ya existe en Supabase, lo OMITE.
     --modo=upsert    Si NUMERO ya existe, lo ACTUALIZA con los datos del CSV.
     --modo=insert    Falla si hay duplicados (insert puro, sin proteccion).
     --truncar        Vacia COMPLETAMENTE la tabla INVENTARIO antes de cargar.
                      USAR CON CUIDADO. Pide confirmacion.
     --lote=500       Tamano de lote (1..1000). Default 500.
     --sep=,          Separador del CSV. Auto-detecta entre , ; \t.

   Variables de entorno requeridas (en scripts/.env o exportadas):
     SUPABASE_URL=https://xxx.supabase.co
     SUPABASE_SERVICE_KEY=eyJ...   (service_role, NO la anon)
   ============================================================ */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

// ---- Cargar scripts/.env sin dependencias externas ----
(function cargarEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lineas = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const l of lineas) {
    const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

// Las credenciales solo se exigen si NO es dry-run (se valida mas abajo)
let supabase = null;
function inicializarSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('\nFALTAN credenciales. Crea scripts/.env (mira scripts/.env.example) con:');
    console.error('  SUPABASE_URL=https://xxx.supabase.co');
    console.error('  SUPABASE_SERVICE_KEY=eyJ...\n');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

// ---- Argumentos ----
const args = process.argv.slice(2);
let archivo  = 'inventario.csv';
let modo     = 'skip';
let dryRun   = false;
let truncar  = false;
let lote     = 500;
let sepArg   = null;

for (const a of args) {
  if (a === '--dry-run')             dryRun = true;
  else if (a === '--truncar')        truncar = true;
  else if (a.startsWith('--modo='))  modo = a.split('=')[1];
  else if (a.startsWith('--lote='))  lote = Math.max(1, Math.min(1000, parseInt(a.split('=')[1], 10) || 500));
  else if (a.startsWith('--sep='))   sepArg = a.split('=')[1] === '\\t' ? '\t' : a.split('=')[1];
  else if (!a.startsWith('--'))      archivo = a;
}
if (!['skip', 'upsert', 'insert'].includes(modo)) {
  console.error(`Modo invalido: ${modo}. Usa skip | upsert | insert`);
  process.exit(1);
}

// ---- CSV parser robusto (soporta comillas y newlines dentro de campo) ----
function detectarSeparador(linea) {
  const candidatos = [',', ';', '\t', '|'];
  let mejor = ',', max = 0;
  for (const s of candidatos) {
    const re = s === '\t' ? /\t/g : new RegExp('\\' + s, 'g');
    const n = (linea.match(re) || []).length;
    if (n > max) { max = n; mejor = s; }
  }
  return mejor;
}

function parseCsv(texto, sep) {
  if (texto.charCodeAt(0) === 0xFEFF) texto = texto.slice(1);
  const filas = [];
  let campo = '', fila = [], dentroComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i], n = texto[i + 1];
    if (dentroComillas) {
      if (c === '"' && n === '"') { campo += '"'; i++; }
      else if (c === '"') { dentroComillas = false; }
      else { campo += c; }
    } else {
      if (c === '"') { dentroComillas = true; }
      else if (c === sep) { fila.push(campo); campo = ''; }
      else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else if (c === '\r') { /* ignora */ }
      else { campo += c; }
    }
  }
  if (campo.length || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.length > 1 || (f.length === 1 && f[0].trim() !== ''));
}

// ---- Normalizadores ----
function limpiarNumero(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s.toUpperCase() === 'N/A') return null;
  let limpio = s.replace(/[^\d.,\-]/g, '');
  const ultimaComa  = limpio.lastIndexOf(',');
  const ultimoPunto = limpio.lastIndexOf('.');
  if (ultimaComa > -1 || ultimoPunto > -1) {
    const idxDec = Math.max(ultimaComa, ultimoPunto);
    const decimal = limpio.slice(idxDec + 1);
    const entero  = limpio.slice(0, idxDec).replace(/[.,]/g, '');
    limpio = decimal.length > 0 ? `${entero}.${decimal}` : entero;
  }
  const num = parseFloat(limpio);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function limpiarTexto(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s.toUpperCase() === 'N/A' || s.toUpperCase() === 'NULL') return null;
  return s.toUpperCase();
}

function toIsoSinMs(y, mo, d, h, mi, se) {
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0, se || 0));
  if (isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function limpiarFecha(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '0') return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
    return toIsoSinMs(+y, +mo, +d, +h, +mi, +se);
  }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    let [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    if (y.length === 2) y = (parseInt(y, 10) >= 70 ? '19' : '20') + y;
    return toIsoSinMs(+y, +mo, +d, +h, +mi, +se);
  }
  return null;
}

// ---- Mapa de columnas (acepta variantes comunes) ----
const COLUMNAS = {
  'NUMERO':       ['NUMERO', 'NUMBER', 'NRO', 'N', '#', 'NUM'],
  'FECHA':        ['FECHA', 'MARCA TEMPORAL', 'TIMESTAMP', 'FECHA INGRESO'],
  'OPER':         ['OPER', 'OPERADOR', 'TURNO'],
  'VR PR':        ['VR PR', 'VRPR', 'VR_PR', 'PRESTAMO', 'PR'],
  'VR RT':        ['VR RT', 'VRRT', 'VR_RT', 'RT'],
  'NOMBRE':       ['NOMBRE', 'CLIENTE', 'NAME'],
  'CC':           ['CC', 'CEDULA', 'IDENTIFICACION', 'DOCUMENTO'],
  'ART':          ['ART', 'ARTICULO', 'TIPO'],
  'DESCRIPCION':  ['DESCRIPCION', 'DESCRIPCIÓN', 'DESC', 'DETALLE ART'],
  'LLEVAR':       ['LLEVAR'],
  'VR IN':        ['VR IN', 'VRIN', 'VR_IN', 'INTERES', 'IN'],
  'TOT IN':       ['TOT IN', 'TOTIN', 'TOT_IN', 'TOTAL INTERES'],
  'FECHA INT':    ['FECHA INT', 'FECHA_INT', 'FECHAINT', 'FECHA INTERES'],
  'VR AB':        ['VR AB', 'VRAB', 'VR_AB', 'ABONO', 'AB'],
  'FECHA ABON':   ['FECHA ABON', 'FECHA_ABON', 'FECHAABON', 'FECHA ABONO'],
  'ESPERA':       ['ESPERA'],
  'RETIROS':      ['RETIROS', 'RETIRO'],
  'FECHA RETIRO': ['FECHA RETIRO', 'FECHA_RETIRO', 'FECHARETIRO'],
  'DES':          ['DES', 'DESCUENTO'],
  'AUMENTO':      ['AUMENTO', 'AUM'],
  'FECHA AU':     ['FECHA AU', 'FECHA_AU', 'FECHAAU', 'FECHA AUMENTO'],
  'TOTAL':        ['TOTAL', 'TOT'],
  'UTIL':         ['UTIL', 'UTILIDAD']
};

const TIPOS = {
  'NUMERO': 'int',
  'FECHA': 'date', 'FECHA INT': 'date', 'FECHA ABON': 'date',
  'FECHA RETIRO': 'date', 'FECHA AU': 'date',
  'VR PR': 'num', 'VR RT': 'num', 'VR IN': 'num', 'TOT IN': 'num',
  'VR AB': 'num', 'DES': 'num', 'TOTAL': 'num', 'UTIL': 'num',
  'OPER': 'text', 'NOMBRE': 'text', 'CC': 'text', 'ART': 'text',
  'DESCRIPCION': 'text', 'LLEVAR': 'text', 'ESPERA': 'text',
  'RETIROS': 'text', 'AUMENTO': 'text'
};

function normHeader(h) {
  return String(h || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function construirMapeo(headers) {
  const mapa = {};
  const usados = new Set();
  headers.forEach((h, idx) => {
    const norm = normHeader(h);
    for (const [destino, variantes] of Object.entries(COLUMNAS)) {
      if (usados.has(destino)) continue;
      if (variantes.some(v => v === norm)) {
        mapa[idx] = destino;
        usados.add(destino);
        return;
      }
    }
  });
  return mapa;
}

function pregunta(rl, txt) {
  return new Promise(res => rl.question(txt, ans => res(ans)));
}

// ---- MAIN ----
async function main() {
  const rutaAbs = path.isAbsolute(archivo) ? archivo : path.join(process.cwd(), archivo);
  if (!fs.existsSync(rutaAbs)) {
    console.error(`No se encontro el archivo: ${rutaAbs}`);
    process.exit(1);
  }

  const texto = fs.readFileSync(rutaAbs, 'utf8');
  const lineas = texto.split(/\r?\n/);
  // Buscar primera linea NO vacia para auto-detectar separador
  let primeraReal = '';
  for (const l of lineas) {
    const limpia = l.replace(/[,;\t|"\s]/g, '');
    if (limpia.length > 0) { primeraReal = l; break; }
  }
  const sep = sepArg || detectarSeparador(primeraReal || lineas[0] || '');

  console.log('==============================================');
  console.log('IMPORTADOR INVENTARIO  Sheets/Excel -> Supabase');
  console.log('==============================================');
  console.log(`Archivo:    ${rutaAbs}`);
  console.log(`Separador:  ${sep === '\t' ? 'TAB' : sep}`);
  console.log(`Modo:       ${modo}${dryRun ? ' (DRY-RUN, no inserta)' : ''}`);
  console.log(`Truncar:    ${truncar ? 'SI (vaciar tabla antes)' : 'no'}`);
  console.log(`Lote:       ${lote}`);
  console.log('----------------------------------------------');

  let filas = parseCsv(texto, sep);
  if (filas.length < 2) {
    console.error('CSV vacio o sin datos.');
    process.exit(1);
  }

  // Auto-detectar la fila de headers: la primera fila que contenga al menos 3 nombres conocidos
  let idxHeader = 0;
  let mejorMatch = -1;
  for (let i = 0; i < Math.min(filas.length, 10); i++) {
    const cuenta = filas[i].filter(h => {
      const norm = normHeader(h);
      return Object.values(COLUMNAS).some(vars => vars.includes(norm));
    }).length;
    if (cuenta > mejorMatch) {
      mejorMatch = cuenta;
      idxHeader = i;
    }
  }
  if (mejorMatch < 3) {
    console.error('\nNo se pudo detectar la fila de encabezados. Revisa que el CSV tenga columnas como NUMERO, FECHA, etc.');
    process.exit(1);
  }
  if (idxHeader > 0) {
    console.log(`Saltando ${idxHeader} fila(s) en blanco al inicio. Headers detectados en la linea ${idxHeader + 1}.`);
  }
  const headers = filas[idxHeader];
  filas = filas.slice(idxHeader); // headers + datos posteriores
  const mapa = construirMapeo(headers);
  const usados = Object.values(mapa);

  console.log('Columnas detectadas y mapeadas:');
  Object.entries(mapa).forEach(([idx, dest]) => {
    console.log(`  CSV "${headers[idx]}"  ->  Supabase "${dest}"`);
  });
  const ignoradas = headers.map((h, i) => mapa[i] ? null : h).filter(Boolean);
  if (ignoradas.length) {
    console.log('Columnas IGNORADAS (no estan en INVENTARIO):');
    ignoradas.forEach(h => console.log(`  - "${h}"`));
  }
  if (!usados.includes('NUMERO')) {
    console.error('\nERROR: el CSV NO tiene columna NUMERO. Es obligatoria.');
    process.exit(1);
  }
  if (!usados.includes('FECHA')) {
    console.error('\nERROR: el CSV NO tiene columna FECHA. Es obligatoria.');
    process.exit(1);
  }
  console.log('----------------------------------------------');

  const validas = [];
  const errores = [];
  const numerosVistos = new Set();
  let filasVacias = 0;

  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    // Saltar filas completamente vacias (todas las celdas en blanco)
    const tieneAlgo = fila.some(c => c !== null && c !== undefined && String(c).trim() !== '');
    if (!tieneAlgo) { filasVacias++; continue; }

    const obj = {};
    let errFila = null;

    for (const [idxStr, destino] of Object.entries(mapa)) {
      const idx = parseInt(idxStr, 10);
      const valorBruto = fila[idx];
      const tipo = TIPOS[destino];
      let valor = null;
      if (tipo === 'int' || tipo === 'num') valor = limpiarNumero(valorBruto);
      else if (tipo === 'date')              valor = limpiarFecha(valorBruto);
      else                                   valor = limpiarTexto(valorBruto);
      if (valor !== null) obj[destino] = valor;
    }

    if (obj.NUMERO === undefined || obj.NUMERO === null) {
      errFila = 'NUMERO vacio o invalido';
    } else if (obj.NUMERO < 100000 || obj.NUMERO > 999999) {
      errFila = `NUMERO fuera de rango (${obj.NUMERO}); debe estar entre 100000 y 999999`;
    } else if (!obj.FECHA) {
      errFila = 'FECHA vacia o invalida';
    } else if (numerosVistos.has(obj.NUMERO)) {
      errFila = `NUMERO duplicado en el CSV (${obj.NUMERO})`;
    }

    if (errFila) {
      errores.push({ linea: i + 1 + idxHeader, error: errFila, fila: fila.join(sep) });
      continue;
    }
    numerosVistos.add(obj.NUMERO);
    validas.push(obj);
  }
  if (filasVacias > 0) {
    console.log(`Filas vacias salteadas: ${filasVacias}`);
  }

  console.log(`Filas leidas:    ${filas.length - 1}`);
  console.log(`Filas validas:   ${validas.length}`);
  console.log(`Filas con error: ${errores.length}`);
  if (errores.length) {
    console.log('\nPrimeros 10 errores:');
    errores.slice(0, 10).forEach(e => {
      console.log(`  Linea ${e.linea}: ${e.error}`);
    });
    if (errores.length > 10) console.log(`  ... y ${errores.length - 10} mas`);
  }
  if (validas.length === 0) {
    console.log('\nNada valido para insertar. Fin.');
    process.exit(0);
  }

  if (dryRun) {
    console.log('\nDRY-RUN: no se insertara nada.');
    console.log('Ejemplo de la primera fila valida ya transformada:');
    console.log(JSON.stringify(validas[0], null, 2));
    console.log('\nEjemplo de la ultima fila valida ya transformada:');
    console.log(JSON.stringify(validas[validas.length - 1], null, 2));
    process.exit(0);
  }

  // A partir de aqui SI se conecta a Supabase
  inicializarSupabase();

  // ---- TRUNCAR si se pidio ----
  if (truncar) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await pregunta(rl, '\nVas a BORRAR todo el contenido actual de INVENTARIO. Escribe BORRAR para confirmar: ');
    rl.close();
    if (ans.trim().toUpperCase() !== 'BORRAR') {
      console.log('Cancelado.');
      process.exit(0);
    }
    console.log('Vaciando tabla INVENTARIO...');
    const { error } = await supabase
      .from('INVENTARIO')
      .delete()
      .gte('NUMERO', 0); // condicion siempre verdadera para eliminar todo
    if (error) {
      console.error('Error vaciando tabla:', error.message);
      process.exit(1);
    }
    console.log('Tabla INVENTARIO vaciada.');
  }

  // ---- Modo skip: filtrar las que ya existen ----
  let aProcesar = validas;
  if (modo === 'skip' && !truncar) {
    console.log('\nVerificando NUMERO ya existentes en Supabase...');
    const numeros = validas.map(v => v.NUMERO);
    const existentes = new Set();
    for (let i = 0; i < numeros.length; i += 500) {
      const lote500 = numeros.slice(i, i + 500);
      const { data, error } = await supabase
        .from('INVENTARIO')
        .select('NUMERO')
        .in('NUMERO', lote500);
      if (error) {
        console.error('Error consultando existentes:', error.message);
        process.exit(1);
      }
      (data || []).forEach(r => existentes.add(r.NUMERO));
    }
    aProcesar = validas.filter(v => !existentes.has(v.NUMERO));
    console.log(`  Ya en Supabase: ${existentes.size} (se omiten)`);
    console.log(`  Para insertar:  ${aProcesar.length}`);
    if (aProcesar.length === 0) {
      console.log('\nNada nuevo para insertar. Fin.');
      process.exit(0);
    }
  }

  // ---- Insercion en lotes ----
  console.log(`\nEnviando a Supabase en lotes de ${lote}...`);
  let okTotal = 0, falloTotal = 0;
  for (let i = 0; i < aProcesar.length; i += lote) {
    const chunk = aProcesar.slice(i, i + lote);
    let resp;
    if (modo === 'upsert') {
      resp = await supabase.from('INVENTARIO').upsert(chunk, { onConflict: 'NUMERO' });
    } else {
      resp = await supabase.from('INVENTARIO').insert(chunk);
    }
    if (resp.error) {
      console.error(`  Lote ${Math.floor(i / lote) + 1}: ERROR  ${resp.error.message}`);
      falloTotal += chunk.length;
    } else {
      okTotal += chunk.length;
      console.log(`  Lote ${Math.floor(i / lote) + 1}: ${chunk.length} filas OK  (acumulado ${okTotal})`);
    }
  }

  console.log('\n==============================================');
  console.log(`Insertadas/actualizadas con exito: ${okTotal}`);
  console.log(`Fallos en lotes:                   ${falloTotal}`);
  console.log(`Filas con error de validacion:     ${errores.length}`);
  console.log('==============================================');

  if (errores.length) {
    const reportePath = path.join(path.dirname(rutaAbs), 'errores_importacion.csv');
    const csv = ['linea,error,fila']
      .concat(errores.map(e =>
        `${e.linea},"${e.error.replace(/"/g, '""')}","${e.fila.replace(/"/g, '""')}"`
      ))
      .join('\n');
    fs.writeFileSync(reportePath, csv, 'utf8');
    console.log(`Reporte de errores: ${reportePath}`);
  }
}

main().catch(err => {
  console.error('\nERROR fatal:', err.message || err);
  process.exit(1);
});
