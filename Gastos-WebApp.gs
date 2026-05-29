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

function doGet(e) {
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

    // Si la hoja tiene la columna Cuenta (6+ columnas), la incluimos.
    const lastCol = sheet.getLastColumn();
    const row = [new Date(), fecha, cat, desc, monto];
    if (lastCol >= 6) row.push(cuenta);

    sheet.appendRow(row);

    // Regenerar el Dashboard interno del Sheet para que quede sincronizado
    // con la página web. Equivale al trigger automático del Form.
    _regenerarResumenSilencioso();

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

    sheet.appendRow([new Date(), fecha, desc, monto]);

    _regenerarResumenSilencioso();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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

    // La 1ª cuota cae en el vencimiento del ciclo de la compra.
    const ciclos = _leerCiclos();
    const vencMs = _vencimientoParaFecha(ciclos, fechaCompra.getTime());
    const fecha1 = vencMs ? new Date(vencMs) : fechaCompra;

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let h = ss.getSheetByName('Cuotas');
    if (!h) {
      h = ss.insertSheet('Cuotas');
      h.getRange(1, 1, 1, 6).setValues([['Descripción', 'Monto Total', 'N° Cuotas', 'Fecha 1° Cuota (dd/mm/aaaa)', 'Categoría', 'Cuenta']]).setFontWeight('bold');
    }
    h.appendRow([desc, montoTotal, nCuotas, fecha1, categoria, 'Tarjeta de crédito']);
    _regenerarResumenSilencioso();
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
    '• Los gastos por categoría del mes en curso son los que figuran en la sección "Gastos del mes por categoría". No mezcles ese número con el de cuotas distribuidas ni con promedios históricos sin aclarar. Si vas a sumar dos cosas, decí explícitamente cuáles.\n' +
    '• Si Huevo te tira un número sin contexto (ej. "125.000"), preguntale qué representa antes de razonar — no asumas que es el precio de algo ni el total del mes.\n\n' +

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

function _construirContextoFinanciero(data, ingresoPromedio, rechazosRecientes) {
  const meses = data.meses || [];
  if (!meses.length) return 'No hay gastos cargados todavía.';

  const m = meses[0]; // mes más reciente
  const NOMBRES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const monthName = NOMBRES[m.mesNum];
  const daysInMonth = new Date(m.año, m.mesNum + 1, 0).getDate();
  const today = new Date();
  const isCurrent = today.getFullYear() === m.año && today.getMonth() === m.mesNum;
  const dayOfMonth = isCurrent ? today.getDate() : daysInMonth;
  const daysRemaining = Math.max(0, daysInMonth - dayOfMonth);
  const dailyFromSaldo = daysRemaining > 0 ? Math.round(m.saldo / daysRemaining) : 0;
  const dailyAvg = dayOfMonth > 0 ? Math.round(m.totalGastos / dayOfMonth) : 0;

  const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-AR');

  const cats = Object.entries(m.cats || {})
    .filter(([c, v]) => c !== 'Ahorro' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([c, v]) => '  • ' + c + ': ' + fmt(v))
    .join('\n');

  const catTotales = {}, catMeses = {};
  for (const mes of meses) {
    for (const [cat, val] of Object.entries(mes.cats || {})) {
      if (cat === 'Ahorro' || val <= 0) continue;
      catTotales[cat] = (catTotales[cat] || 0) + val;
      catMeses[cat] = (catMeses[cat] || 0) + 1;
    }
  }
  const catPromedios = Object.entries(catTotales)
    .map(([c, v]) => [c, Math.round(v / catMeses[c])])
    .sort((a, b) => b[1] - a[1]);
  const catPromTexto = catPromedios.map(([c, v]) => '  • ' + c + ': ' + fmt(v) + '/mes promedio').join('\n');

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
    'Ingresos del mes: ' + fmt(m.ingreso) + '\n' +
    'Ingresos promedio mensuales (de meses cargados): ' + ingresoTxt + '\n' +
    'Gastos del mes: ' + fmt(m.totalGastos) + '\n' +
    'Ahorro del mes: ' + fmt(m.totalAhorro) + '\n' +
    'Saldo libre: ' + fmt(m.saldo) + '\n' +
    'Disponible por día (saldo / días restantes): ' + fmt(dailyFromSaldo) + '\n' +
    'Promedio actual de gasto: ' + fmt(dailyAvg) + '/día\n\n' +
    'Gastos del mes por categoría:\n' + (cats || '  (ninguno)') + '\n\n' +
    'Promedios históricos por categoría:\n' + (catPromTexto || '  (sin histórico)') + '\n\n' +
    'Metas de ahorro:\n' + metas + '\n\n' +
    'Cuotas vigentes:\n' + cuotas + '\n\n' +
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

  // CACHÉ: la clave depende de la cantidad de filas. Cuando agregás un gasto,
  // ingreso, meta, cuota o ciclo, la clave cambia y se recalcula solo.
  const cache = CacheService.getScriptCache();
  const cacheKey = 'dash_v5_' +
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

  const porMes = {}, ingresosPorMes = {};

  for (const fila of datosGastos) {
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
    info.gastos.push({ fecha: fecha.getTime(), desc, cat, monto, cuenta, esTarjeta, reasignado });
    info.cats[cat] = (info.cats[cat] || 0) + monto;
    // Una compra reasignada al vencimiento no cuenta como "día con gasto" de ese mes futuro.
    if (!reasignado) info.dias[fecha.toISOString().slice(0, 10)] = true;
    if (cat !== "Ahorro") info.cuentas[cuenta] = (info.cuentas[cuenta] || 0) + monto;
  }

  const ingresosDetalle = {};
  for (const fila of datosIngresos) {
    const fecha = new Date(fila[1]);
    if (isNaN(fecha.getTime())) continue;
    const k = fecha.getFullYear() + "-" + String(fecha.getMonth() + 1).padStart(2, '0');
    const monto = parseFloat(fila[3]);
    const desc = (fila[2] || "").toString().trim();
    if (isNaN(monto)) continue;
    ingresosPorMes[k] = (ingresosPorMes[k] || 0) + monto;
    if (!ingresosDetalle[k]) ingresosDetalle[k] = [];
    ingresosDetalle[k].push({ fecha: fecha.getTime(), desc, monto });
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

  const meses = Object.keys(porMes);
  for (const k of meses) {
    const info = porMes[k];
    const cuotasMes = _getCuotasMes(cuotas, info.año, info.mesNum);
    const fijosMes = _getGastosFijosMes(gastosFijos, info.año, info.mesNum);
    for (const item of [...cuotasMes, ...fijosMes]) {
      if (!item.monto || item.monto <= 0) continue;
      info.gastos.push({
        fecha: new Date(info.año, info.mesNum, 15).getTime(),
        desc: item.desc, cat: item.cat, monto: item.monto,
        cuenta: item.cuenta, esCuota: !!item.esCuota, esFijo: !!item.esFijo
      });
      info.cats[item.cat] = (info.cats[item.cat] || 0) + item.monto;
      if (item.cat !== "Ahorro") info.cuentas[item.cuenta] = (info.cuentas[item.cuenta] || 0) + item.monto;
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
    info.cats = {}; info.cuentas = {};
    for (const g of info.gastos) {
      info.cats[g.cat] = (info.cats[g.cat] || 0) + g.monto;
      if (g.cat !== "Ahorro") info.cuentas[g.cuenta] = (info.cuentas[g.cuenta] || 0) + g.monto;
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
      saldo: ingreso - totalGastos - totalAhorro,
      cats: info.cats, cuentas: info.cuentas,
      gastos: info.gastos.filter(g => g.monto > 0),
      diasConGasto: Object.keys(info.dias).length,
      ajusteTC: info.ajusteTC || 0, tcOriginal: info.tcOriginal || 0
    };
  });

  const metas = metasRaw.map(m => {
    let limite = null;
    if (m[3]) {
      const fs = String(m[3]);
      if (fs.includes("/")) { const p = fs.split("/"); limite = new Date(+p[2], +p[1] - 1, +p[0]).getTime(); }
      else { const d = new Date(fs); if (!isNaN(d.getTime())) limite = d.getTime(); }
    }
    return { nombre: m[0], objetivo: parseFloat(m[1]) || 0, acumulado: parseFloat(m[2]) || 0, limite: limite, notas: m[4] || "" };
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
    actualizado: new Date().getTime()
  };

  // Guardar en caché 5 minutos (se invalida antes si cambian las filas)
  try { _cachePutLarge(cache, cacheKey, JSON.stringify(result), 300); } catch (e) {}

  return result;
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
