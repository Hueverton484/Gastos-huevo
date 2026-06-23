// ============================================================
//
//   WEB APP — Dashboard servido como página web
//
//   Este archivo expone el dashboard del Sheet como una URL
//   accesible desde cualquier navegador (compu o celu).
//
//   Cómo deployar (la primera vez):
//   1. En el editor de Apps Script, click en "Deploy" → "New deployment"
//   2. Tipo: "Web app"
//   3. Description: "Dashboard de finanzas"
//   4. Execute as: "Me (tu cuenta de Google)"
//   5. Who has access: "Only myself" (recomendado)
//   6. Click "Deploy" y autorizá los permisos
//   7. Copiá la URL (termina en /exec) y abrila en el navegador
//
//   Cuando hagas cambios al código:
//   1. Deploy → Manage deployments → editá (lápiz) → New version → Deploy
//      (NO crees un deployment nuevo o vas a tener URLs distintas)
//
// ============================================================

// ============================================================
// AUTH POR TOKEN
// ============================================================
// El API_TOKEN se guarda en Script Properties (igual que GEMINI_API_KEY).
//
// SETUP (primera vez):
//   1) En este Apps Script: Project Settings → Script Properties → Add property
//      Key: API_TOKEN
//      Value: <generá un string random largo, ej. 32+ caracteres>
//   2) En la PWA, al primer arranque te pide ese mismo token y lo guarda en
//      localStorage. Después se manda automáticamente en cada request.
//
// SI API_TOKEN NO ESTÁ configurado, la API queda ABIERTA — modo de transición
// para no romper la PWA mientras configurás. Configurar el token es lo PRIMERO
// que hay que hacer si el repo está expuesto.
function _checkAuth(p) {
  const expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!expected) return { ok: true, _openMode: true }; // modo transición
  const got = (p && p.token) ? String(p.token) : '';
  if (got !== expected) {
    return { ok: false, error: 'Token inválido. Configurá tu API_TOKEN en la PWA.' };
  }
  return { ok: true };
}

