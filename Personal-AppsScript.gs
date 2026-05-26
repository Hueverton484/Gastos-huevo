/**
 * Apps Script para el spreadsheet personal (Salud, Gym, Comidas).
 * Vincular a: https://docs.google.com/spreadsheets/d/1RY0b_aSuHfMj582OPYm0NHMyBX1PO8ViruLb3Kb3tEE
 *
 * Cómo desplegar:
 *  1. Abrí el spreadsheet → menú Extensiones → Apps Script
 *  2. Pegá TODO este código (borrá lo que haya)
 *  3. Guardá (Ctrl+S) y poné un nombre al proyecto
 *  4. Deploy → New deployment → tipo "Web app"
 *  5. Configurá: Execute as = Me / Who has access = Anyone
 *  6. Copiá la URL terminada en /exec → pegala en la app
 */

const MESES_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                  'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DIA_SEMANA = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

function doGet(e) {
  const p = e.parameter || {};
  const cb = p.callback;
  let result;
  try {
    const action = p.action || 'ping';
    if      (action === 'ping')          result = { ok: true, msg: 'Personal API funcionando' };
    else if (action === 'add_peso')      result = addPeso(p);
    else if (action === 'add_medida')    result = addMedida(p);
    else if (action === 'add_actividad') result = addActividad(p);
    else if (action === 'add_comida')    result = addComida(p);
    else result = { ok: false, error: 'Acción desconocida: ' + action };
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  const json = JSON.stringify(result);
  if (cb) {
    return ContentService.createTextOutput(cb + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function parseDate(s) {
  if (!s) return new Date();
  if (/^\d+$/.test(s)) return new Date(parseInt(s, 10));
  // Acepta YYYY-MM-DD construido en hora local
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const parts = s.split('-');
    return new Date(parseInt(parts[0],10), parseInt(parts[1],10)-1, parseInt(parts[2],10));
  }
  return new Date(s);
}

function sameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear()
      && d1.getMonth()    === d2.getMonth()
      && d1.getDate()     === d2.getDate();
}

/* ── PESO ───────────────────────────────────────────── */
function addPeso(p) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Peso');
  if (!sheet) throw 'No existe la hoja "Peso"';
  const fecha = parseDate(p.fecha);
  const peso  = parseFloat(p.peso);
  const nota  = p.nota || '';
  if (isNaN(peso) || peso <= 0) throw 'Peso inválido';

  const data = sheet.getDataRange().getValues();
  // Detectar columnas por encabezado
  const headers = data[0].map(h => String(h).toLowerCase());
  const colFecha = headers.findIndex(h => h.indexOf('fecha') >= 0);
  const colPeso  = headers.findIndex(h => h.indexOf('peso') >= 0);
  const colVar   = headers.findIndex(h => h.indexOf('variac') >= 0);
  const colNota  = headers.findIndex(h => h.indexOf('nota') >= 0);

  // Buscar fila existente por fecha
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    const d = data[i][colFecha];
    if (d instanceof Date && sameDay(d, fecha)) { rowIdx = i; break; }
  }

  // Encontrar el último peso registrado antes de esta fecha (para variación)
  let prevPeso = null;
  for (let i = data.length - 1; i >= 1; i--) {
    if (i === rowIdx) continue;
    const d = data[i][colFecha];
    const v = data[i][colPeso];
    if (d instanceof Date && d.getTime() < fecha.getTime() && typeof v === 'number' && v > 0) {
      prevPeso = v; break;
    }
  }
  const variacion = (prevPeso != null) ? Math.round((peso - prevPeso) * 10) / 10 : '';

  if (rowIdx >= 0) {
    // Update existing row
    const writeRow = rowIdx + 1;
    sheet.getRange(writeRow, colPeso + 1).setValue(peso);
    if (colVar  >= 0 && variacion !== '') sheet.getRange(writeRow, colVar + 1).setValue(variacion);
    if (nota && colNota >= 0)             sheet.getRange(writeRow, colNota + 1).setValue(nota);
    return { ok: true, action: 'updated', row: writeRow };
  } else {
    // Append new row
    const row = new Array(headers.length).fill('');
    if (colFecha >= 0) row[colFecha] = fecha;
    if (colPeso  >= 0) row[colPeso]  = peso;
    if (colVar   >= 0 && variacion !== '') row[colVar] = variacion;
    if (colNota  >= 0) row[colNota]  = nota;
    sheet.appendRow(row);
    return { ok: true, action: 'appended', row: sheet.getLastRow() };
  }
}

