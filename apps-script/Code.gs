/**
 * RVH Fundición — Backend de escritura del PCP.
 *
 * La planilla de Google sigue siendo la base de datos. Este script se
 * publica como Web App y es lo único que puede ESCRIBIR en ella:
 * el CSV publicado que lee la web es de solo lectura.
 *
 * Responsabilidades:
 *   1. Insertar la carga diaria en la hoja `registro_diario`.
 *   2. Sumar esa cantidad a "Cantidad Completada" de la OT correspondiente.
 *
 * Ver README.md para los pasos de instalación.
 */

// Se sube al cambiar el contrato con la web. La app lo compara y avisa si
// la planilla quedó con una versión vieja publicada: sin esto, un script
// desactualizado da errores que no se parecen en nada a la causa real.
const VERSION = 6;

const CONFIG = {
  // gid de la pestaña de órdenes de trabajo — es el mismo número que ya
  // aparece en la URL del CSV publicado (…&gid=296832343&…).
  GID_ORDENES: 296832343,

  // Nombre de la pestaña del parte diario. Se crea sola si no existe.
  HOJA_REGISTRO: 'registro_diario',

  // Clave compartida entre la web y este script. NO es un login de usuario
  // (el sistema no tiene usuarios); solo evita que alguien que encuentre la
  // URL del Web App pueda escribir en la planilla. Cambiala por una cadena
  // propia y poné la misma en CONFIG.API_TOKEN de shared.js.
  TOKEN: 'rvh-pcp-2026',

  COL_OT: 'OT',
  COL_COMPLETADA: 'Cantidad Completada'
};

// Calcado de la "Planilla Oficial de Control Diario de Producción": una
// fila por tanda, con operario, moldes y kilos. `pieza` es lo que en el
// papel va en Observaciones y es lo que permite deducir a qué OT
// corresponde. `id_ot` y `piezas` son opcionales: el operario no siempre
// sabe el número de OT, y no se le va a exigir.
const COLUMNAS_REGISTRO = [
  'id', 'fecha', 'sector', 'operario', 'cantidad_moldes', 'kg_por_molde',
  'total_kg', 'pieza', 'id_ot', 'piezas', 'observaciones', 'creado_en'
];

const SECTORES_VALIDOS = ['Carpintería', 'Moldeo', 'Fundición', 'Terminación'];

// Fases que se estampan con fecha. La columna va prefijada con "Fecha "
// porque "Moldeo" y "Terminación" ya se usan como columnas de cantidad.
const FASES_ESTAMPABLES = ['Modelería', 'Moldeo', 'Colada', 'Terminación', 'Despacho', 'Entregado'];
function columnaFase(fase) { return 'Fecha ' + fase; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compara nombres de columna ignorando acentos, mayúsculas y espacios. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

function jsonResponse(obj) {
  obj.version = VERSION;
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Ubica la pestaña de OTs por gid (coincide exactamente con el CSV publicado). */
function getHojaOrdenes() {
  const hojas = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < hojas.length; i++) {
    if (hojas[i].getSheetId() === CONFIG.GID_ORDENES) return hojas[i];
  }
  // Si cambió el gid, caemos a la primera pestaña para no romper la carga.
  return hojas[0];
}

/**
 * Devuelve la hoja del parte diario, creándola si falta y agregando las
 * columnas que no estén. Se escribe siempre por nombre de encabezado, no
 * por posición: así una planilla creada con una versión anterior del
 * script sigue funcionando y solo se le suman las columnas nuevas.
 */
function getHojaRegistro() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(CONFIG.HOJA_REGISTRO);

  if (!hoja) {
    hoja = ss.insertSheet(CONFIG.HOJA_REGISTRO);
    hoja.appendRow(COLUMNAS_REGISTRO);
    hoja.setFrozenRows(1);
    hoja.getRange(1, 1, 1, COLUMNAS_REGISTRO.length).setFontWeight('bold');
    return hoja;
  }

  var encabezados = hoja.getLastColumn()
    ? hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0]
    : [];

  COLUMNAS_REGISTRO.forEach(function (col) {
    if (indiceColumna(encabezados, col) === -1) {
      encabezados.push(col);
      hoja.getRange(1, encabezados.length).setValue(col).setFontWeight('bold');
    }
  });

  return hoja;
}