function doGet(e) {
  // ── AUTH: validar token antes de cualquier acción ──────────
  const auth = _checkAuth(e && e.parameter);
  if (!auth.ok) {
    const cb = (e && e.parameter && e.parameter.callback) ? e.parameter.callback : null;
    if (cb) return _jsonpResponse(cb, auth);
    return ContentService.createTextOutput(JSON.stringify(auth))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Modo "add_gasto" / "add_ingreso": cargar entrada nueva desde el dashboard
  if (e && e.parameter && e.parameter.action === 'add_gasto' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _agregarGasto(e.parameter));
  }
  if (e && e.parameter && e.parameter.action === 'add_ingreso' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _agregarIngreso(e.parameter));
  }
  // Modo "add_ciclo": guardar cierre/vencimiento de un ciclo de tarjeta
  if (e && e.parameter && e.parameter.action === 'add_ciclo' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _agregarCiclo(e.parameter));
  }
  // Modo "add_cuota": guardar una compra en cuotas
  if (e && e.parameter && e.parameter.action === 'add_cuota' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _agregarCuota(e.parameter));
  }
  // Modo "delete_movimiento": borrar un gasto o ingreso (fila del Sheet)
  if (e && e.parameter && e.parameter.action === 'delete_movimiento' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _borrarMovimiento(e.parameter));
  }
  // Modo "edit_movimiento": editar un gasto o ingreso existente
  if (e && e.parameter && e.parameter.action === 'edit_movimiento' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _editarMovimiento(e.parameter));
  }
  // Modo "set_ajuste_saldo": fijar el sobrante de arranque de un mes para que
  // el saldo refleje la plata real (corrige el arrastre acumulado inflado).
  if (e && e.parameter && e.parameter.action === 'set_ajuste_saldo' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _setAjusteSaldo(e.parameter));
  }
  // Modo "clear_ajuste_saldo": quitar el ajuste de un mes (vuelve al arrastre automático)
  if (e && e.parameter && e.parameter.action === 'clear_ajuste_saldo' && e.parameter.callback) {
    return _jsonpResponse(e.parameter.callback, _clearAjusteSaldo(e.parameter));
  }

  // Modo "ask": consulta al asistente financiero (Gemini)
  // Llamada: ?action=ask&q=texto-pregunta&history=JSON&callback=funcName
  // history es un JSON con [{role:'user'|'model', text:'...'}] de mensajes previos.
  if (e && e.parameter && e.parameter.action === 'ask' && e.parameter.callback) {
    const question = e.parameter.q || '';
    let history = [];
    if (e.parameter.history) {
      try { history = JSON.parse(e.parameter.history); } catch (err) { history = []; }
    }
    const answer = askGemini(question, history);
    const cb = e.parameter.callback.replace(/[^a-zA-Z0-9_$]/g, '');
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify({answer: answer}) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  // Modo JSONP: cuando el frontend estático llama con ?callback=funcName
  // devolvemos los datos envueltos en una función JS para evitar CORS.
  if (e && e.parameter && e.parameter.callback) {
    const data = getDashboardData();
    const cb = e.parameter.callback.replace(/[^a-zA-Z0-9_$]/g, '');
    return ContentService
      .createTextOutput(cb + '(' + JSON.stringify(data) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  // Modo JSON puro: para llamadas server-side o testing manual
  if (e && e.parameter && e.parameter.format === 'json') {
    const data = getDashboardData();
    return ContentService
      .createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // Modo HTML: el dashboard servido directo desde Apps Script (fallback)
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Gastos 2026 · Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


// ============================================================
// ASISTENTE FINANCIERO (Gemini)
// ============================================================
//
// La API key de Gemini se guarda en Project Settings → Script Properties
// con el nombre GEMINI_API_KEY (no se hardcodea en el código).
//
// PRIMERA VEZ: hay que autorizar UrlFetchApp manualmente. Para eso,
// correr la función _autorizarPermisos() una vez desde el editor.
//
// Comandos del chat (escribís al inicio del mensaje):
//   /cinico — el bot te responde con sarcasmo y verdades incómodas
//   /mama   — el bot responde como mamá argentina típica
//   /futuro — el bot te habla como vos mismo en 5 años
//   (sin comando) — asesor financiero serio, directo, honesto

const HORAS_LABORALES_MES = 176; // 22 días × 8 hs — usado para costo en tiempo

function _autorizarPermisos() {
  // Helper para gatillar el pedido de permiso de UrlFetchApp.
  UrlFetchApp.fetch('https://www.google.com');
  Logger.log('OK: UrlFetchApp autorizado. Ya podés usar el asistente desde el dashboard.');
}

// ============================================================
// CARGA RÁPIDA DE GASTOS / INGRESOS DESDE EL DASHBOARD
// ============================================================
//
// Estos endpoints reciben datos del formulario del dashboard y los
// escriben en las mismas hojas que usa el Form de Google. Son
// equivalentes funcionalmente: cargar acá o cargar por el Form
// produce el mismo registro en el Sheet.

function _jsonpResponse(callback, data) {
  const cb = String(callback || 'cb').replace(/[^a-zA-Z0-9_$]/g, '');
  return ContentService
    .createTextOutput(cb + '(' + JSON.stringify(data) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function _parseFechaInput(s) {
  // Espera formato YYYY-MM-DD (lo que devuelve <input type="date">)
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const fecha = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(fecha.getTime()) ? null : fecha;
}

function _agregarGasto(p) {
  try {
    const fecha = _parseFechaInput(p.fecha);
    const cat = (p.cat || '').toString().trim();
    const desc = (p.desc || '').toString().trim();
    const monto = parseFloat(p.monto);
    const cuenta = (p.cuenta || '').toString().trim();

    if (!fecha) return { ok: false, error: 'Fecha inválida' };
    if (!cat) return { ok: false, error: 'Falta categoría' };
    if (isNaN(monto) || monto <= 0) return { ok: false, error: 'Monto inválido' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Respuestas de formulario 1');
    if (!sheet) return { ok: false, error: 'Hoja "Respuestas de formulario 1" no existe' };

    // Lock + dedupe: si esto es un reintento de una operación que ya se
    // guardó (la respuesta se perdió por timeout), no duplicar la fila.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (_yaProcesado(p.reqId)) return { ok: true, dedup: true };

      // Si la hoja tiene la columna Cuenta (6+ columnas), la incluimos.
      const lastCol = sheet.getLastColumn();
      const row = [new Date(), fecha, cat, desc, monto];
      if (lastCol >= 6) row.push(cuenta);

      sheet.appendRow(row);
      _marcarProcesado(p.reqId);
    } finally {
      lock.releaseLock();
    }

    // Regenerar el Dashboard interno del Sheet en segundo plano para que la
    // respuesta vuelva rápido (la PWA no depende de esa regeneración).
    _programarRegeneracion();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function _agregarIngreso(p) {
  try {
    const fecha = _parseFechaInput(p.fecha);
    const desc = (p.desc || '').toString().trim();
    const monto = parseFloat(p.monto);

    if (!fecha) return { ok: false, error: 'Fecha inválida' };
    if (isNaN(monto) || monto <= 0) return { ok: false, error: 'Monto inválido' };

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Respuestas de formulario 2');
    if (!sheet) return { ok: false, error: 'Hoja "Respuestas de formulario 2" no existe' };

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (_yaProcesado(p.reqId)) return { ok: true, dedup: true };
      sheet.appendRow([new Date(), fecha, desc, monto]);
      _marcarProcesado(p.reqId);
    } finally {
      lock.releaseLock();
    }

    _programarRegeneracion();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── BORRAR / EDITAR MOVIMIENTOS (desde la PWA) ──────────────
// La PWA identifica cada fila por su número de fila en el Sheet (campo "row"
// que viaja en getDashboardData). Antes de tocar la fila verificamos que el
// monto coincida con el que la app tenía — si alguien movió filas en el medio,
// devolvemos error en vez de borrar/editar la fila equivocada.

function _hojaMovimiento(tipo) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return tipo === 'ingreso'
    ? ss.getSheetByName('Respuestas de formulario 2')
    : ss.getSheetByName('Respuestas de formulario 1');
}

function _borrarMovimiento(p) {
  try {
    const tipo = (p.tipo === 'ingreso') ? 'ingreso' : 'gasto';
    const row = parseInt(p.row);
    const monto = parseFloat(p.monto);
    if (isNaN(row) || row < 2) return { ok: false, error: 'Fila inválida' };
    const sheet = _hojaMovimiento(tipo);
    if (!sheet) return { ok: false, error: 'Hoja no existe' };

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (_yaProcesado(p.reqId)) return { ok: true, dedup: true };
      if (row > sheet.getLastRow()) return { ok: false, error: 'La fila ya no existe. Actualizá la app y probá de nuevo.' };
      const vals = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
      const montoEnFila = parseFloat(tipo === 'gasto' ? vals[4] : vals[3]);
      if (!isNaN(monto) && Math.abs(montoEnFila - monto) > 0.01) {
        return { ok: false, error: 'Los datos cambiaron desde que abriste la app. Actualizá y probá de nuevo.' };
      }
      sheet.deleteRow(row);
      _marcarProcesado(p.reqId);
      _bumpDataVersion();
    } finally {
      lock.releaseLock();
    }
    _programarRegeneracion();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function _editarMovimiento(p) {
  try {
    const tipo = (p.tipo === 'ingreso') ? 'ingreso' : 'gasto';
    const row = parseInt(p.row);
    const origMonto = parseFloat(p.origMonto);
    const fecha = _parseFechaInput(p.fecha);
    const monto = parseFloat(p.monto);
    const desc = (p.desc || '').toString().trim();
    if (isNaN(row) || row < 2) return { ok: false, error: 'Fila inválida' };
    if (!fecha) return { ok: false, error: 'Fecha inválida' };
    if (isNaN(monto) || monto <= 0) return { ok: false, error: 'Monto inválido' };
    const sheet = _hojaMovimiento(tipo);
    if (!sheet) return { ok: false, error: 'Hoja no existe' };

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (_yaProcesado(p.reqId)) return { ok: true, dedup: true };
      if (row > sheet.getLastRow()) return { ok: false, error: 'La fila ya no existe. Actualizá la app y probá de nuevo.' };
      const vals = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
      const montoEnFila = parseFloat(tipo === 'gasto' ? vals[4] : vals[3]);
      if (!isNaN(origMonto) && Math.abs(montoEnFila - origMonto) > 0.01) {
        return { ok: false, error: 'Los datos cambiaron desde que abriste la app. Actualizá y probá de nuevo.' };
      }
      if (tipo === 'gasto') {
        const cat = (p.cat || '').toString().trim();
        if (!cat) return { ok: false, error: 'Falta categoría' };
        const cuenta = (p.cuenta || '').toString().trim();
        if (sheet.getLastColumn() >= 6) {
          sheet.getRange(row, 2, 1, 5).setValues([[fecha, cat, desc, monto, cuenta]]);
        } else {
          sheet.getRange(row, 2, 1, 4).setValues([[fecha, cat, desc, monto]]);
        }
      } else {
        sheet.getRange(row, 2, 1, 3).setValues([[fecha, desc, monto]]);
      }
      _marcarProcesado(p.reqId);
      _bumpDataVersion();
    } finally {
      lock.releaseLock();
    }
    _programarRegeneracion();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// Versión de datos: se incrementa en ediciones/borrados (mutaciones que no
// cambian la cantidad de filas, o que la cambian de forma que podría chocar
// con una entrada vieja de caché). Forma parte de la clave de caché del
// dashboard, así cualquier mutación invalida la caché al instante.
function _bumpDataVersion() {
  try {
    const props = PropertiesService.getScriptProperties();
    const v = parseInt(props.getProperty('DATA_VERSION') || '0', 10) + 1;
    props.setProperty('DATA_VERSION', String(v));
  } catch (e) {}
}

// ── AJUSTE DE SALDO POR MES ─────────────────────────────────
// Corrige el arrastre acumulado del sobrante (que se infla con meses viejos
// incompletos). El usuario fija el SALDO REAL de un mes; guardamos el
// "sobrante de arranque" (valor absoluto) necesario para que ese mes dé ese
// saldo. A partir de ese mes el arrastre sigue normal. Como guardamos el
// sobrante (no el saldo), los gastos nuevos del mes siguen bajando el saldo.
// Hoja "Ajustes Saldo": [Mes (YYYY-MM), Sobrante arranque, Saldo objetivo, Actualizado].
function _ajustesSaldoSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName('Ajustes Saldo');
  if (!h) {
    h = ss.insertSheet('Ajustes Saldo');
    h.getRange(1, 1, 1, 4).setValues([['Mes', 'Sobrante arranque', 'Saldo objetivo', 'Actualizado']]).setFontWeight('bold');
  }
  return h;
}

function _leerAjustesSaldo(ss) {
  const h = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName('Ajustes Saldo');
  if (!h || h.getLastRow() < 2) return {};
  const out = {};
  h.getDataRange().getValues().slice(1).forEach(r => {
    const mes = String(r[0] || '').trim();
    if (!/^\d{4}-\d{2}$/.test(mes)) return;
    const sob = parseFloat(r[1]);
    if (!isNaN(sob)) out[mes] = sob;
  });
  return out;
}

function _setAjusteSaldo(p) {
  try {
    const mes = String(p.mes || '').trim();
    const sobrante = parseFloat(p.sobrante);
    const saldoObjetivo = parseFloat(p.saldoObjetivo);
    if (!/^\d{4}-\d{2}$/.test(mes)) return { ok: false, error: 'Mes inválido (esperado YYYY-MM)' };
    if (isNaN(sobrante)) return { ok: false, error: 'Sobrante inválido' };
    const h = _ajustesSaldoSheet_();
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (_yaProcesado(p.reqId)) return { ok: true, dedup: true };
      const data = h.getDataRange().getValues();
      let fila = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0] || '').trim() === mes) { fila = i + 1; break; }
      }
      const row = [mes, sobrante, isNaN(saldoObjetivo) ? '' : saldoObjetivo, new Date()];
      if (fila > 0) h.getRange(fila, 1, 1, 4).setValues([row]);
      else h.appendRow(row);
      _marcarProcesado(p.reqId);
      _bumpDataVersion();
    } finally { lock.releaseLock(); }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function _clearAjusteSaldo(p) {
  try {
    const mes = String(p.mes || '').trim();
    if (!/^\d{4}-\d{2}$/.test(mes)) return { ok: false, error: 'Mes inválido' };
    const h = (SpreadsheetApp.getActiveSpreadsheet()).getSheetByName('Ajustes Saldo');
    if (!h) return { ok: true };
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const data = h.getDataRange().getValues();
      for (let i = data.length - 1; i >= 1; i--) {
        if (String(data[i][0] || '').trim() === mes) h.deleteRow(i + 1);
      }
      _bumpDataVersion();
    } finally { lock.releaseLock(); }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ── CICLOS DE TARJETA (cierre/vencimiento) ──────────────────
// Hoja "Ciclos TC" con dos columnas: Cierre | Vencimiento.
// Se crea sola la primera vez que cargás un ciclo desde la app.
function _ciclosSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName('Ciclos TC');
  if (!h) {
    h = ss.insertSheet('Ciclos TC');
    h.getRange(1, 1, 1, 2).setValues([['Cierre', 'Vencimiento']]).setFontWeight('bold');
  }
  return h;
}

function _leerCiclos(ss) {
  const h = (ss || SpreadsheetApp.getActiveSpreadsheet()).getSheetByName('Ciclos TC');
  if (!h || h.getLastRow() < 2) return [];
  return h.getDataRange().getValues().slice(1)
    .filter(r => r[0] instanceof Date && r[1] instanceof Date)
    .map(r => ({ cierre: r[0].getTime(), vencimiento: r[1].getTime() }))
    .sort((a, b) => a.cierre - b.cierre);
}

function _agregarCiclo(p) {
  try {
    const cierre = _parseFechaInput(p.cierre);
    const venc   = _parseFechaInput(p.vencimiento);
    if (!cierre) return { ok: false, error: 'Fecha de cierre inválida' };
    if (!venc)   return { ok: false, error: 'Fecha de vencimiento inválida' };
    const h = _ciclosSheet_();
    // Anti-duplicados: si ya existe una fila con el mismo cierre, actualizar su
    // vencimiento en vez de agregar una fila nueva (sirve también para corregir).
    const data = h.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const c = data[i][0];
      if (c instanceof Date && c.getFullYear() === cierre.getFullYear() &&
          c.getMonth() === cierre.getMonth() && c.getDate() === cierre.getDate()) {
        h.getRange(i + 1, 2).setValue(venc);
        return { ok: true, action: 'updated' };
      }
    }
    h.appendRow([cierre, venc]);
    return { ok: true, action: 'appended' };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ── COMPRAS EN CUOTAS (desde la PWA) ────────────────────────
// Guarda una compra en cuotas en la hoja "Cuotas". La "1ª cuota" se guarda
// como el VENCIMIENTO del ciclo de la fecha de compra, así la cuota 1 cae en
// el mes que se paga (y _getCuotasMes reparte el resto en los meses sucesivos).
function _agregarCuota(p) {
  try {
    const desc = (p.desc || '').toString().trim();
    const montoTotal = parseFloat(p.montoTotal);
    const nCuotas = parseInt(p.nCuotas);
    const fechaCompra = _parseFechaInput(p.fechaCompra);
    const categoria = (p.categoria || 'Otro').toString().trim() || 'Otro';
    if (!desc) return { ok: false, error: 'Falta la descripción' };
    if (isNaN(montoTotal) || montoTotal <= 0) return { ok: false, error: 'Monto total inválido' };
    if (isNaN(nCuotas) || nCuotas < 1) return { ok: false, error: 'Cantidad de cuotas inválida' };
    if (!fechaCompra) return { ok: false, error: 'Fecha de compra inválida' };

    // Aplicar el corte de tarjeta:
    //  - Compras PRE-corte → cuota 1 en el mes de la compra (modelo viejo),
    //    así integra con el "dump" del resumen ya cargado y _ajustarPagosTarjeta
    //    la resta correctamente, evitando doble conteo.
    //  - Compras POST-corte → cuota 1 en el vencimiento del ciclo (modelo nuevo).
    const ciclos = _leerCiclos();
    const vencMs = _vencimientoParaFecha(ciclos, fechaCompra.getTime());
    const preCorte = fechaCompra.getTime() < CORTE_TARJETA;
    const fecha1 = preCorte ? fechaCompra : (vencMs ? new Date(vencMs) : fechaCompra);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let h = ss.getSheetByName('Cuotas');
    if (!h) {
      h = ss.insertSheet('Cuotas');
      h.getRange(1, 1, 1, 6).setValues([['Descripción', 'Monto Total', 'N° Cuotas', 'Fecha 1° Cuota (dd/mm/aaaa)', 'Categoría', 'Cuenta']]).setFontWeight('bold');
    }
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      if (_yaProcesado(p.reqId)) return { ok: true, dedup: true };
      h.appendRow([desc, montoTotal, nCuotas, fecha1, categoria, 'Tarjeta de crédito']);
      _marcarProcesado(p.reqId);
    } finally {
      lock.releaseLock();
    }
    _programarRegeneracion();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

// ── IMPUTACIÓN DE COMPRAS CON TARJETA AL MES DEL VENCIMIENTO ──
// A partir de esta fecha, las compras con cuenta "Tarjeta de crédito" se
// imputan al mes del vencimiento del ciclo (no al mes de la compra).
// Las compras anteriores quedan como están (modelo viejo, histórico intacto).
var CORTE_TARJETA = new Date(2026, 4, 29).getTime(); // 29/05/2026

// Devuelve el timestamp del vencimiento del ciclo al que pertenece una compra.
// ciclos: array {cierre, vencimiento} ORDENADO por cierre asc.
// Si la compra es posterior al último cierre cargado, extrapola mes a mes
// (estimación) hasta que cargues la fecha real del próximo ciclo.
function _vencimientoParaFecha(ciclos, fechaMs) {
  if (!ciclos || !ciclos.length) return null;
  for (var i = 0; i < ciclos.length; i++) {
    if (ciclos[i].cierre >= fechaMs) return ciclos[i].vencimiento;
  }
  var last = ciclos[ciclos.length - 1];
  var cierre = new Date(last.cierre);
  var venc = new Date(last.vencimiento);
  var guard = 0;
  while (cierre.getTime() < fechaMs && guard < 60) {
    cierre.setMonth(cierre.getMonth() + 1);
    venc.setMonth(venc.getMonth() + 1);
    guard++;
  }
  return venc.getTime();
}

// Llama a actualizarResumen() pero sin el alert final (que falla cuando
// se ejecuta desde un Web App al no haber UI disponible).
function _regenerarResumenSilencioso() {
  try {
    actualizarResumen();
  } catch (err) {
    // Si actualizarResumen falla por el getUi().alert (típico cuando se
    // llama desde el Web App), el resto ya se ejecutó correctamente.
    // Ignoramos el error del alert.
  }
}

// ── GUARDADO RÁPIDO: regeneración del Dashboard EN SEGUNDO PLANO ──
// Antes, cada add_gasto/add_ingreso regeneraba el Dashboard interno del Sheet
// ANTES de responder → la respuesta tardaba 10-20s, el frontend cortaba por
// timeout y mostraba error aunque la fila ya estaba guardada.
// Ahora el add responde apenas se escribe la fila, y el Dashboard se regenera
// 1 segundo después vía trigger (sin bloquear la respuesta). Si el script no
// tiene permiso para crear triggers (falta re-autorizar), cae al modo viejo.
function _programarRegeneracion() {
  try {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === '_regenTrigger') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('_regenTrigger').timeBased().after(1000).create();
  } catch (e) {
    // Sin permiso de triggers → regenerar inline (lento pero funcional).
    _regenerarResumenSilencioso();
  }
}

function _regenTrigger() {
  try {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === '_regenTrigger') ScriptApp.deleteTrigger(t);
    });
  } catch (e) { /* seguir igual */ }
  _regenerarResumenSilencioso();
}

// ── IDEMPOTENCIA: dedupe por reqId ──────────────────────────────
// El frontend manda un reqId único por operación. Si la respuesta se pierde
// (timeout, red) y reintenta con el MISMO reqId, acá lo detectamos y NO
// duplicamos la fila — devolvemos ok directamente.
function _yaProcesado(reqId) {
  if (!reqId) return false;
  try { return CacheService.getScriptCache().get('req_' + reqId) === '1'; }
  catch (e) { return false; }
}

function _marcarProcesado(reqId) {
  if (!reqId) return;
  try { CacheService.getScriptCache().put('req_' + reqId, '1', 3600); } catch (e) {}
}

const _PERSONALIDADES = {
  asesor: 'Sos el asesor financiero personal de Huevo. NO sos un calculador de stats — sos alguien con criterio formado que TOMA POSICIÓN. Cuando te pregunta algo, tu trabajo es ayudarlo a decidir, no tirarle datos para que él se rompa la cabeza. Si tenés que elegir entre dar 5 stats sin opinión o 1 dato + 1 recomendación clara, siempre elegís lo segundo. Tenés convicciones y las defendés con argumentos de su situación real. Te bancás equivocarte, lo que NO te bancás es escudarte detrás de "depende" o "es tu decisión". Si te pregunta "¿qué hago?" o "¿qué pensás?", respondés literal: lo que harías vos en su lugar y por qué. Pensás como un asesor de verdad que conoce a su cliente: integrás situación, metas, patrones y naturaleza del gasto en un juicio integrado, no listás factores en frío.',
  cinico: 'Sos cínico, sarcástico, irreverente. Tirás verdades incómodas con ironía. No insultás pero sos filoso. Decís cosas como "en serio me estás preguntando esto?" cuando la respuesta es obvia. Sos como un amigo cercano cansado de ver las mismas decisiones repetirse. No tenés filtro pero tenés razón. Igual que el asesor, terminás con una posición clara — solo que envuelta en sarcasmo.',
  mama: 'Sos una mamá argentina típica. Mezclás cariño con culpa: "mi amor", "tesoro", "vos sabés cuánto cuesta...". Te preocupás por el futuro de tu hijo pero sin sermonear. Tirás referencias a la abuela, al alquiler, a "cuando seas grande". Sos cálida pero filosa cuando hace falta. Igual que el asesor, terminás con una posición clara — pero como te lo diría tu vieja.',
  futuro: 'Sos Huevo en 5 años, hablándole al Huevo de hoy. Tenés perspectiva de lo que terminó importando y lo que no. Hablás desde experiencia: "Yo lo hice y no me cambió la vida" o "Esa decisión la tengo presente, no me arrepiento". Sos cálido pero franco. Igual que el asesor, terminás con una posición clara — desde la experiencia futura.'
};

function _detectarPersonalidad(question) {
  const m = String(question || '').match(/^\s*\/(\w+)\s+([\s\S]*)$/);
  if (m && _PERSONALIDADES[m[1].toLowerCase()]) {
    return { persona: m[1].toLowerCase(), cleanQuestion: m[2].trim() };
  }
  return { persona: 'asesor', cleanQuestion: String(question || '').trim() };
}

// ============================================================
// HOJA "Rechazos" — guarda gastos que Huevo decidió NO hacer
// ============================================================

function _crearHojaRechazos(ss) {
  let h = ss.getSheetByName('Rechazos');
  if (h) return h;
  h = ss.insertSheet('Rechazos');
  h.getRange(1, 1, 1, 5).setValues([['Marca temporal', 'Fecha', 'Descripción', 'Monto', 'Categoría']])
    .setBackground(CN).setFontColor('#ffffff').setFontWeight('bold').setFontSize(9);
  h.setColumnWidths(1, 5, 160);
  h.getRange(2, 4, 1000, 1).setNumberFormat('$#,##0');
  try { h.hideSheet(); } catch (e) { /* ignorar si ya está oculta */ }
  return h;
}

function _guardarDecision(meta) {
  if (!meta || !meta.decision || !meta.monto) return;
  if (meta.decision !== 'rechazo') return; // por ahora solo guardamos rechazos
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const h = _crearHojaRechazos(ss);
  const now = new Date();
  h.appendRow([now, now, meta.descripcion || '', Number(meta.monto) || 0, meta.categoria || 'Otro']);
}

function _leerRechazosRecientes(ss, dias) {
  const h = ss.getSheetByName('Rechazos');
  if (!h || h.getLastRow() < 2) return { items: [], total: 0, count: 0 };
  const cutoff = new Date(Date.now() - (dias || 7) * 24 * 60 * 60 * 1000);
  const filas = h.getDataRange().getValues().slice(1).filter(r => r[0] && new Date(r[0]) >= cutoff);
  const total = filas.reduce((s, r) => s + (Number(r[3]) || 0), 0);
  const items = filas.map(r => ({
    fecha: r[1], desc: r[2], monto: Number(r[3]) || 0, categoria: r[4]
  }));
  return { items: items, total: total, count: items.length };
}

// ============================================================
// PROCESAR META DE LA RESPUESTA DE GEMINI
// ============================================================

function _extraerMeta(respuestaCruda) {
  const m = respuestaCruda.match(/\[\[META\]\]\s*([\s\S]*?)\s*\[\[\/META\]\]/);
  if (!m) return { textoLimpio: respuestaCruda, meta: null };
  let meta = null;
  try { meta = JSON.parse(m[1]); } catch (e) { meta = null; }
  const textoLimpio = respuestaCruda.replace(/\[\[META\]\][\s\S]*?\[\[\/META\]\]/g, '').trim();
  return { textoLimpio: textoLimpio, meta: meta };
}

function askGemini(question, history) {
  if (!question || !question.trim()) {
    return 'Mandame una pregunta para ayudarte.';
  }
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    return 'Error: la API key de Gemini no está configurada. Agregala en Project Settings → Script Properties (key: GEMINI_API_KEY).';
  }

  // Detectar personalidad y limpiar la pregunta
  const det = _detectarPersonalidad(question);
  const persona = det.persona;
  const cleanQuestion = det.cleanQuestion;

  // Construir contexto financiero enriquecido
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let contextoFinanciero, ingresoMensualPromedio;
  try {
    const data = getDashboardData();
    ingresoMensualPromedio = _calcularIngresoMensualPromedio(data);
    const rechazos = _leerRechazosRecientes(ss, 30);
    contextoFinanciero = _construirContextoFinanciero(data, ingresoMensualPromedio, rechazos);
  } catch (err) {
    return 'No pude leer los datos financieros: ' + err.message;
  }

  const horaLaboral = ingresoMensualPromedio > 0 ? Math.round(ingresoMensualPromedio / HORAS_LABORALES_MES) : 0;
  const diaLaboral = horaLaboral * 8;

  const reglas =
    'Reglas duras de respuesta:\n' +
    '• Cuando te dirigís a Huevo, llamalo siempre "Huevo" (es como le gusta que le digan). Nunca uses ningún otro nombre.\n' +
    '• Hablás en castellano rioplatense ("vos", no "tú").\n' +
    '• Máximo 4 oraciones. Prosa fluida, sin viñetas ni listas.\n' +
    '• Números siempre con formato $X.XXX (puntos para miles).\n' +
    '• Cuando un gasto es notable (más de $20.000) y aplique al razonamiento, traducilo a horas o días de trabajo. Sabés que Huevo gana ' + (horaLaboral ? '$' + horaLaboral.toLocaleString('es-AR') + '/hora trabajada (≈ $' + diaLaboral.toLocaleString('es-AR') + '/día laboral, asumiendo ' + HORAS_LABORALES_MES + ' hs/mes)' : 'un ingreso variable que no logré inferir') + '.\n' +
    '• Notás patrones del historial real y los traés cuando son relevantes (ej. "ya rechazaste 2 vinos esta semana — ¿este es distinto?").\n' +
    '• Si la pregunta es ambigua o te falta info crítica, repreguntá. No inventes números ni patrones que no están en el contexto.\n' +
    '• Mantenés contexto conversacional: si Huevo dice "y eso?" o "y si lo hago dos veces?", respondés en base a lo que se charló antes.\n' +
    '• No recitás los datos del contexto literalmente. Los usás para razonar y sacar conclusiones.\n\n' +

    'CRITERIO Y POSTURA (esto es lo más importante):\n' +
    '• SIEMPRE terminás tu respuesta tomando una posición clara. No es opcional. Las opciones válidas son: "sí, hacelo", "no, pasalo", "esperá X días/semanas y reevaluamos", "hacelo si Y se cumple, si no esperá", "depende de Z, contame y te digo". El "depende" sin condición específica está PROHIBIDO como cierre.\n' +
    '• La frase "es tu decisión" / "evaluá vos" está prohibida como cierre. Pueden aparecer en el medio para reconocer que es decisión suya, pero el final tiene que ser tu recomendación.\n' +
    '• Cuando te piden tu opinión, tu opinión va al frente. No empieces con stats. Stat va al final como sustento. Estructura ideal: "[veredicto en una frase]. [argumento más fuerte en una frase]. [matiz o condición si corresponde]."\n' +
    '• Para juzgar un gasto, integrás (no listás): (a) ¿hay capacidad real ahora?, (b) ¿compromete metas activas?, (c) ¿es excepcional o repite un patrón conocido?, (d) ¿hay valor genuino para Huevo o es racionalización? Tu respuesta refleja el peso relativo de estos factores en este caso, no su enumeración.\n' +
    '• Cuando Huevo pregunta "¿qué pensás?" o "¿qué harías?" o "¿la ves bien?", respondés a la pregunta literal: con tu opinión, no con un análisis neutral.\n' +
    '• Si dos cosas tiran para lados opuestos (ej. "cabe en el saldo PERO compromete la meta"), elegís el factor más importante para este caso y construís la recomendación alrededor de él. No empatés.\n' +
    '• Cuando un gasto es razonable pero recurrente, tomá nota del patrón: "una está bien, tres en el mes ya es vicio". Cuando es excepcional, ojo con sentar precedente.\n\n' +

    'PRECISIÓN NUMÉRICA (no negociable):\n' +
    '• Cuando menciones un número en pesos, sacalo SIEMPRE del CONTEXTO FINANCIERO o de algo que Huevo haya dicho explícitamente en este chat. NUNCA inventes ni redondees mal. Si no estás 100% seguro de un número, no lo digas — preguntá o usá un rango.\n' +
    '• Los gastos por categoría del mes en curso son los del bloque "POR CATEGORÍA — ACTUAL vs ESPERADO". No mezcles ese número con el de cuotas distribuidas ni con promedios históricos sin aclarar. Si vas a sumar dos cosas, decí explícitamente cuáles.\n' +
    '• Si Huevo te tira un número sin contexto (ej. "125.000"), preguntale qué representa antes de razonar — no asumas que es el precio de algo ni el total del mes.\n\n' +

    'SALDO Y SOBRANTE ARRASTRADO (entendelo bien antes de hablar de plata disponible):\n' +
    '• El sobrante que un mes deja sin gastar se arrastra al mes siguiente como un INGRESO más ("Sobrante de mayo"). O sea: si mayo cerró con $100.000, junio ya arranca con ese sobrante sumado a su ingreso.\n' +
    '• "SALDO DISPONIBLE del mes" YA incluye ese sobrante arrastrado. Es la plata real que Huevo tiene para usar este mes (ingreso real + sobrante − gastos − ahorro). Cuando opinás sobre capacidad de gastar algo, esta es la métrica que más pesa. NO le sumes el sobrante de nuevo: ya está adentro del saldo.\n' +
    '• Si el "sobrante arrastrado" es alto, significa que Huevo viene gastando menos de lo que entra: tiene más aire del que cree. Si se queja de que "no le alcanza" pero el saldo (con sobrante) es holgado, decíselo con honestidad.\n' +
    '• Si el sobrante arrastrado es bajo o cero, viene gastando todo lo que entra mes a mes — dato relevante para opinar sobre gastos discrecionales nuevos.\n' +
    '• "Ingreso real del mes" (sin sobrante) es lo que sirve para hablar de su sueldo/capacidad de generación. "Ingreso total" y "saldo" son para hablar de cuánto puede gastar. No los mezcles.\n\n' +

    'USO DE COMPARACIONES (esto es lo que separa una respuesta criteriosa de una vacía):\n' +
    '• TODOS los números del CONTEXTO ya están calculados por el sistema (tendencias, proyecciones, %, promedios, colchón). Confiá en ellos y citalos — NO los recalcules de cabeza, porque te equivocás. Tu trabajo es interpretarlos y tomar posición, no rehacer la aritmética.\n' +
    '• El bloque "TRAYECTORIA Y SALUD FINANCIERA" es tu MARCO DE FONDO para cualquier opinión sobre capacidad de gasto. Antes de decir "sí" o "no" a algo, ubicalo en la película grande: ¿el gasto viene subiendo o bajando mes a mes?, ¿qué tasa de ahorro mantiene?, ¿tiene colchón o vive al límite? Un mismo gasto se juzga distinto según si Huevo tiene 3 meses de colchón o vive al día. Si la trayectoria es relevante para la pregunta, hacela explícita ("venís 3 meses subiendo el gasto, este no es el momento de sumar otro fijo").\n' +
    '• ANTES de opinar sobre la situación financiera o sobre si Huevo puede/debe hacer un gasto, mirá el bloque "RITMO DEL MES vs TU PROMEDIO HISTÓRICO". Si el mes viene apreciablemente distinto al promedio (>15% para arriba o para abajo), eso ENTRA en tu respuesta. No es opcional.\n' +
    '• Cuando el mes viene MÁS AUSTERO de lo habitual (ritmo diario por debajo del promedio, proyección por debajo, categorías importantes en negativo), eso da MARGEN REAL que un mes promedio no daría. Si en un mes normal le dirías "no" a un gasto, pero este mes viene 30% más austero, eso puede cambiar el veredicto — y tu respuesta tiene que ser explícita sobre esa lógica ("normalmente te frenaría, pero venís X% por debajo del promedio así que te alcanza el aire").\n' +
    '• Cuando el mes viene MÁS DERROCHADOR (ritmo por arriba, proyección por arriba, categorías que se dispararon), sé MÁS estricto que de costumbre. El "ya venís arriba" es argumento de peso.\n' +
    '• El bloque "POR CATEGORÍA — ACTUAL vs ESPERADO" es la fuente de verdad para juzgar una categoría. NO mires solo el monto absoluto: $50.000 en Comida puede ser mucho o poco según el promedio. Usá el porcentaje "vs lo esperado" y el "esperado a esta altura" — ese ya viene prorrateado al día del mes en que estamos.\n' +
    '• La "Proyección si seguís a este ritmo" vs "Si volvés al ritmo promedio" son DOS escenarios distintos. Usalos para contestar "¿qué pasa si sigo así?" vs "¿qué pasa si me normalizo?". No los confundas con el saldo libre actual.\n' +
    '• La trayectoria vs mismo día del mes anterior es comparación directa: si llevás menos gastado que en el mismo día del mes pasado, eso es una señal concreta, mencionala cuando corresponda.\n\n' +

    'PROYECCIONES Y ESCENARIOS HIPOTÉTICOS (importante):\n' +
    '• Cuando Huevo plantea un escenario hipotético — "si solo gasto X", "si no gasto nada esta semana", "si gasto X cada día", "si me toca una salida más", "si llega un ingreso extra de Y" — TENÉS QUE HACER LA MATEMÁTICA, no contestar en abstracto. Tirar la cuenta es la respuesta principal.\n' +
    '• Fórmula básica de proyección de fin de mes: Saldo libre actual − gastos hipotéticos del período = saldo proyectado. Si el período no llega hasta fin de mes, sumá también el ritmo promedio para los días restantes después del escenario.\n' +
    '• Mostrá la cuenta explícita aunque sea brevemente: "$681.900 − $32.000 = $649.900 si no gastás más esta semana. Hasta fin de mes te quedan 16 días después, a tu ritmo de $25k/día son ~$400k, te queda ~$250k libre, te alcanza tranquilo".\n' +
    '• Si el escenario propuesto está fuera de lo razonable (ej. "y si no gasto nada el resto del mes"), proyectalo igual sin comentar lo improbable. Es ejercicio mental, no realismo.\n' +
    '• Compará el saldo proyectado contra: (a) el aporte mensual necesario para la meta del Viaje, (b) los gastos fijos pendientes (cuotas, suscripciones), (c) un margen de seguridad razonable. Esa comparación es la que te permite decir "vas bien" / "te quedás corto".\n' +
    '• Para proyecciones, podés extenderte hasta 6 oraciones si la cuenta lo requiere. La regla de 4 oraciones se aplica a opinión pura, no a cálculos.\n\n' +

    'RAZONAMIENTO PROFUNDO (esto es lo que te diferencia de un calculador de stats):\n' +
    '• ANTES de responder, pensá en silencio 2-3 ángulos distintos del problema. No los listés en la respuesta — usalos para llegar a una conclusión más rica. La respuesta sale corta y filosa porque atrás tiene profundidad.\n' +
    '• Costo de oportunidad: si Huevo gasta $X, ¿qué OTRA cosa que valora podría hacer con esa plata? A veces la objeción no es por el gasto en sí sino por aquello que renuncia.\n' +
    '• Efectos de segundo orden: pensá si la decisión es aislada o si arranca/refuerza un patrón.\n' +
    '• Pattern matching del historial: revisá si hay un patrón en el comportamiento que le esté pasando inadvertido.\n' +
    '• Cuestioná la premisa con respeto cuando hace falta.\n' +
    '• Ofrecé alternativas no obvias cuando puedan mejorar la decisión.\n' +
    '• Tiempo del mes importa: $30k el día 2 y $30k el día 28 no son lo mismo.\n' +
    '• Valor emocional / sanidad mental: a veces un gasto "caro" es barato en bienestar.\n' +
    '• Pensá en el "Huevo de dentro de 3-6 meses": ¿qué va a agradecer / reprochar de esta decisión?\n' +
    '• Cuando la respuesta obvia parece "sí" o "no", buscá la opción MENOS obvia que también sea válida.\n\n' +

    'Sobre detección de decisiones (importante para el sistema):\n' +
    '• Si Huevo te indica que NO va a hacer un gasto que estaba evaluando (frases como "no lo hago", "lo paso", "fue", "lo dejo", "mejor no", "pasá"), terminá tu respuesta con un bloque oculto:\n' +
    '[[META]]\n' +
    '{"decision":"rechazo","monto":<número entero sin puntos>,"descripcion":"<descripción corta>","categoria":"<categoría>"}\n' +
    '[[/META]]\n' +
    '• Si confirma que SÍ lo hace ("dale", "lo compro", "sí lo gasto"), no es necesario marcar nada.\n' +
    '• Si no hubo decisión clara o la conversación es exploratoria, no incluyas el bloque [[META]].\n' +
    '• El bloque [[META]] es invisible para el usuario — no comentés sobre él en tu texto.\n\n' +

    'CONTEXTO FINANCIERO ACTUAL:\n' + contextoFinanciero;

  const personalidad = _PERSONALIDADES[persona] || _PERSONALIDADES.asesor;
  const systemPrompt = 'PERSONALIDAD ACTIVA:\n' + personalidad + '\n\n' + reglas;

  // Construir el array de "contents" con historial + pregunta actual
  const contents = [];
  if (Array.isArray(history)) {
    for (const msg of history) {
      if (!msg || !msg.role || !msg.text) continue;
      const role = (msg.role === 'model' || msg.role === 'assistant') ? 'model' : 'user';
      contents.push({ role: role, parts: [{ text: String(msg.text) }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: cleanQuestion }] });

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 3000,
      thinkingConfig: { thinkingBudget: -1 }
    }
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code !== 200) {
      return 'Gemini devolvió error HTTP ' + code + '. Detalle: ' + text.substring(0, 200);
    }
    const json = JSON.parse(text);
    if (!json.candidates || !json.candidates[0] || !json.candidates[0].content) {
      return 'Gemini no devolvió una respuesta válida. Probá reformular la pregunta.';
    }
    const parts = json.candidates[0].content.parts || [];
    let respuestaCruda = parts.map(p => p.text || '').join('').trim() || 'Respuesta vacía.';
    if (json.candidates[0].finishReason === 'MAX_TOKENS') {
      respuestaCruda += '\n\n(respuesta cortada por longitud — preguntame algo más específico para profundizar)';
    }

    const procesado = _extraerMeta(respuestaCruda);
    if (procesado.meta) {
      try { _guardarDecision(procesado.meta); } catch (e) { /* no bloquear respuesta si falla */ }
    }
    return procesado.textoLimpio;
  } catch (err) {
    return 'Error al consultar Gemini: ' + err.message;
  }
}

function _calcularIngresoMensualPromedio(data) {
  const meses = data.meses || [];
  if (!meses.length) return 0;
  const conIngresos = meses.filter(m => m.ingreso > 0);
  if (!conIngresos.length) return 0;
  const total = conIngresos.reduce((s, m) => s + m.ingreso, 0);
  return Math.round(total / conIngresos.length);
}

function _construirContextoTarjeta(data) {
  const ciclos = data.ciclos || [];
  const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-AR');
  const NOMBRES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const mesLabel = (mesNum, año) => NOMBRES[mesNum] + ' ' + año;
  const hoy = new Date();
  const curKey = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');

  let cicloInfo;
  if (!ciclos.length) {
    cicloInfo = 'Ciclos: ninguno cargado todavía (Huevo no cargó cierres en la app).';
  } else {
    const ult = ciclos[ciclos.length - 1];
    const cierre = new Date(ult.cierre);
    const venc = new Date(ult.vencimiento);
    const diasAlCierre = Math.ceil((cierre.getTime() - hoy.getTime()) / (1000 * 60 * 60 * 24));
    if (diasAlCierre > 0) {
      cicloInfo = 'Ciclo en curso: cierra el ' + cierre.getDate() + '/' + (cierre.getMonth() + 1) +
        ' (en ' + diasAlCierre + ' días) · vence ' + venc.getDate() + '/' + (venc.getMonth() + 1) + '.';
    } else {
      cicloInfo = 'Último ciclo cargado: cierre ' + cierre.getDate() + '/' + (cierre.getMonth() + 1) +
        ' (hace ' + Math.abs(diasAlCierre) + ' días) · vence ' + venc.getDate() + '/' + (venc.getMonth() + 1) +
        '. El siguiente cierre todavía no fue cargado (Huevo lo carga cuando el banco se lo confirma).';
    }
  }

  // Resúmenes futuros con desglose
  const futuros = [];
  (data.meses || []).forEach(m => {
    if (m.key <= curKey) return;
    let compras = 0, cuotas = 0, fijos = 0;
    (m.gastos || []).forEach(g => {
      if (g.cuenta !== 'Tarjeta de crédito') return;
      if (g.esCuota) cuotas += g.monto;
      else if (g.esFijo) fijos += g.monto;
      else compras += g.monto;
    });
    const total = compras + cuotas + fijos;
    if (total > 0) futuros.push({ key: m.key, año: m.año, mesNum: m.mesNum, compras, cuotas, fijos, total });
  });
  futuros.sort((a, b) => a.key < b.key ? -1 : 1);

  let resumenes;
  if (!futuros.length) {
    resumenes = 'Próximos resúmenes: sin consumo de tarjeta proyectado por ahora.';
  } else {
    const p = futuros[0];
    const desg = [];
    if (p.compras > 0) desg.push('compras del ciclo ' + fmt(p.compras));
    if (p.cuotas > 0) desg.push('cuotas ' + fmt(p.cuotas));
    if (p.fijos > 0) desg.push('fijos ' + fmt(p.fijos));
    resumenes = 'Próximo resumen a pagar (' + mesLabel(p.mesNum, p.año) + '): ' + fmt(p.total) +
      ' (' + desg.join(' + ') + ').';
    if (futuros.length > 1) {
      const sigs = futuros.slice(1, 4).map(f => mesLabel(f.mesNum, f.año) + ' ' + fmt(f.total));
      resumenes += '\nResúmenes siguientes: ' + sigs.join(' · ') + '.';
    }
  }

  // Cuotas con timing detallado
  let cuotasInfo = '';
  if (data.cuotas && data.cuotas.length) {
    const lineas = data.cuotas.map(c => {
      const monthly = c.montoTotal / c.nCuotas;
      let t = '';
      if (c.inicio) {
        const ini = new Date(c.inicio);
        const diff = (hoy.getFullYear() - ini.getFullYear()) * 12 + (hoy.getMonth() - ini.getMonth());
        const restantes = Math.max(0, c.nCuotas - Math.max(0, diff));
        const fin = new Date(ini.getFullYear(), ini.getMonth() + c.nCuotas - 1, 1);
        t = ' · 1ª en ' + NOMBRES[ini.getMonth()] + ' ' + ini.getFullYear() +
            ', última en ' + NOMBRES[fin.getMonth()] + ' ' + fin.getFullYear() +
            ' · quedan ' + restantes + '/' + c.nCuotas;
      }
      return '  • ' + c.desc + ': ' + fmt(monthly) + '/mes' + t;
    }).join('\n');
    cuotasInfo = '\nCuotas activas:\n' + lineas;
  }

  return 'Tarjeta de crédito:\n' + cicloInfo + '\n' + resumenes + cuotasInfo;
}

// Construye el bloque comparativo: ritmo del mes vs promedio histórico,
// proyección de fin de mes, por categoría con delta vs esperado a esta altura,
// y trayectoria contra el mismo día del mes anterior. Esto es lo que le permite
// a Gemini decir cosas como "venís 30% más austero, eso da margen para...".
function _construirRitmoMes(meses, m, dayOfMonth, daysInMonth, isCurrent) {
  const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-AR');
  // Histórico = meses cerrados (todos menos el actual) con gasto > 0
  const hist = meses.slice(isCurrent ? 1 : 0).filter(x => x.totalGastos > 0);
  if (!hist.length) {
    return 'RITMO DEL MES: (todavía no hay meses históricos cerrados para comparar)';
  }
  if (!isCurrent || dayOfMonth === 0) {
    // Para meses pasados no tiene sentido proyectar; devolvemos un bloque mínimo.
    return '';
  }

  // ─── Promedios por mes histórico ──────────────────────────────
  const dailyHist = hist.reduce((s, x) => {
    const dpm = new Date(x.año, x.mesNum + 1, 0).getDate();
    return s + (x.totalGastos / dpm);
  }, 0) / hist.length;
  const totalPromedioMes = hist.reduce((s, x) => s + x.totalGastos, 0) / hist.length;
  const diasGastoHist = hist.reduce((s, x) => s + (x.diasConGasto || 0), 0) / hist.length;

  // ─── Métricas del mes en curso ────────────────────────────────
  const dailyActual = m.totalGastos / dayOfMonth;
  const projAlRitmoActual = dailyActual * daysInMonth;
  const projVolviendoAlPromedio = m.totalGastos + dailyHist * (daysInMonth - dayOfMonth);
  const diasGastoEsperado = diasGastoHist * (dayOfMonth / 30);

  // Helper de porcentaje firmado
  const pctSigned = (a, b) => {
    if (!b || b <= 0) return null;
    const p = Math.round((a / b - 1) * 100);
    return (p >= 0 ? '+' : '') + p + '%';
  };
  const dailyDeltaTxt = pctSigned(dailyActual, dailyHist);
  const projDeltaTxt = pctSigned(projAlRitmoActual, totalPromedioMes);

  // ─── Por categoría: actual vs esperado a esta altura ──────────
  const catTotales = {}, catMeses = {};
  for (const mes of hist) {
    for (const [cat, val] of Object.entries(mes.cats || {})) {
      if (cat === 'Ahorro' || val <= 0) continue;
      catTotales[cat] = (catTotales[cat] || 0) + val;
      catMeses[cat] = (catMeses[cat] || 0) + 1;
    }
  }
  const catPromedios = {};
  for (const [cat, total] of Object.entries(catTotales)) {
    catPromedios[cat] = total / catMeses[cat];
  }
  const catSet = new Set([...Object.keys(m.cats || {}), ...Object.keys(catPromedios)]);
  catSet.delete('Ahorro');

  const proporcion = dayOfMonth / daysInMonth;
  const catRows = [];
  for (const cat of catSet) {
    const actual = (m.cats && m.cats[cat]) || 0;
    const prom = catPromedios[cat] || 0;
    if (actual === 0 && prom === 0) continue;
    const esperado = prom * proporcion;
    let pctDelta = null, deltaTxt;
    if (esperado >= 100) { // umbral mínimo para evitar % delirantes
      pctDelta = Math.round((actual / esperado - 1) * 100);
      deltaTxt = (pctDelta >= 0 ? '+' : '') + pctDelta + '% vs lo esperado';
    } else if (actual > 0 && prom === 0) {
      deltaTxt = 'categoría nueva este mes';
      pctDelta = 999;
    } else if (actual === 0 && prom > 0) {
      deltaTxt = 'todavía $0 (normalmente gastás algo a esta altura)';
      pctDelta = -100;
    } else {
      deltaTxt = 'sin comparación clara';
    }
    catRows.push({ cat, actual, prom, esperado, pctDelta, deltaTxt });
  }
  // Ordenar por anomalía: las más fuera de norma primero
  catRows.sort((a, b) => Math.abs(b.pctDelta || 0) - Math.abs(a.pctDelta || 0));

  const catLines = catRows.map(r =>
    '  • ' + r.cat + ': ' + fmt(r.actual) +
    ' (esperado a esta altura: ' + fmt(r.esperado) +
    ' · promedio mes completo: ' + fmt(r.prom) +
    ' · ' + r.deltaTxt + ')'
  ).join('\n');

  // ─── Trayectoria vs mismo día del mes anterior ────────────────
  let trayec = '';
  if (meses.length >= 2) {
    const prev = meses[1];
    const cutoff = dayOfMonth;
    const sameDayPrev = (prev.gastos || []).reduce((s, g) => {
      const fg = new Date(g.fecha);
      if (fg.getFullYear() === prev.año && fg.getMonth() === prev.mesNum && fg.getDate() <= cutoff) {
        return s + (g.monto || 0);
      }
      return s;
    }, 0);
    if (sameDayPrev > 0) {
      const NOMBRES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const dTxt = pctSigned(m.totalGastos, sameDayPrev);
      trayec = '• Al día ' + cutoff + ' de ' + NOMBRES[prev.mesNum] + ' llevabas gastado: ' +
        fmt(sameDayPrev) + ' (hoy: ' + fmt(m.totalGastos) +
        (dTxt ? ' · ' + dTxt + ')' : ')');
    }
  }

  return 'RITMO DEL MES vs TU PROMEDIO HISTÓRICO:\n' +
    '• Gasto por día actual: ' + fmt(dailyActual) +
      ' · promedio histórico: ' + fmt(dailyHist) +
      (dailyDeltaTxt ? ' (' + dailyDeltaTxt + ' vs promedio)' : '') + '\n' +
    '• Si seguís a este ritmo, terminás el mes con: ' + fmt(projAlRitmoActual) +
      ' (vs tu promedio mensual de ' + fmt(totalPromedioMes) +
      (projDeltaTxt ? ' → ' + projDeltaTxt : '') + ')\n' +
    '• Si volvés al ritmo promedio el resto del mes: ' + fmt(projVolviendoAlPromedio) + '\n' +
    '• Días con gasto cargados este mes: ' + (m.diasConGasto || 0) +
      ' (esperado a esta altura: ' + Math.round(diasGastoEsperado) +
      ', promedio mes completo: ' + Math.round(diasGastoHist) + ')' +
    (trayec ? '\n' + trayec : '') + '\n\n' +
    'POR CATEGORÍA — ACTUAL vs ESPERADO a esta altura del mes (ordenadas por anomalía):\n' +
    (catLines || '  (sin datos)');
}

// Bloque de TRAYECTORIA: lo que más le falta a Flash para tener criterio.
// Todo pre-calculado en el servidor (Flash es malo haciendo cuentas, bueno
// usando conclusiones). Le da tendencia mes a mes, tasa de ahorro real y
// cuántos meses de colchón tiene — el marco para juzgar capacidad de gasto.
function _construirTendenciaYSalud(meses, mActual, dayOfMonth, daysInMonth) {
  const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-AR');
  const NOMBRES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const idx = meses.findIndex(x => x.key === mActual.key);
  const previos = (idx >= 0 ? meses.slice(idx + 1) : meses).filter(x => x.totalGastos > 0 || x.ingreso > 0);
  if (!previos.length) {
    return 'TRAYECTORIA Y SALUD FINANCIERA: todavía no hay meses cerrados para analizar tendencia.';
  }
  // Hasta 4 meses cerrados más recientes, en orden cronológico (viejo → nuevo).
  const recientes = previos.slice(0, 4).reverse();

  // 1) Tendencia de gasto mes a mes
  const serieGasto = recientes.map(x => NOMBRES[x.mesNum] + ' ' + fmt(x.totalGastos)).join(' · ');
  let tendTxt = '';
  if (recientes.length >= 2) {
    const ultimo = recientes[recientes.length - 1].totalGastos;
    const prevs = recientes.slice(0, -1);
    const promPrev = prevs.reduce((s, x) => s + x.totalGastos, 0) / prevs.length;
    if (promPrev > 0) {
      const pct = Math.round((ultimo / promPrev - 1) * 100);
      const dir = pct > 8 ? 'SUBIENDO' : pct < -8 ? 'BAJANDO' : 'estable';
      tendTxt = ' → tendencia ' + dir + ' (' + (pct >= 0 ? '+' : '') + pct + '% el último mes cerrado vs promedio de los previos)';
    }
  }
  // Proyección del mes en curso a fin de mes
  const projActual = dayOfMonth > 0 ? Math.round(mActual.totalGastos / dayOfMonth * daysInMonth) : mActual.totalGastos;

  // 2) Tasa de ahorro real (y cuánto queda libre) sobre meses con ingreso
  const conIngreso = previos.filter(x => x.ingreso > 0);
  let ahorroTxt = 'sin ingresos cerrados para calcular tasa de ahorro.';
  if (conIngreso.length) {
    const tasaAhorro = conIngreso.reduce((s, x) => s + (x.totalAhorro / x.ingreso), 0) / conIngreso.length;
    const tasaLibre = conIngreso.reduce((s, x) => s + (x.saldo / x.ingreso), 0) / conIngreso.length;
    ahorroTxt = 'ahorrás en promedio el ' + Math.round(tasaAhorro * 100) + '% de tu ingreso; te queda libre (después de gastos, sin contar ahorro) el ' + Math.round(tasaLibre * 100) + '%.';
  }

  // 3) Colchón: cuántos meses de gasto cubre el sobrante arrastrado
  const gastoProm = previos.reduce((s, x) => s + x.totalGastos, 0) / previos.length;
  const buffer = mActual.sobranteEntrante || 0;
  let colchonTxt = '';
  if (gastoProm > 0) {
    const mesesColchon = buffer / gastoProm;
    const clasif = mesesColchon >= 2 ? 'colchón SANO' : mesesColchon >= 0.75 ? 'colchón JUSTO' : mesesColchon > 0 ? 'colchón AL LÍMITE' : 'SIN colchón (vivís mes a mes)';
    colchonTxt = 'el sobrante arrastrado (' + fmt(buffer) + ') cubre ~' + mesesColchon.toFixed(1) + ' meses de gasto promedio (' + fmt(gastoProm) + '/mes) → ' + clasif + '.';
  }

  return 'TRAYECTORIA Y SALUD FINANCIERA (ya calculado — es tu marco para juzgar capacidad de gasto, no recalcules):\n' +
    '• Gasto de meses cerrados: ' + serieGasto + tendTxt + '\n' +
    '• Mes en curso proyectado a fin de mes: ' + fmt(projActual) + ' (llevás ' + fmt(mActual.totalGastos) + ' al día ' + dayOfMonth + ' de ' + daysInMonth + ').\n' +
    '• Tasa de ahorro: ' + ahorroTxt + '\n' +
    (colchonTxt ? '• Colchón: ' + colchonTxt : '');
}

function _construirContextoFinanciero(data, ingresoPromedio, rechazosRecientes) {
  const meses = data.meses || [];
  if (!meses.length) return 'No hay gastos cargados todavía.';

  const NOMBRES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const today = new Date();
  const todayKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
  // meses[0] puede ser un mes FUTURO por proyecciones de cuotas — buscar el mes real de hoy
  const m = meses.find(mes => mes.key === todayKey)
          || meses.find(mes => mes.key < todayKey)
          || meses[0];
  const monthName = NOMBRES[m.mesNum];
  const daysInMonth = new Date(m.año, m.mesNum + 1, 0).getDate();
  const isCurrent = m.key === todayKey;
  const dayOfMonth = isCurrent ? today.getDate() : daysInMonth;
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);
  const sobranteEntrante = m.sobranteEntrante || 0;
  // El saldo del mes YA incluye el sobrante arrastrado del mes anterior.
  const ingresoTotalMes = m.ingreso + sobranteEntrante;
  const dailyFromSaldo = daysRemaining > 0 ? Math.round(m.saldo / daysRemaining) : 0;

  const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-AR');

  // Bloque comparativo: ritmo vs promedio histórico + por categoría con delta.
  // Pasamos solo desde el mes actual hacia atrás; los meses futuros (proyecciones
  // de cuotas) no deben entrar en el historial de comparación.
  const mIdx = meses.findIndex(mes => mes.key === m.key);
  const mesesToRitmo = mIdx >= 0 ? meses.slice(mIdx) : meses;
  const ritmoBloque = _construirRitmoMes(mesesToRitmo, m, dayOfMonth, daysInMonth, isCurrent);

  // Trayectoria histórica (tendencia, tasa de ahorro, colchón) — el marco de criterio.
  const tendenciaBloque = _construirTendenciaYSalud(meses, m, dayOfMonth, daysInMonth);

  // ── Transacciones individuales del mes (gastos concretos, no cuotas ni fijos) ──
  const txNoTC = (m.gastos || []).filter(g => !g.esCuota && !g.esFijo && !g.esTarjeta && g.monto > 0)
    .sort((a, b) => b.fecha - a.fecha);
  const txTC = (m.gastos || []).filter(g => !g.esCuota && !g.esFijo && g.esTarjeta && g.monto > 0)
    .sort((a, b) => b.fecha - a.fecha);
  let transaccionesTexto = '';
  if (txNoTC.length) {
    const lines = txNoTC.map(g => {
      const d = new Date(g.fecha);
      return '  • ' + d.getDate() + '/' + (d.getMonth()+1) + ' · ' + g.desc + ' [' + g.cat + ']: ' + fmt(g.monto);
    }).join('\n');
    transaccionesTexto = 'Gastos individuales del mes (' + txNoTC.length + '):\n' + lines;
  } else {
    transaccionesTexto = 'Gastos individuales del mes: ninguno cargado aún.';
  }
  if (txTC.length) {
    const lines = txTC.map(g => {
      const d = new Date(g.fecha);
      return '  • ' + d.getDate() + '/' + (d.getMonth()+1) + ' · ' + g.desc + ' [' + g.cat + ']: ' + fmt(g.monto) + ' (referencia TC)';
    }).join('\n');
    transaccionesTexto += '\nCompras con tarjeta del ciclo en curso (' + txTC.length + ', son referencia — no restan del saldo):\n' + lines;
  }

  // ── Gastos fijos activos no-TC (compromisos recurrentes que sí restan del saldo) ──
  let fijosTexto = 'Gastos fijos mensuales (no tarjeta): ninguno cargado.';
  const fijosNoTC = (data.gastosFijosActivos || []).filter(f => !f.esTarjeta && f.monto > 0);
  if (fijosNoTC.length) {
    const totalFijosNoTC = fijosNoTC.reduce((s, f) => s + f.monto, 0);
    const fLines = fijosNoTC.map(f => '  • ' + f.desc + ' [' + f.cat + ']: ' + fmt(f.monto) + '/mes').join('\n');
    fijosTexto = 'Gastos fijos mensuales no-tarjeta (compromisos recurrentes que SÍ restan del saldo · total: ' + fmt(totalFijosNoTC) + '):\n' + fLines;
  }

  let metas = 'Sin metas activas.';
  if (data.metas && data.metas.length) {
    metas = data.metas.map(meta => {
      const pct = meta.objetivo > 0 ? Math.round(meta.acumulado / meta.objetivo * 100) : 0;
      const falta = Math.max(0, meta.objetivo - meta.acumulado);
      let d = '';
      let ritmo = '';
      if (meta.limite) {
        const dias = Math.ceil((meta.limite - Date.now()) / (1000*60*60*24));
        d = ' (' + dias + ' días para la fecha objetivo)';
        if (dias > 0 && falta > 0) {
          const mesesRest = Math.max(1, Math.round(dias / 30));
          ritmo = ' — para llegar tenés que aportar ' + fmt(Math.round(falta / mesesRest)) + '/mes';
        }
      }
      return '  • ' + meta.nombre + ': ' + fmt(meta.acumulado) + ' de ' + fmt(meta.objetivo) + ' (' + pct + '%)' + d + ritmo;
    }).join('\n');
  }

  let cuotas = 'Ninguna cuota activa.';
  if (data.cuotas && data.cuotas.length) {
    cuotas = data.cuotas.map(c => {
      const monthly = c.montoTotal / c.nCuotas;
      return '  • ' + c.desc + ': ' + fmt(monthly) + '/mes en ' + c.nCuotas + ' cuotas';
    }).join('\n');
  }

  let rechazosTexto = 'Ninguno registrado en los últimos 30 días.';
  if (rechazosRecientes && rechazosRecientes.count > 0) {
    const items = rechazosRecientes.items.slice(-5).map(r =>
      '  • ' + (r.desc || 'sin descripción') + ': ' + fmt(r.monto) + ' (' + (r.categoria || 'Otro') + ')'
    ).join('\n');
    rechazosTexto = 'Total rechazado: ' + fmt(rechazosRecientes.total) + ' en ' + rechazosRecientes.count + ' decisiones.\nÚltimos:\n' + items;
  }

  const ingresoTxt = ingresoPromedio > 0 ? fmt(ingresoPromedio) : '(sin datos)';

  return 'Mes en curso: ' + monthName + ' ' + m.año + ' (día ' + dayOfMonth + ' de ' + daysInMonth + ', faltan ' + daysRemaining + ' días)\n' +
    'Ingreso real del mes (sueldo y otros del mes): ' + fmt(m.ingreso) + '\n' +
    'Sobrante arrastrado del mes anterior (ya sumado como ingreso este mes): ' + fmt(sobranteEntrante) + '\n' +
    'Ingreso total del mes (real + sobrante arrastrado): ' + fmt(ingresoTotalMes) + '\n' +
    'Ingreso real promedio mensual (de meses cargados, sin contar sobrantes): ' + ingresoTxt + '\n' +
    'Gastos acumulados del mes: ' + fmt(m.totalGastos) + '\n' +
    'Ahorro del mes: ' + fmt(m.totalAhorro) + '\n' +
    'SALDO DISPONIBLE del mes (ingreso total − gastos − ahorro; ya incluye el sobrante arrastrado): ' + fmt(m.saldo) + '\n' +
    'Disponible por día con lo que queda de saldo: ' + fmt(dailyFromSaldo) + '\n\n' +
    tendenciaBloque + '\n\n' +
    ritmoBloque + '\n\n' +
    transaccionesTexto + '\n\n' +
    fijosTexto + '\n\n' +
    'Metas de ahorro:\n' + metas + '\n\n' +
    'Cuotas vigentes:\n' + cuotas + '\n\n' +
    _construirContextoTarjeta(data) + '\n\n' +
    'Gastos rechazados recientes (últimos 30 días — decisiones de NO gastar que Huevo tomó conmigo):\n' + rechazosTexto;
}

