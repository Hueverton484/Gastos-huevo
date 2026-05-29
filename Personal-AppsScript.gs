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
 *
 * Si YA lo tenías desplegado y estás actualizando (p.ej. para sumar Facultad):
 *  - Pegá este código completo, guardá (Ctrl+S)
 *  - Deploy → Manage deployments → (ícono lápiz para editar) → Version: "New version" → Deploy
 *  - La URL /exec NO cambia, así que no hay que reconfigurar nada en la app.
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
    else if (action === 'get_facultad')  result = getFacultad();
    else if (action === 'save_facultad') result = saveFacultad(p);
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

/**
 * POST para guardar Facultad (el JSON puede ser grande y no entra cómodo en la URL).
 * La app envía: { action: 'save_facultad', data: { ...estado de facultad... } }
 */
function doPost(e) {
  let result;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'save_facultad') {
      result = saveFacultad({ data: JSON.stringify(body.data || {}) });
    } else {
      result = { ok: false, error: 'Acción POST desconocida: ' + body.action };
    }
  } catch (err) {
    result = { ok: false, error: String(err && err.message ? err.message : err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

/* ── FACULTAD (parciales, clases y materias — guardado como JSON en una celda) ── */
function facuSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Facultad');
  if (!sh) {
    sh = ss.insertSheet('Facultad');
    sh.getRange('A1').setNote('Datos de la solapa Facultad (JSON). No editar a mano.');
  }
  return sh;
}
function getFacultad() {
  const val = facuSheet_().getRange('A1').getValue();
  return { ok: true, facultad: val ? String(val) : '' };
}
function saveFacultad(p) {
  facuSheet_().getRange('A1').setValue(p.data || '');
  return { ok: true };
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

  // Layout posicional (la hoja NO tiene encabezados de texto, solo "Nota").
  // Col A vacía; B=fecha, C=peso, D=variación, E=nota.
  const C_FECHA = 2, C_PESO = 3, C_VAR = 4, C_NOTA = 5;
  const data = sheet.getDataRange().getValues();

  // Acoplar a la fila cuya fecha sea la MÁS CERCANA a la cargada
  // (la tabla viene pre-cargada con las fechas semanales).
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < data.length; i++) {
    const d = data[i][C_FECHA - 1];
    if (d instanceof Date) {
      const dist = Math.abs(d.getTime() - fecha.getTime());
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
  }

  if (bestIdx >= 0) {
    const writeRow = bestIdx + 1;
    // Variación = peso - último peso cargado en una fila anterior
    let prevPeso = null;
    for (let i = bestIdx - 1; i >= 0; i--) {
      const v = data[i][C_PESO - 1];
      if (typeof v === 'number' && v > 0) { prevPeso = v; break; }
    }
    const variacion = (prevPeso != null) ? Math.round((peso - prevPeso) * 10) / 10 : '';
    sheet.getRange(writeRow, C_PESO).setValue(peso);
    if (variacion !== '') sheet.getRange(writeRow, C_VAR).setValue(variacion);
    if (nota)             sheet.getRange(writeRow, C_NOTA).setValue(nota);
    return { ok: true, action: 'snapped', row: writeRow };
  }
  // Sin filas con fecha: agregar al final
  sheet.appendRow(['', fecha, peso, '', nota]);
  return { ok: true, action: 'appended', row: sheet.getLastRow() };
}

/* ── MEDIDAS ────────────────────────────────────────── */
function addMedida(p) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Medidas');
  if (!sheet) throw 'No existe la hoja "Medidas"';
  const fecha = parseDate(p.fecha);

  // Layout posicional (la hoja NO tiene encabezados de texto, solo "Nota").
  // Col A vacía; B=fecha, C=cintura, D=cadera, E=ratio, F=pecho, G=brazo, H=muslo, I=notas.
  const C_FECHA = 2, C_CINT = 3, C_CAD = 4, C_RATIO = 5, C_PECHO = 6, C_BRAZO = 7, C_MUSLO = 8, C_NOTAS = 9;
  const cintura = parseFloat(p.cintura);
  const cadera  = parseFloat(p.cadera);
  const pecho   = parseFloat(p.pecho);
  const brazo   = parseFloat(p.brazo);
  const muslo   = parseFloat(p.muslo);
  const notas   = p.notas || '';
  const ratio   = (!isNaN(cintura) && !isNaN(cadera) && cadera > 0) ? (cintura / cadera) : '';

  const data = sheet.getDataRange().getValues();
  // Acoplar a la fila cuya fecha sea la MÁS CERCANA a la cargada
  // (la tabla viene pre-cargada con las fechas mensuales).
  let bestIdx = -1, bestDist = Infinity;
  for (let i = 0; i < data.length; i++) {
    const d = data[i][C_FECHA - 1];
    if (d instanceof Date) {
      const dist = Math.abs(d.getTime() - fecha.getTime());
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
  }

  if (bestIdx >= 0) {
    const writeRow = bestIdx + 1;
    const set = (col, val) => { if (!(typeof val === 'number' && isNaN(val)) && val !== '') sheet.getRange(writeRow, col).setValue(val); };
    set(C_CINT, cintura); set(C_CAD, cadera); set(C_RATIO, ratio);
    set(C_PECHO, pecho); set(C_BRAZO, brazo); set(C_MUSLO, muslo);
    if (notas) sheet.getRange(writeRow, C_NOTAS).setValue(notas);
    return { ok: true, action: 'snapped', row: writeRow };
  }
  // Sin filas con fecha: agregar al final
  const v = x => (typeof x === 'number' && isNaN(x)) ? '' : x;
  sheet.appendRow(['', fecha, v(cintura), v(cadera), v(ratio), v(pecho), v(brazo), v(muslo), notas]);
  return { ok: true, action: 'appended', row: sheet.getLastRow() };
}

/* ── ACTIVIDAD (sesión de gym) ──────────────────────── */
function addActividad(p) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Actividad');
  if (!sheet) throw 'No existe la hoja "Actividad"';
  const fecha = parseDate(p.fecha);
  const tipo  = (p.tipo || '').trim();
  const duracion = parseFloat(p.duracion);
  const intensidad = parseFloat(p.intensidad);
  const notas = p.notas || '';
  const cardio = (p.cardio || '').trim();
  if (!tipo) throw 'El tipo es obligatorio';

  // IMPORTANTE: la col A es un separador vacío; los datos van de B a G
  // (igual que el resto del libro). Por eso anteponemos '' para empezar en B.
  // B=fecha, C=tipo/categoría, D=duración, E=intensidad, F=notas, G=¿hubo cardio?
  sheet.appendRow([
    '', fecha, tipo,
    isNaN(duracion)   ? '' : duracion,
    isNaN(intensidad) ? '' : intensidad,
    notas, cardio
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
