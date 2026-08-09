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

const COLUMNAS_REGISTRO = [
  'id', 'fecha', 'id_ot', 'proceso', 'equipo', 'cantidad_procesada', 'observaciones'
];

const PROCESOS_VALIDOS = ['Carpintería', 'Moldeo', 'Fundición', 'Terminación'];

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

/** Devuelve la hoja del parte diario, creándola con encabezados si falta. */
function getHojaRegistro() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(CONFIG.HOJA_REGISTRO);
  if (!hoja) {
    hoja = ss.insertSheet(CONFIG.HOJA_REGISTRO);
    hoja.appendRow(COLUMNAS_REGISTRO);
    hoja.setFrozenRows(1);
    hoja.getRange(1, 1, 1, COLUMNAS_REGISTRO.length).setFontWeight('bold');
  }
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
 * Registra una carga diaria.
 *
 * Body (text/plain con JSON adentro — se manda así a propósito para que el
 * navegador lo trate como "simple request" y no dispare preflight CORS,
 * que Apps Script no sabe responder):
 *   { token, fecha, id_ot, proceso, equipo, cantidad_procesada, observaciones }
 */
function doPost(e) {
  const lock = LockService.getScriptLock();

  // Sin lock, dos cargas simultáneas pueden leer el mismo valor de
  // "Cantidad Completada" y una pisar a la otra, perdiendo producción.
  try {
    lock.waitLock(30000);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'El sistema está ocupado, reintentá en unos segundos.' });
  }

  try {
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

    // Sin `accion` se asume carga diaria: así las versiones previas de
    // carga.html siguen funcionando sin cambiarles una línea.
    const accion = String(datos.accion || 'carga_diaria').trim();

    // --- Validación -------------------------------------------------------
    const idOt = String(datos.id_ot || '').trim();
    if (!idOt) return jsonResponse({ ok: false, error: 'Falta la OT.' });

    if (accion === 'marcar_fase') return marcarFase(datos, idOt);
    if (accion !== 'carga_diaria') {
      return jsonResponse({ ok: false, error: 'Acción desconocida: ' + accion });
    }

    const cantidad = Number(datos.cantidad_procesada);
    if (!isFinite(cantidad) || cantidad <= 0) {
      return jsonResponse({ ok: false, error: 'La cantidad procesada debe ser un número mayor a 0.' });
    }

    const proceso = String(datos.proceso || '').trim();
    if (PROCESOS_VALIDOS.indexOf(proceso) === -1) {
      return jsonResponse({ ok: false, error: 'Proceso inválido: ' + proceso });
    }

    const fecha = String(datos.fecha || '').trim() ||
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

    // --- Ubicar la OT -----------------------------------------------------
    const hojaOt = getHojaOrdenes();
    const valores = hojaOt.getDataRange().getValues();
    if (valores.length < 2) {
      return jsonResponse({ ok: false, error: 'La planilla de órdenes está vacía.' });
    }

    const encabezados = valores[0];
    const colOt = indiceColumna(encabezados, CONFIG.COL_OT);
    if (colOt === -1) {
      return jsonResponse({ ok: false, error: 'No se encontró la columna "OT" en la planilla.' });
    }

    // Una OT ocupa varias filas (una por pieza) y el número solo figura en la
    // primera: esa fila es la que representa a la OT completa, y ahí vive el
    // avance acumulado.
    var filaOt = -1;
    for (var i = 1; i < valores.length; i++) {
      if (String(valores[i][colOt]).trim() === idOt) { filaOt = i; break; }
    }
    if (filaOt === -1) {
      return jsonResponse({ ok: false, error: 'No existe la OT ' + idOt + ' en la planilla.' });
    }

    const colCompletada = asegurarColumnaCompletada(hojaOt, encabezados);

    const previo = Number(valores[filaOt][colCompletada]) || 0;
    const nuevoTotal = previo + cantidad;

    // --- Escribir ---------------------------------------------------------
    // Primero el parte diario: es el dato de origen. Si algo falla después,
    // queda el registro para reconstruir el acumulado.
    const hojaRegistro = getHojaRegistro();
    const nuevoId = Math.max(0, hojaRegistro.getLastRow() - 1) + 1;

    hojaRegistro.appendRow([
      nuevoId,
      fecha,
      idOt,
      proceso,
      String(datos.equipo || '').trim(),
      cantidad,
      String(datos.observaciones || '').trim()
    ]);

    hojaOt.getRange(filaOt + 1, colCompletada + 1).setValue(nuevoTotal);
    SpreadsheetApp.flush();

    return jsonResponse({
      ok: true,
      id: nuevoId,
      id_ot: idOt,
      cantidad_procesada: cantidad,
      // La web usa este valor para reflejar el avance al instante, sin
      // esperar a que el CSV publicado se actualice (tarda unos minutos).
      cantidad_completada: nuevoTotal
    });

  } catch (err) {
    return jsonResponse({ ok: false, error: 'Error interno: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}