// Función llamada desde Index.html vía google.script.run
// Devuelve todos los datos que necesita el dashboard para renderizar.
// Aplica las mismas reglas que actualizarResumen() pero sin escribir
// nada en el Sheet (es solo lectura).
function getDashboardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shGastos   = ss.getSheetByName("Respuestas de formulario 1");
  const shIngresos = ss.getSheetByName("Respuestas de formulario 2");
  const shCuotas   = ss.getSheetByName("Cuotas");
  const shMetas    = ss.getSheetByName("Metas");
  const shFijos    = ss.getSheetByName("Gastos Fijos");
  const shCiclos   = ss.getSheetByName("Ciclos TC");

  // CACHÉ: la clave depende de la cantidad de filas y de DATA_VERSION (que se
  // incrementa al editar/borrar). Cualquier mutación invalida la caché sola.
  const cache = CacheService.getScriptCache();
  let _dataVer = '0';
  try { _dataVer = PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || '0'; } catch (e) {}
  const cacheKey = 'dash_v8_' + _dataVer + '_' +
    (shGastos   ? shGastos.getLastRow()   : 0) + '_' +
    (shIngresos ? shIngresos.getLastRow() : 0) + '_' +
    (shCuotas   ? shCuotas.getLastRow()   : 0) + '_' +
    (shMetas    ? shMetas.getLastRow()    : 0) + '_' +
    (shFijos    ? shFijos.getLastRow()    : 0) + '_' +
    (shCiclos   ? shCiclos.getLastRow()   : 0);

  const cached = _cacheGetLarge(cache, cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached);
      obj.actualizado = new Date().getTime();
      return obj;
    } catch (e) { /* caché dañada → recalcular */ }
  }

  const datosGastos = shGastos.getDataRange().getValues().slice(1);
  const datosIngresos = shIngresos.getDataRange().getValues().slice(1);
  const cuotas = _leerCuotas(ss);
  const gastosFijos = _leerGastosFijos(ss);
  const metasRaw = _leerMetas(ss);
  const ciclos = _leerCiclos(ss);
  const ajustesSaldo = _leerAjustesSaldo(ss); // { 'YYYY-MM': sobranteArranque }

  const porMes = {}, ingresosPorMes = {};

  for (let _gi = 0; _gi < datosGastos.length; _gi++) {
    const fila = datosGastos[_gi];
    const filaSheet = _gi + 2; // +2: el slice(1) saltó el header y el Sheet es 1-based
    const fecha = new Date(fila[1]);
    if (isNaN(fecha.getTime())) continue;
    const cat = fila[2], monto = parseFloat(fila[4]);
    const desc = (fila[3] || "").toString().trim();
    const cuenta = fila[5] || "Sin especificar";
    if (!cat || isNaN(monto)) continue;

    // Mes de imputación: por defecto el de la compra. Si es compra con
    // tarjeta posterior al corte, se imputa al mes del vencimiento del ciclo.
    let imputa = fecha;
    const esTarjeta = (cuenta === "Tarjeta de crédito");
    let reasignado = false;
    if (esTarjeta && fecha.getTime() >= CORTE_TARJETA) {
      const vencMs = _vencimientoParaFecha(ciclos, fecha.getTime());
      if (vencMs) { imputa = new Date(vencMs); reasignado = true; }
    }
    const k = imputa.getFullYear() + "-" + String(imputa.getMonth() + 1).padStart(2, '0');

    if (!porMes[k]) porMes[k] = {
      año: imputa.getFullYear(), mesNum: imputa.getMonth(),
      gastos: [], cats: {}, cuentas: {}, dias: {}
    };
    const info = porMes[k];
    info.gastos.push({ fecha: fecha.getTime(), desc, cat, monto, cuenta, esTarjeta, reasignado, row: filaSheet });
    // Las compras con cuenta TC son REFERENCIA: aparecen en el listado y en la
    // card de tarjeta, pero NO reducen el saldo ni entran en las categorías.
    // El gasto real es el pago del resumen, que sí se registra como gasto normal.
    if (esTarjeta) {
      info.tcMonto = (info.tcMonto || 0) + monto;
    } else {
      info.cats[cat] = (info.cats[cat] || 0) + monto;
      if (cat !== "Ahorro") info.cuentas[cuenta] = (info.cuentas[cuenta] || 0) + monto;
    }
    // Una compra reasignada al vencimiento no cuenta como "día con gasto" de ese mes futuro.
    if (!reasignado) info.dias[fecha.toISOString().slice(0, 10)] = true;
  }

  const ingresosDetalle = {};
  for (let _ii = 0; _ii < datosIngresos.length; _ii++) {
    const fila = datosIngresos[_ii];
    const fecha = new Date(fila[1]);
    if (isNaN(fecha.getTime())) continue;
    const k = fecha.getFullYear() + "-" + String(fecha.getMonth() + 1).padStart(2, '0');
    const monto = parseFloat(fila[3]);
    const desc = (fila[2] || "").toString().trim();
    if (isNaN(monto)) continue;
    ingresosPorMes[k] = (ingresosPorMes[k] || 0) + monto;
    if (!ingresosDetalle[k]) ingresosDetalle[k] = [];
    ingresosDetalle[k].push({ fecha: fecha.getTime(), desc, monto, row: _ii + 2 });
  }

  // Asegurar que existan los meses FUTUROS que toca cada cuota, aunque no
  // tengan otros gastos. Así el plan completo de cuotas se ve en la proyección.
  (cuotas || []).forEach(f => {
    const nc = parseInt(f[2]);
    const fs = String(f[3]);
    if (isNaN(nc) || nc < 1) return;
    let fi;
    if (fs.includes('/')) { const p = fs.split('/'); fi = new Date(+p[2], +p[1] - 1, +p[0]); }
    else fi = new Date(fs);
    if (isNaN(fi.getTime())) return;
    for (let i = 0; i < nc; i++) {
      const d = new Date(fi.getFullYear(), fi.getMonth() + i, 1);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!porMes[k]) porMes[k] = { año: d.getFullYear(), mesNum: d.getMonth(), gastos: [], cats: {}, cuentas: {}, dias: {} };
    }
  });

  // Gastos fijos: SOLO los de tarjeta y SOLO en meses futuros (van al resumen
  // del ciclo). Los fijos que no son de tarjeta no se cuentan (solo afectan
  // liquidez y no tienen momento de pago exacto).
  const _hoyFij = new Date();
  const curKeyFij = _hoyFij.getFullYear() + '-' + String(_hoyFij.getMonth() + 1).padStart(2, '0');
  const fijosTarjeta = (gastosFijos || []).filter(f => String(f[3] || '').trim() === 'Tarjeta de crédito' && parseFloat(f[1]) > 0);
  if (fijosTarjeta.length) {
    for (let i = 1; i <= 4; i++) {
      const d = new Date(_hoyFij.getFullYear(), _hoyFij.getMonth() + i, 1);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!porMes[k]) porMes[k] = { año: d.getFullYear(), mesNum: d.getMonth(), gastos: [], cats: {}, cuentas: {}, dias: {} };
    }
  }

  const meses = Object.keys(porMes);
  for (const k of meses) {
    const info = porMes[k];
    const cuotasMes = _getCuotasMes(cuotas, info.año, info.mesNum);
    const fijosMes = (k > curKeyFij) ? fijosTarjeta.map(f => ({
      desc: (f[0] || '') + ' [Fijo]', monto: parseFloat(f[1]), cat: f[2] || 'Otro', cuenta: 'Tarjeta de crédito', esFijo: true
    })) : [];
    for (const item of [...cuotasMes, ...fijosMes]) {
      if (!item.monto || item.monto <= 0) continue;
      info.gastos.push({
        fecha: new Date(info.año, info.mesNum, 15).getTime(),
        desc: item.desc, cat: item.cat, monto: item.monto,
        cuenta: item.cuenta, esCuota: !!item.esCuota, esFijo: !!item.esFijo
      });
      // Cuotas y fijos de tarjeta: también son referencia, no reducen saldo.
      if (item.cuenta === 'Tarjeta de crédito') {
        info.tcMonto = (info.tcMonto || 0) + item.monto;
      } else {
        info.cats[item.cat] = (info.cats[item.cat] || 0) + item.monto;
        if (item.cat !== "Ahorro") info.cuentas[item.cuenta] = (info.cuentas[item.cuenta] || 0) + item.monto;
      }
    }
  }

  for (const k of meses) {
    const info = porMes[k];
    const fechaPrev = new Date(info.año, info.mesNum - 1, 1);
    const cuotasPrev = _getCuotasMes(cuotas, fechaPrev.getFullYear(), fechaPrev.getMonth());
    const totalCuotasPrev = cuotasPrev.reduce((s, c) => s + c.monto, 0);
    if (totalCuotasPrev <= 0) continue;
    const gastosTC = info.gastos.filter(g => g.cat === CATEGORIA_TARJETA && !g.esCuota && !g.esFijo);
    const totalTC = gastosTC.reduce((s, g) => s + g.monto, 0);
    if (totalTC <= 0) continue;
    const ajusteTotal = Math.min(totalCuotasPrev, totalTC);
    info.ajusteTC = ajusteTotal;
    info.tcOriginal = totalTC;
    for (const g of gastosTC) {
      const proporcion = g.monto / totalTC;
      const ajuste = Math.round(ajusteTotal * proporcion);
      g.montoOriginal = g.monto;
      g.ajuste = ajuste;
      g.monto = Math.max(0, g.monto - ajuste);
    }
    info.cats = {}; info.cuentas = {}; info.tcMonto = 0;
    for (const g of info.gastos) {
      if (g.cuenta === 'Tarjeta de crédito' || g.esTarjeta) {
        info.tcMonto += (g.monto || 0);
      } else {
        info.cats[g.cat] = (info.cats[g.cat] || 0) + g.monto;
        if (g.cat !== "Ahorro") info.cuentas[g.cuenta] = (info.cuentas[g.cuenta] || 0) + g.monto;
      }
    }
  }

  const mesesData = meses.sort().reverse().map(k => {
    const info = porMes[k];
    const totalGastos = Object.entries(info.cats)
      .filter(([c]) => c !== "Ahorro")
      .reduce((s, [, v]) => s + v, 0);
    const totalAhorro = info.cats["Ahorro"] || 0;
    const ingreso = ingresosPorMes[k] || 0;
    return {
      key: k, año: info.año, mesNum: info.mesNum,
      ingreso: ingreso, ingresos: ingresosDetalle[k] || [],
      totalGastos: totalGastos, totalAhorro: totalAhorro,
      // totalTC: suma de compras/cuotas/fijos de tarjeta del mes. Son REFERENCIA:
      // no reducen el saldo. El gasto real es el pago del resumen cuando vence.
      totalTC: info.tcMonto || 0,
      saldo: ingreso - totalGastos - totalAhorro,
      cats: info.cats, cuentas: info.cuentas,
      gastos: info.gastos.filter(g => g.monto > 0),
      diasConGasto: Object.keys(info.dias).length,
      ajusteTC: info.ajusteTC || 0, tcOriginal: info.tcOriginal || 0
    };
  });

  // ── SOBRANTE ARRASTRADO AL MES SIGUIENTE ───────────────────────
  // El sobrante de un mes (lo que quedó sin gastar) se traslada al mes
  // siguiente como un INGRESO visible más ("Sobrante de mayo"), de modo que
  // el saldo del mes nuevo ya lo incluye. Ejemplo: si mayo cierra con $100.000,
  // junio arranca con ese sobrante sumado a su ingreso real.
  // Si un mes cerró en déficit, asumimos que el rojo se cubrió con plata
  // externa al tracking → el sobrante no se vuelve negativo (arranca de 0).
  // Recorremos cronológicamente (más viejo → más reciente); mesesData viene
  // ordenado desc, así que iteramos desde el final.
  const NOMBRES_MES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  let _carry = 0;
  for (let i = mesesData.length - 1; i >= 0; i--) {
    const mes = mesesData[i];
    // Si este mes tiene un ajuste manual, su sobrante de arranque se FIJA a ese
    // valor (corrige el arrastre inflado) en vez de usar el acumulado. Desde
    // acá la cadena sigue normal hacia adelante.
    const tieneAjuste = Object.prototype.hasOwnProperty.call(ajustesSaldo, mes.key);
    mes.sobranteEntrante = tieneAjuste ? ajustesSaldo[mes.key] : _carry;
    mes.ajusteSaldoManual = tieneAjuste;
    // El saldo del mes ahora incluye el sobrante arrastrado del mes anterior.
    const saldoBase = mes.ingreso - mes.totalGastos - mes.totalAhorro;
    mes.saldo = saldoBase + mes.sobranteEntrante;
    _carry = Math.max(0, mes.saldo); // lo que sobra (si sobra) pasa al siguiente
    mes.sobranteSaliente = _carry;
    // Compatibilidad: algunos consumidores viejos usaban bufferEntrante.
    mes.bufferEntrante = mes.sobranteEntrante;
    mes.bufferSaliente = mes.sobranteSaliente;
    // Mostrar el sobrante entrante como una entrada de ingreso real y visible.
    if (mes.sobranteEntrante > 0) {
      const prevIdx = i + 1; // el mes anterior (más viejo) está en i+1 (orden desc)
      const etiquetaPrev = (prevIdx < mesesData.length) ? NOMBRES_MES[mesesData[prevIdx].mesNum] : 'mes anterior';
      // Copia para no mutar el array compartido de ingresosDetalle.
      mes.ingresos = (mes.ingresos || []).slice();
      mes.ingresos.unshift({
        fecha: new Date(mes.año, mes.mesNum, 1).getTime(),
        desc: 'Sobrante de ' + etiquetaPrev,
        monto: mes.sobranteEntrante,
        esSobrante: true
      });
    }
  }

  // Auto-calcular el acumulado de metas sumando TODOS los gastos con categoría
  // "Ahorro" del historial completo. Así cualquier gasto marcado como Ahorro
  // (Cocos, USD, caja, lo que sea) suma automáticamente — sin tocar la hoja.
  // El valor manual de la columna C en la hoja "Metas" queda ignorado y puede
  // borrarse; solo se usa como fallback si aún no hay gastos de Ahorro cargados.
  const totalAhorradoHistorico = mesesData.reduce((s, m) => s + (m.totalAhorro || 0), 0);

  const metas = metasRaw.map(m => {
    let limite = null;
    if (m[3]) {
      const fs = String(m[3]);
      if (fs.includes("/")) { const p = fs.split("/"); limite = new Date(+p[2], +p[1] - 1, +p[0]).getTime(); }
      else { const d = new Date(fs); if (!isNaN(d.getTime())) limite = d.getTime(); }
    }
    // acumulado = suma histórica de gastos "Ahorro". Si no hay nada cargado,
    // cae al valor manual de la hoja como fallback.
    const acumulado = totalAhorradoHistorico > 0
      ? totalAhorradoHistorico
      : (parseFloat(m[2]) || 0);
    return { nombre: m[0], objetivo: parseFloat(m[1]) || 0, acumulado: acumulado, limite: limite, notas: m[4] || "" };
  });

  const cuotasActivas = cuotas.map(c => {
    let inicio = null;
    if (c[3] instanceof Date && !isNaN(c[3].getTime())) { inicio = c[3].getTime(); }
    else if (c[3]) {
      const fs = String(c[3]);
      if (fs.includes("/")) { const p = fs.split("/"); inicio = new Date(+p[2], +p[1] - 1, +p[0]).getTime(); }
      else { const d = new Date(fs); if (!isNaN(d.getTime())) inicio = d.getTime(); }
    }
    return { desc: c[0], montoTotal: parseFloat(c[1]) || 0, nCuotas: parseInt(c[2]) || 0, inicio: inicio, categoria: c[4] || "Otro", cuenta: c[5] || "Tarjeta de crédito" };
  });

  const result = {
    meses: mesesData, metas: metas, cuotas: cuotasActivas,
    ciclos: ciclos,
    presupuesto: PRESUPUESTO_MENSUAL, categorias: CATS,
    // Gastos fijos activos, para que el contexto de Gemini incluya compromisos recurrentes
    gastosFijosActivos: (gastosFijos || [])
      .filter(f => String(f[4] || '').trim().toUpperCase() === 'SI' && parseFloat(f[1]) > 0)
      .map(f => ({
        desc: String(f[0] || ''), monto: parseFloat(f[1]) || 0,
        cat: String(f[2] || 'Otro'), cuenta: String(f[3] || ''),
        esTarjeta: String(f[3] || '').trim() === 'Tarjeta de crédito'
      })),
    actualizado: new Date().getTime()
  };

  // Guardar en caché 5 minutos (se invalida antes si cambian las filas)
  try { _cachePutLarge(cache, cacheKey, JSON.stringify(result), 300); } catch (e) {}

  return result;
}