/** Agrega una fila al parte diario ubicando cada valor por su encabezado. */
function agregarRegistro(datos) {
  const hoja = getHojaRegistro();
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];

  const fila = encabezados.map(function (col) {
    const clave = normalizar(col);
    for (var k in datos) {
      if (normalizar(k) === clave) return datos[k];
    }
    return '';
  });

  hoja.appendRow(fila);
  return hoja;
}

/** Índice (0-based) de una columna por nombre; -1 si no existe. */
function indiceColumna(encabezados, nombre) {
  const objetivo = normalizar(nombre);
  for (var i = 0; i < encabezados.length; i++) {
    if (normalizar(encabezados[i]) === objetivo) return i;
  }
  return -1;
}

/**
 * Agrega la columna "Cantidad Completada" al final si la planilla todavía
 * no la tiene, así el sistema funciona sin preparación manual previa.
 */
function asegurarColumnaCompletada(hoja, encabezados) {
  var idx = indiceColumna(encabezados, CONFIG.COL_COMPLETADA);
  if (idx !== -1) return idx;

  idx = encabezados.length;
  hoja.getRange(1, idx + 1).setValue(CONFIG.COL_COMPLETADA).setFontWeight('bold');
  return idx;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Estampa la fecha de una fase en la fila cabecera de la OT.
 * Idempotente por diseño: si la fase ya tenía fecha, se conserva la
 * original — el dato que interesa es cuándo pasó de verdad, no cuántas
 * veces alguien tocó el botón.
 */
function marcarFase(datos, idOt) {
  const fase = String(datos.fase || '').trim();
  if (FASES_ESTAMPABLES.indexOf(fase) === -1) {
    return jsonResponse({ ok: false, error: 'Fase inválida: ' + fase });
  }

  const fecha = String(datos.fecha || '').trim() ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  const hoja = getHojaOrdenes();
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) {
    return jsonResponse({ ok: false, error: 'La planilla de órdenes está vacía.' });
  }

  const encabezados = valores[0];
  const colOt = indiceColumna(encabezados, CONFIG.COL_OT);
  if (colOt === -1) {
    return jsonResponse({ ok: false, error: 'No se encontró la columna "OT".' });
  }

  var fila = -1;
  for (var i = 1; i < valores.length; i++) {
    if (String(valores[i][colOt]).trim() === idOt) { fila = i; break; }
  }
  if (fila === -1) {
    return jsonResponse({ ok: false, error: 'No existe la OT ' + idOt + ' en la planilla.' });
  }

  const nombreCol = columnaFase(fase);
  var col = indiceColumna(encabezados, nombreCol);
  if (col === -1) {
    // Se crea sola: así no hace falta preparar la planilla a mano.
    col = encabezados.length;
    hoja.getRange(1, col + 1).setValue(nombreCol).setFontWeight('bold');
  }

  const previo = String(valores[fila][col] || '').trim();
  if (previo) {
    return jsonResponse({ ok: true, id_ot: idOt, fase: fase, fecha: previo, yaEstaba: true });
  }

  hoja.getRange(fila + 1, col + 1).setValue(fecha);
  SpreadsheetApp.flush();
  return jsonResponse({ ok: true, id_ot: idOt, fase: fase, fecha: fecha, yaEstaba: false });
}

/**
 * Devuelve una fecha como texto 'yyyy-MM-dd'. La celda puede venir como
 * string (lo que escribimos) o como Date, si Sheets la interpretó sola.
 */