/* ── MEDIDAS ────────────────────────────────────────── */
function addMedida(p) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Medidas');
  if (!sheet) throw 'No existe la hoja "Medidas"';
  const fecha = parseDate(p.fecha);

  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).toLowerCase());
  const colFecha   = headers.findIndex(h => h.indexOf('fecha') >= 0);
  const colCintura = headers.findIndex(h => h.indexOf('cintura') >= 0 && h.indexOf('/') === -1 && h.indexOf('ratio') === -1 && h.indexOf('indice') === -1);
  const colCadera  = headers.findIndex(h => h.indexOf('cadera') >= 0 && h.indexOf('/') === -1);
  const colRatio   = headers.findIndex(h => h.indexOf('ratio') >= 0 || h.indexOf('indice') >= 0 || (h.indexOf('cintura') >= 0 && h.indexOf('/') >= 0));
  const colPecho   = headers.findIndex(h => h.indexOf('pecho') >= 0);
  const colBrazo   = headers.findIndex(h => h.indexOf('brazo') >= 0);
  const colMuslo   = headers.findIndex(h => h.indexOf('muslo') >= 0);
  const colNotas   = headers.findIndex(h => h.indexOf('nota') >= 0);

  const cintura = parseFloat(p.cintura);
  const cadera  = parseFloat(p.cadera);
  const pecho   = parseFloat(p.pecho);
  const brazo   = parseFloat(p.brazo);
  const muslo   = parseFloat(p.muslo);
  const notas   = p.notas || '';
  const ratio   = (!isNaN(cintura) && !isNaN(cadera) && cadera > 0) ? (cintura / cadera) : '';

  // Buscar fila existente por fecha
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    const d = data[i][colFecha];
    if (d instanceof Date && sameDay(d, fecha)) { rowIdx = i; break; }
  }

  const writeRow = (rowIdx >= 0) ? (rowIdx + 1) : (sheet.getLastRow() + 1);
  if (rowIdx < 0 && colFecha >= 0) sheet.getRange(writeRow, colFecha + 1).setValue(fecha);

  function set(col, val) { if (col >= 0 && !(typeof val === 'number' && isNaN(val))) sheet.getRange(writeRow, col + 1).setValue(val); }
  set(colCintura, cintura);
  set(colCadera,  cadera);
  set(colRatio,   ratio);
  set(colPecho,   pecho);
  set(colBrazo,   brazo);
  set(colMuslo,   muslo);
  if (notas) set(colNotas, notas);

  return { ok: true, action: rowIdx >= 0 ? 'updated' : 'appended', row: writeRow };
}

/* ── ACTIVIDAD (sesión de gym/cardio) ──────────────── */
function addActividad(p) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Actividad');
  if (!sheet) throw 'No existe la hoja "Actividad"';
  const fecha = parseDate(p.fecha);
  const tipo  = (p.tipo || '').trim();
  const duracion = parseFloat(p.duracion);
  const intensidad = parseFloat(p.intensidad);
  const notas = p.notas || '';
  if (!tipo) throw 'El tipo es obligatorio';

  sheet.appendRow([
    fecha, tipo,
    isNaN(duracion)   ? '' : duracion,
    isNaN(intensidad) ? '' : intensidad,
    notas
  ]);
  return { ok: true, action: 'appended', row: sheet.getLastRow() };
}

/* ── COMIDA ─────────────────────────────────────────── */
function addComida(p) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const fecha = parseDate(p.fecha);
  const sheetName = MESES_ES[fecha.getMonth()] + ' ' + fecha.getFullYear();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw 'No existe la hoja "' + sheetName + '"';

  const momento   = (p.momento  || '').trim();
  const comida    = (p.comida   || '').trim();
  const categoria = (p.categoria|| '').trim();
  const notas     = (p.notas    || '').trim();
  if (!momento) throw 'El momento (Desayuno/Almuerzo/Cena) es obligatorio';
  if (!comida)  throw 'La descripción de la comida es obligatoria';

  // Buscar la fila donde la columna "Dia" tiene la fecha en formato "Wd DD/MM"
  const data = sheet.getDataRange().getValues();
  const dd = String(fecha.getDate()).padStart(2,'0');
  const mm = String(fecha.getMonth()+1).padStart(2,'0');
  const tag = dd + '/' + mm;

  // Determinar la columna de Dia/Momento/Comida/Categoria/Notas
  // Iteramos sobre las filas y detectamos los headers (puede haber una o dos filas de título antes)
  let headerRow = -1;
  for (let i = 0; i < Math.min(5, data.length); i++) {
    const row = data[i].map(c => String(c || '').toLowerCase());
    if (row.some(c => c === 'dia' || c === 'día')) { headerRow = i; break; }
  }
  if (headerRow < 0) throw 'No se encontró la fila de encabezados en "' + sheetName + '"';
  const hRow = data[headerRow].map(c => String(c || '').toLowerCase());
  const colDia       = hRow.findIndex(c => c === 'dia' || c === 'día');
  const colMomento   = hRow.findIndex(c => c.indexOf('momento') >= 0);
  const colComida    = hRow.findIndex(c => c.indexOf('comida') >= 0);
  const colCategoria = hRow.findIndex(c => c.indexOf('categor') >= 0);
  const colNotas     = hRow.findIndex(c => c.indexOf('nota') >= 0);

  // Encontrar la primera fila del día (donde "Dia" contiene DD/MM)
  let dayStartRow = -1;
  for (let i = headerRow + 1; i < data.length; i++) {
    const cell = String(data[i][colDia] || '').trim();
    if (cell.indexOf(tag) >= 0) { dayStartRow = i; break; }
  }
  if (dayStartRow < 0) throw 'No se encontró el día ' + tag + ' en "' + sheetName + '"';

  // Buscar el momento entre las próximas filas (típicamente 3: Desayuno/Almuerzo/Cena)
  let momentoRowIdx = -1;
  for (let i = dayStartRow; i < Math.min(dayStartRow + 6, data.length); i++) {
    const cellMom = String(data[i][colMomento] || '').trim();
    const cellDia = String(data[i][colDia] || '').trim();
    // Si encontramos otro día, paramos
    if (i > dayStartRow && cellDia && cellDia.indexOf(tag) < 0 && /\d+\/\d+/.test(cellDia)) break;
    if (cellMom && cellMom.toLowerCase().indexOf(momento.toLowerCase()) === 0) {
      momentoRowIdx = i;
      break;
    }
  }
  if (momentoRowIdx < 0) throw 'No se encontró el momento "' + momento + '" para el día ' + tag;

  const writeRow = momentoRowIdx + 1;
  if (colComida >= 0)    sheet.getRange(writeRow, colComida + 1).setValue(comida);
  if (categoria && colCategoria >= 0) sheet.getRange(writeRow, colCategoria + 1).setValue(categoria);
  if (notas && colNotas >= 0)         sheet.getRange(writeRow, colNotas + 1).setValue(notas);

  return { ok: true, action: 'updated', row: writeRow, sheet: sheetName };
}