// ============================================================
// RECORDATORIO DE TARJETA POR TELEGRAM
// ============================================================
// Reusa el bot que ya tenés andando para el sheet Personal. Usa las MISMAS
// Script Properties: TELEGRAM_TOKEN y TELEGRAM_CHAT_ID — copiá los mismos
// valores en las Script Properties de ESTE proyecto (el de Gastos).
//
// SETUP (una sola vez):
//   1) Project Settings → Script Properties → agregá TELEGRAM_TOKEN y
//      TELEGRAM_CHAT_ID (los mismos valores que en el proyecto Personal).
//   2) Ejecutá testTelegramTarjeta() desde el editor → te tiene que llegar
//      un mensaje al Telegram.
//   3) Ejecutá configurarRecordatorioTarjeta() una vez → crea el disparador
//      diario (corre entre las 9 y las 10 de la mañana).
//
// Qué avisa:
//   • 2 días antes del cierre y el día del cierre → "cargá el próximo ciclo".
//   • Si el cierre ya pasó y no cargaste el ciclo siguiente → recordatorio
//     a los 1, 3, 7 y 14 días (sin spamear todos los días).
//   • El día antes y el día del vencimiento → cuánto tenés que pagar.

function _enviarTelegramTC(texto) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TELEGRAM_TOKEN');
  const chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) {
    Logger.log('Falta TELEGRAM_TOKEN o TELEGRAM_CHAT_ID en Script Properties de este proyecto.');
    return false;
  }
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
    muteHttpExceptions: true
  });
  return true;
}