function fechaTexto(valor) {
  if (valor instanceof Date) {
    return Utilities.formatDate(valor, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(valor || '').trim();
}

/**
 * Igual que fechaTexto pero con hora. Se escribe como texto, pero si
 * alguien reformatea la columna Sheets la reinterpreta como fecha-hora y
 * la devuelve como Date; sin esto el registro mostraría el toString de JS.
 */
function fechaHoraTexto(valor) {
  if (valor instanceof Date) {
    return Utilities.formatDate(valor, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return String(valor || '').trim();
}

/**
 * Lee filas del parte diario aplicando un filtro. Compartido por la vista
 * del día y por el registro histórico, para que ambas devuelvan
 * exactamente la misma forma de dato.
 */
function filasRegistro(filtro) {
  const hoja = getHojaRegistro();
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return [];

  // Solo las columnas del parte. getDataRange() arrastra además todo lo que
  // alguien haya dejado a la derecha en la hoja, y eso viaja en cada lectura.
  const anchoUtil = Math.min(hoja.getLastColumn(), COLUMNAS_REGISTRO.length);
  const valores = hoja.getRange(1, 1, ultimaFila, anchoUtil).getValues();

  const encabezados = valores[0];
  const idx = {};
  COLUMNAS_REGISTRO.forEach(function (c) { idx[c] = indiceColumna(encabezados, c); });
  const celda = function (fila, col) { return idx[col] === -1 ? '' : fila[idx[col]]; };

  const filas = [];
  for (var i = 1; i < valores.length; i++) {
    const fecha = fechaTexto(celda(valores[i], 'fecha'));
    const sector = String(celda(valores[i], 'sector') || '');
    if (!fecha) continue;
    if (filtro.fecha && fecha !== filtro.fecha) continue;
    if (filtro.desde && fecha < filtro.desde) continue;
    if (filtro.sector && normalizar(sector) !== normalizar(filtro.sector)) continue;

    filas.push({
      id: Number(celda(valores[i], 'id')) || i,
      fecha: fecha,
      sector: sector,
      operario: String(celda(valores[i], 'operario') || ''),
      cantidad_moldes: Number(celda(valores[i], 'cantidad_moldes')) || 0,
      kg_por_molde: Number(celda(valores[i], 'kg_por_molde')) || 0,
      total_kg: Number(celda(valores[i], 'total_kg')) || 0,
      pieza: String(celda(valores[i], 'pieza') || ''),
      observaciones: String(celda(valores[i], 'observaciones') || ''),
      creado_en: fechaHoraTexto(celda(valores[i], 'creado_en'))
    });
  }
  return filas;
}

/**
 * Devuelve todas las tandas cargadas en una fecha, de todos los sectores.
 * Se pide por POST y no por doGet a propósito: el POST con text/plain ya
 * está probado y no dispara preflight CORS, que Apps Script no responde.
 */
function leerDia(datos) {
  const fecha = String(datos.fecha || '').trim() ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return jsonResponse({ ok: true, fecha: fecha, filas: filasRegistro({ fecha: fecha }) });
}

/**
 * Registro histórico: todas las tandas desde una fecha en adelante, más
 * nuevas primero. Sin `desde` toma los últimos 60 días, para no devolver
 * toda la historia en cada apertura de la página.
 */
function leerRegistro(datos) {
  var desde = String(datos.desde || '').trim();
  if (!desde) {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    desde = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const filas = filasRegistro({
    desde: desde,
    sector: String(datos.sector || '').trim()
  });

  // Más reciente primero; dentro del mismo día, lo último cargado arriba.
  filas.sort(function (a, b) {
    if (a.fecha !== b.fecha) return a.fecha < b.fecha ? 1 : -1;
    return b.id - a.id;
  });

  return jsonResponse({ ok: true, desde: desde, filas: filas });
}

/**
 * Borra tandas del parte diario por id. Se borra de abajo hacia arriba
 * porque cada deleteRow corre las filas siguientes: hacerlo al revés
 * terminaría borrando la fila equivocada.
 */
function borrarRegistro(datos) {
  const ids = (datos.ids || []).map(function (x) { return Number(x); })
    .filter(function (n) { return isFinite(n) && n > 0; });
  if (!ids.length) return jsonResponse({ ok: false, error: 'No se indicó qué borrar.' });

  const hoja = getHojaRegistro();
  const valores = hoja.getDataRange().getValues();
  if (valores.length < 2) return jsonResponse({ ok: false, error: 'El registro está vacío.' });

  const colId = indiceColumna(valores[0], 'id');
  if (colId === -1) return jsonResponse({ ok: false, error: 'No se encontró la columna "id".' });

  const aBorrar = [];
  for (var i = 1; i < valores.length; i++) {
    if (ids.indexOf(Number(valores[i][colId])) !== -1) aBorrar.push(i + 1);
  }
  if (!aBorrar.length) return jsonResponse({ ok: false, error: 'No se encontraron esas tandas.' });

  aBorrar.sort(function (a, b) { return b - a; });
  aBorrar.forEach(function (fila) { hoja.deleteRow(fila); });
  SpreadsheetApp.flush();

  return jsonResponse({ ok: true, borradas: aBorrar.length });
}

/** Chequeo de salud: abrir la URL del Web App en el navegador debe responder ok. */
function doGet() {
  return jsonResponse({
    ok: true,
    servicio: 'RVH PCP',
    hoja_ordenes: getHojaOrdenes().getName(),
    hoja_registro: CONFIG.HOJA_REGISTRO
  });
}

/**
 * Registra una carga diaria, calcada de la planilla de papel del sector.
 *
 * Body (text/plain con JSON adentro — se manda así a propósito para que el
 * navegador lo trate como "simple request" y no dispare preflight CORS,
 * que Apps Script no sabe responder):
 *   { token, fecha, sector, operario, cantidad_moldes, kg_por_molde,
 *     pieza, id_ot?, piezas?, observaciones? }
 *
 * `id_ot` es opcional: en el papel no figura, y el operario no siempre la
 * sabe. Si viene, se suma `piezas` al avance de esa OT.
 */
function doPost(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return jsonResponse({ ok: false, error: 'Petición vacía.' });
  }

  var datos;
  try {
    datos = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Formato de datos inválido.' });
  }

  if (String(datos.token || '') !== CONFIG.TOKEN) {
    return jsonResponse({ ok: false, error: 'Token inválido.' });
  }

  const accion = String(datos.accion || 'carga_diaria').trim();

  // Las lecturas salen por acá, antes del candado, y no compiten con nada.
  // El candado es uno solo para todo el script: candar también las lecturas
  // hacía que cada pantalla abierta esperara su turno detrás de las demás, y
  // con dos personas mirando la planilla eso se sentía como "no responde".
  if (accion === 'leer_dia') return leerDia(datos);
  if (accion === 'leer_registro') return leerRegistro(datos);

  const lock = LockService.getScriptLock();

  // Sin candado, dos cargas simultáneas pueden leer el mismo valor de
  // "Cantidad Completada" y una pisar a la otra, perdiendo producción.
  //
  // Diez segundos y no más: el navegador corta a los 25, así que una
  // escritura que esperó media hoja de cola ya llega tarde igual. Es
  // preferible avisar rápido que dejar a alguien mirando el reloj.
  try {
    lock.waitLock(10000);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'El sistema está ocupado, reintentá en unos segundos.' });
  }

  try {
    if (accion === 'marcar_fase') {
      const otFase = String(datos.id_ot || '').trim();
      if (!otFase) return jsonResponse({ ok: false, error: 'Falta la OT.' });
      return marcarFase(datos, otFase);
    }
    if (accion === 'borrar_registro') return borrarRegistro(datos);
    if (accion !== 'carga_diaria') {
      return jsonResponse({ ok: false, error: 'Acción desconocida: ' + accion });
    }

    // --- Validación -------------------------------------------------------
    const sector = String(datos.sector || '').trim();
    if (SECTORES_VALIDOS.indexOf(sector) === -1) {
      return jsonResponse({ ok: false, error: 'Sector inválido: ' + sector });
    }

    const moldes = Number(datos.cantidad_moldes);
    if (!isFinite(moldes) || moldes <= 0) {
      return jsonResponse({ ok: false, error: 'La cantidad de moldes debe ser mayor a 0.' });
    }

    const kgPorMolde = Number(datos.kg_por_molde);
    if (!isFinite(kgPorMolde) || kgPorMolde < 0) {
      return jsonResponse({ ok: false, error: 'Los kg por molde deben ser un número.' });
    }

    const operario = String(datos.operario || '').trim();
    if (!operario) return jsonResponse({ ok: false, error: 'Falta el operario.' });

    const fecha = String(datos.fecha || '').trim() ||
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    const totalKg = moldes * kgPorMolde;

    // El parte diario mide producción del sector y nada más: no toca las
    // OT. En la planilla de papel tampoco figura ninguna, y obligar a
    // relacionarlas solo agregaba fricción al operario.
    const hojaRegistro = getHojaRegistro();
    const nuevoId = Math.max(0, hojaRegistro.getLastRow() - 1) + 1;

    agregarRegistro({
      id: nuevoId,
      fecha: fecha,
      sector: sector,
      operario: operario,
      cantidad_moldes: moldes,
      kg_por_molde: kgPorMolde,
      total_kg: totalKg,
      pieza: String(datos.pieza || '').trim(),
      observaciones: String(datos.observaciones || '').trim(),
      // Cuándo se cargó, que no es lo mismo que cuándo se produjo: sirve
      // para auditar una carga tardía o corregida.
      creado_en: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
    });
    SpreadsheetApp.flush();

    return jsonResponse({
      ok: true,
      id: nuevoId,
      fecha: fecha,
      sector: sector,
      total_kg: totalKg,
      total_moldes: moldes
    });

  } catch (err) {
    return jsonResponse({ ok: false, error: 'Error interno: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}