// Mensaje de prueba — ejecutar desde el editor para verificar el bot.
function testTelegramTarjeta() {
  const ok = _enviarTelegramTC('✅ <b>Test OK</b>\nEl recordatorio de tarjeta del sheet de Gastos está funcionando.');
  Logger.log(ok ? 'Mensaje enviado — fijate en Telegram.' : 'No se pudo enviar — revisá las Script Properties.');
}

// Crear el disparador diario — ejecutar UNA vez desde el editor.
function configurarRecordatorioTarjeta() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'revisarTarjetaTelegram') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('revisarTarjetaTelegram').timeBased().everyDays(1).atHour(9).create();
  Logger.log('OK: disparador diario creado (corre entre las 9 y las 10am).');
}

// Corre todos los días vía trigger. Decide si hay algo que avisar hoy.
function revisarTarjetaTelegram() {
  const ciclos = _leerCiclos();
  if (!ciclos.length) return;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const DIA = 24 * 60 * 60 * 1000;
  const fmtF = ms => { const d = new Date(ms); return d.getDate() + '/' + (d.getMonth() + 1); };
  const msgs = [];

  // ── Cierre: se acerca, es hoy, o ya pasó sin ciclo nuevo cargado ──
  const proxCierre = ciclos.find(c => c.cierre >= hoy.getTime());
  if (proxCierre) {
    const dias = Math.round((proxCierre.cierre - hoy.getTime()) / DIA);
    if (dias === 2) {
      msgs.push('📅 La tarjeta <b>cierra en 2 días</b> (' + fmtF(proxCierre.cierre) + '). Después del cierre acordate de cargar el próximo ciclo en la app.');
    } else if (dias === 0) {
      msgs.push('✂️ <b>Hoy cierra la tarjeta</b> (' + fmtF(proxCierre.cierre) + '). Cuando el banco te confirme el próximo cierre y vencimiento, cargalos en la app (botón <b>+</b> → 💳 Tarjeta).');
    }
  } else {
    const ultimo = ciclos[ciclos.length - 1];
    const diasPasados = Math.round((hoy.getTime() - ultimo.cierre) / DIA);
    if ([1, 3, 7, 14].indexOf(diasPasados) >= 0) {
      msgs.push('⚠️ El último cierre cargado (' + fmtF(ultimo.cierre) + ') fue hace ' + diasPasados + ' día' + (diasPasados === 1 ? '' : 's') + ' y el próximo ciclo <b>no está cargado</b>. Las compras nuevas se están imputando con fechas estimadas — cargá el próximo ciclo en la app (botón <b>+</b> → 💳 Tarjeta).');
    }
  }

  // ── Vencimiento: mañana u hoy, con el monto del resumen ──
  const proxVenc = ciclos.find(c => c.vencimiento >= hoy.getTime());
  if (proxVenc) {
    const dias = Math.round((proxVenc.vencimiento - hoy.getTime()) / DIA);
    if (dias === 1 || dias === 0) {
      let monto = 0;
      try {
        const data = getDashboardData();
        const v = new Date(proxVenc.vencimiento);
        const k = v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0');
        const mes = (data.meses || []).find(m => m.key === k);
        monto = (mes && mes.totalTC) || 0;
      } catch (e) { /* sin monto, el aviso sale igual */ }
      const montoTxt = monto > 0 ? ': <b>$' + Math.round(monto).toLocaleString('es-AR') + '</b>' : '';
      msgs.push('💳 ' + (dias === 1 ? '<b>Mañana vence la tarjeta</b>' : '<b>HOY vence la tarjeta</b>') + ' (' + fmtF(proxVenc.vencimiento) + ')' + montoTxt + '. No te olvides de pagar el resumen.');
    }
  }

  if (msgs.length) _enviarTelegramTC(msgs.join('\n\n'));
}

// ─── Helpers de caché (parten el texto en bloques por el límite de 100KB) ───
function _cachePutLarge(cache, baseKey, str, ttl) {
  const CHUNK = 50000;
  const n = Math.ceil(str.length / CHUNK) || 1;
  const entries = {};
  for (let i = 0; i < n; i++) entries[baseKey + '_' + i] = str.substring(i * CHUNK, (i + 1) * CHUNK);
  entries[baseKey + '_n'] = String(n);
  cache.putAll(entries, ttl);
}

function _cacheGetLarge(cache, baseKey) {
  const nStr = cache.get(baseKey + '_n');
  if (!nStr) return null;
  const n = parseInt(nStr, 10);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(baseKey + '_' + i);
  const parts = cache.getAll(keys);
  let out = '';
  for (let i = 0; i < n; i++) {
    const p = parts[baseKey + '_' + i];
    if (p == null) return null;
    out += p;
  }
  return out;
}
