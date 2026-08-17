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
const VERSION = 9;

const CONFIG = {
  // gid de la pestaña de órdenes de trabajo — es el mismo número que ya
  // aparece en la URL del CSV publicado (…&gid=296832343&…).
  GID_ORDENES: 296832343,

  // Pestañas del sistema. Todas se crean solas si no existen.
  HOJA_REGISTRO: 'registro_diario',
  HOJA_EMPLEADOS: 'empleados',
  HOJA_ASISTENCIA: 'asistencia',

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
  'total_kg', 'material', 'pieza', 'id_ot', 'piezas', 'observaciones', 'creado_en'
];

// Legajo, nombre y estado de cada persona. `activo` en FALSE es una baja: la
// fila no se borra nunca, porque la asistencia vieja tiene que seguir
// pudiendo mostrar de quién era.
const COLUMNAS_EMPLEADOS = ['legajo', 'nombre', 'sector', 'activo', 'desde', 'hasta', 'notas'];

// Una fila por persona y por día. `estado` es lo que se marca en la página.
const COLUMNAS_ASISTENCIA = ['fecha', 'legajo', 'nombre', 'estado', 'notas', 'creado_en'];

const ESTADOS_ASISTENCIA = ['Presente', 'Ausente', 'Permiso', 'Reposo', 'Vacaciones'];

// Aleaciones que se cuelan. Se guarda el texto tal cual para que la planilla
// se lea sola, y la lista vive acá para que la página y el script no se
// desincronicen.
const MATERIALES_FUNDICION = [
  'Hierro gris', 'Nodular', 'Acero', 'Acero al manganeso', 'Aceros especiales',
  'Bronce', 'Aluminio'
];

// Nombres alternativos aceptados para una columna del parte.
//
// La hoja la llevan personas y la columna de notas aparece escrita de varias
// formas según quién la armó. Buscándola solo por el nombre exacto, el texto
// quedaba invisible en la página aunque estuviera cargado en la planilla:
// ni la lectura lo encontraba ni la escritura sabía dónde ponerlo.
//
// Mismo criterio que CORE_FIELD_ALIASES en shared.js para la hoja de OTs.
const ALIAS_REGISTRO = {
  pieza: ['pieza / observaciones', 'pieza/observaciones', 'descripcion',
    'descripcion de la pieza', 'detalle', 'trabajo'],
  observaciones: ['observacion', 'obs', 'obs.', 'nota', 'notas',
    'comentario', 'comentarios', 'pieza / observaciones', 'pieza/observaciones'],
  operario: ['operarios', 'responsable'],
  cantidad_moldes: ['cantidad', 'cantidad de moldes', 'moldes'],
  kg_por_molde: ['kg por molde', 'kg/molde'],
  total_kg: ['total de kg', 'total kg', 'kg total']
};

/**
 * Índice de una columna aceptando sus alias. El nombre exacto siempre gana;
 * los alias solo entran si la columna canónica no está.
 */
function indiceColumnaCon(encabezados, nombre) {
  var i = indiceColumna(encabezados, nombre);
  if (i !== -1) return i;

  const alias = ALIAS_REGISTRO[nombre] || [];
  for (var a = 0; a < alias.length; a++) {
    i = indiceColumna(encabezados, alias[a]);
    if (i !== -1) return i;
  }
  return -1;
}

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
function getHojaCon(nombre, columnas) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(nombre);

  if (!hoja) {
    hoja = ss.insertSheet(nombre);
    hoja.appendRow(columnas);
    hoja.setFrozenRows(1);
    hoja.getRange(1, 1, 1, columnas.length).setFontWeight('bold');
    return hoja;
  }

  var encabezados = hoja.getLastColumn()
    ? hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0]
    : [];

  // Con alias: si la hoja ya tiene la columna con otro nombre, se respeta el
  // que está en vez de agregar una segunda al lado. Duplicarla era peor que
  // no tenerla: se escribía en una y se leía de la otra.
  columnas.forEach(function (col) {
    if (indiceColumnaCon(encabezados, col) === -1) {
      encabezados.push(col);
      hoja.getRange(1, encabezados.length).setValue(col).setFontWeight('bold');
    }
  });

  return hoja;
}

function getHojaRegistro() {
  return getHojaCon(CONFIG.HOJA_REGISTRO, COLUMNAS_REGISTRO);
}

function getHojaEmpleados() {
  return getHojaCon(CONFIG.HOJA_EMPLEADOS, COLUMNAS_EMPLEADOS);
}

function getHojaAsistencia() {
  return getHojaCon(CONFIG.HOJA_ASISTENCIA, COLUMNAS_ASISTENCIA);
}

/**
 * Lee una hoja entera devolviendo objetos por nombre de columna.
 * Mismo criterio que filasRegistro, pero genérico.
 */
function filasDe(hoja, columnas) {
  const ultimaFila = hoja.getLastRow();
  if (ultimaFila < 2) return [];

  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const idx = {};
  var ancho = 1;
  columnas.forEach(function (c) {
    idx[c] = indiceColumnaCon(encabezados, c);
    if (idx[c] + 1 > ancho) ancho = idx[c] + 1;
  });

  const valores = hoja.getRange(1, 1, ultimaFila, ancho).getValues();
  const filas = [];
  for (var i = 1; i < valores.length; i++) {
    const obj = { _fila: i + 1 };
    columnas.forEach(function (c) {
      obj[c] = idx[c] === -1 ? '' : valores[i][idx[c]];
    });
    filas.push(obj);
  }
  return filas;
}

/** Escribe un objeto en una fila, ubicando cada valor por su encabezado. */
function escribirEn(hoja, numeroFila, columnas, datos) {
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  columnas.forEach(function (campo) {
    const i = indiceColumnaCon(encabezados, campo);
    if (i !== -1 && datos[campo] !== undefined) {
      hoja.getRange(numeroFila, i + 1).setValue(datos[campo]);
    }
  });
}

/**
 * Agrega una fila al parte diario ubicando cada valor por su encabezado.
 *
 * Se resuelve del campo hacia la columna y no al revés: antes se recorrían
 * los encabezados buscando un dato que se llamara igual, así que un
 * encabezado con otro nombre no recibía nada y el dato se perdía sin aviso.
 */
function agregarRegistro(datos) {
  const hoja = getHojaRegistro();
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];

  const fila = [];
  for (var i = 0; i < encabezados.length; i++) fila.push('');

  COLUMNAS_REGISTRO.forEach(function (campo) {
    const i = indiceColumnaCon(encabezados, campo);
    if (i !== -1 && datos[campo] !== undefined) fila[i] = datos[campo];
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

  // Los encabezados se leen completos y recién después se acota el ancho de
  // los datos, hasta la última columna que realmente se usa. Cortar antes de
  // resolver los índices rompería la búsqueda por nombre —una columna que
  // quedó más a la derecha simplemente desaparecería del parte, sin aviso—
  // que es justamente lo que este archivo evita al no trabajar por posición.
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
  const idx = {};
  var anchoUtil = 1;
  COLUMNAS_REGISTRO.forEach(function (c) {
    idx[c] = indiceColumnaCon(encabezados, c);
    if (idx[c] + 1 > anchoUtil) anchoUtil = idx[c] + 1;
  });

  const valores = hoja.getRange(1, 1, ultimaFila, anchoUtil).getValues();
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
      material: String(celda(valores[i], 'material') || ''),
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

// ---------------------------------------------------------------------------
// Empleados
// ---------------------------------------------------------------------------

/**
 * Personal cargado. Por defecto solo el que está activo: la página de carga
 * no tiene por qué ofrecer a alguien que ya no trabaja acá.
 */
function leerEmpleados(datos) {
  const todos = String(datos.todos || '') === 'si';
  const filas = filasDe(getHojaEmpleados(), COLUMNAS_EMPLEADOS)
    .filter(function (e) { return String(e.nombre || '').trim(); })
    .map(function (e) {
      return {
        legajo: String(e.legajo || '').trim(),
        nombre: String(e.nombre || '').trim(),
        sector: String(e.sector || '').trim(),
        activo: String(e.activo).toUpperCase() !== 'FALSE' && e.activo !== false,
        desde: fechaTexto(e.desde),
        hasta: fechaTexto(e.hasta),
        notas: String(e.notas || '').trim()
      };
    });

  return jsonResponse({
    ok: true,
    empleados: todos ? filas : filas.filter(function (e) { return e.activo; })
  });
}

/**
 * Alta de personal. Acepta varios de una porque la primera carga es la lista
 * entera del taller, y darla de a uno sería media hora de tipeo.
 *
 * Si el legajo ya existe se actualiza en lugar de duplicar: volver a pegar la
 * lista no tiene que dejar a nadie dos veces.
 */
function altaEmpleado(datos) {
  const entrada = datos.empleados || [datos];
  const hoja = getHojaEmpleados();
  const existentes = filasDe(hoja, COLUMNAS_EMPLEADOS);
  const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var altas = 0, updates = 0;

  entrada.forEach(function (e) {
    const nombre = String(e.nombre || '').trim();
    if (!nombre) return;
    const legajo = String(e.legajo || '').trim();

    // Se busca por legajo, y si no vino, por nombre: la lista de papel no
    // siempre trae número y aun así no se debe duplicar a la persona.
    var previo = null;
    for (var i = 0; i < existentes.length; i++) {
      const mismoLegajo = legajo && String(existentes[i].legajo || '').trim() === legajo;
      const mismoNombre = normalizar(existentes[i].nombre) === normalizar(nombre);
      if (mismoLegajo || (!legajo && mismoNombre)) { previo = existentes[i]; break; }
    }

    const fila = {
      legajo: legajo,
      nombre: nombre,
      sector: String(e.sector || '').trim(),
      activo: true,
      desde: previo && previo.desde ? fechaTexto(previo.desde) : hoy,
      hasta: '',
      notas: String(e.notas || '').trim()
    };

    if (previo) {
      escribirEn(hoja, previo._fila, COLUMNAS_EMPLEADOS, fila);
      updates++;
    } else {
      const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];
      const nueva = [];
      for (var c = 0; c < encabezados.length; c++) nueva.push('');
      COLUMNAS_EMPLEADOS.forEach(function (campo) {
        const j = indiceColumnaCon(encabezados, campo);
        if (j !== -1) nueva[j] = fila[campo];
      });
      hoja.appendRow(nueva);
      existentes.push({ _fila: hoja.getLastRow(), legajo: legajo, nombre: nombre });
      altas++;
    }
  });

  SpreadsheetApp.flush();
  return jsonResponse({ ok: true, altas: altas, actualizados: updates });
}

/**
 * Baja de personal. No borra la fila: la marca inactiva y le pone fecha de
 * salida. La asistencia de los meses anteriores tiene que seguir diciendo de
 * quién era, y borrarlo la dejaría con legajos huérfanos.
 */
function bajaEmpleado(datos) {
  const legajo = String(datos.legajo || '').trim();
  const nombre = String(datos.nombre || '').trim();
  if (!legajo && !nombre) return jsonResponse({ ok: false, error: 'No se indicó a quién dar de baja.' });

  const hoja = getHojaEmpleados();
  const filas = filasDe(hoja, COLUMNAS_EMPLEADOS);
  const hoy = String(datos.hasta || '').trim() ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // `reingreso` deshace una baja hecha por error, sin tener que ir a la hoja.
  const reingreso = String(datos.reingreso || '') === 'si';

  for (var i = 0; i < filas.length; i++) {
    const coincide = legajo
      ? String(filas[i].legajo || '').trim() === legajo
      : normalizar(filas[i].nombre) === normalizar(nombre);
    if (!coincide) continue;

    escribirEn(hoja, filas[i]._fila, COLUMNAS_EMPLEADOS, {
      activo: reingreso ? true : false,
      hasta: reingreso ? '' : hoy,
      notas: String(datos.notas || filas[i].notas || '').trim()
    });
    SpreadsheetApp.flush();
    return jsonResponse({ ok: true, nombre: String(filas[i].nombre || ''), reingreso: reingreso });
  }

  return jsonResponse({ ok: false, error: 'No se encontró a esa persona en la lista.' });
}

// ---------------------------------------------------------------------------
// Asistencia
// ---------------------------------------------------------------------------

/** Asistencia desde una fecha, más nueva primero. */
function leerAsistencia(datos) {
  var desde = String(datos.desde || '').trim();
  if (!desde) {
    const d = new Date();
    d.setDate(d.getDate() - 60);
    desde = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const hasta = String(datos.hasta || '').trim();

  const filas = filasDe(getHojaAsistencia(), COLUMNAS_ASISTENCIA)
    .map(function (a) {
      return {
        fecha: fechaTexto(a.fecha),
        legajo: String(a.legajo || '').trim(),
        nombre: String(a.nombre || '').trim(),
        estado: String(a.estado || '').trim(),
        notas: String(a.notas || '').trim()
      };
    })
    .filter(function (a) {
      if (!a.fecha || !a.estado) return false;
      if (a.fecha < desde) return false;
      if (hasta && a.fecha > hasta) return false;
      return true;
    })
    .sort(function (x, y) { return x.fecha < y.fecha ? 1 : x.fecha > y.fecha ? -1 : 0; });

  return jsonResponse({ ok: true, desde: desde, asistencia: filas });
}

/**
 * Guarda la asistencia de un día completo de una sola vez.
 *
 * Reemplaza lo que ya hubiera de esa fecha para las personas enviadas: se
 * marca al empezar la jornada y se corrige durante el día, y sin esto cada
 * corrección dejaría una fila más en vez de arreglar la que estaba.
 */
function guardarAsistencia(datos) {
  const fecha = String(datos.fecha || '').trim() ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const marcas = datos.marcas || [];
  if (!marcas.length) return jsonResponse({ ok: false, error: 'No se marcó a nadie.' });

  const invalido = marcas.filter(function (m) {
    return ESTADOS_ASISTENCIA.indexOf(String(m.estado || '').trim()) === -1;
  });
  if (invalido.length) {
    return jsonResponse({ ok: false, error: 'Estado inválido: ' + invalido[0].estado });
  }

  const hoja = getHojaAsistencia();
  const previas = filasDe(hoja, COLUMNAS_ASISTENCIA);
  const creado = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0];

  const clave = function (f, legajo, nombre) {
    return f + '|' + (String(legajo || '').trim() || normalizar(nombre));
  };
  const yaEstaba = {};
  previas.forEach(function (p) {
    if (fechaTexto(p.fecha) !== fecha) return;
    yaEstaba[clave(fecha, p.legajo, p.nombre)] = p._fila;
  });

  const nuevas = [];
  var actualizadas = 0;

  marcas.forEach(function (m) {
    const fila = {
      fecha: fecha,
      legajo: String(m.legajo || '').trim(),
      nombre: String(m.nombre || '').trim(),
      estado: String(m.estado || '').trim(),
      notas: String(m.notas || '').trim(),
      creado_en: creado
    };
    const k = clave(fecha, fila.legajo, fila.nombre);

    if (yaEstaba[k]) {
      escribirEn(hoja, yaEstaba[k], COLUMNAS_ASISTENCIA, fila);
      actualizadas++;
      return;
    }
    const nueva = [];
    for (var c = 0; c < encabezados.length; c++) nueva.push('');
    COLUMNAS_ASISTENCIA.forEach(function (campo) {
      const j = indiceColumnaCon(encabezados, campo);
      if (j !== -1) nueva[j] = fila[campo];
    });
    nuevas.push(nueva);
  });

  // Un solo setValues para todas las altas: appendRow de a una es lo que
  // hace lenta a una jornada entera de quince personas.
  if (nuevas.length) {
    hoja.getRange(hoja.getLastRow() + 1, 1, nuevas.length, encabezados.length)
      .setValues(nuevas);
  }
  SpreadsheetApp.flush();

  return jsonResponse({
    ok: true, fecha: fecha, guardadas: nuevas.length, actualizadas: actualizadas
  });
}

/**
 * Chequeo de salud: abrir la URL del Web App en el navegador debe responder ok.
 *
 * Informa además qué columnas tiene el parte diario y cuáles espera. Si
 * alguien renombra una columna a mano, lo que se cargue en ella se guarda
 * vacío sin protestar; con esto se ve de una mirada, en vez de tener que
 * deducirlo desde la pantalla.
 */
function doGet() {
  const hoja = getHojaRegistro();
  const encabezados = hoja.getLastColumn()
    ? hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0] : [];
  const faltan = COLUMNAS_REGISTRO.filter(function (c) {
    return indiceColumnaCon(encabezados, c) === -1;
  });

  return jsonResponse({
    ok: true,
    servicio: 'RVH PCP',
    hoja_ordenes: getHojaOrdenes().getName(),
    hoja_registro: CONFIG.HOJA_REGISTRO,
    empleados_activos: filasDe(getHojaEmpleados(), COLUMNAS_EMPLEADOS)
      .filter(function (e) {
        return String(e.nombre || '').trim() && String(e.activo).toUpperCase() !== 'FALSE';
      }).length,
    columnas: encabezados,
    columnas_faltantes: faltan,
    filas_registro: Math.max(0, hoja.getLastRow() - 1)
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
  if (accion === 'leer_empleados') return leerEmpleados(datos);
  if (accion === 'leer_asistencia') return leerAsistencia(datos);

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
    if (accion === 'alta_empleado') return altaEmpleado(datos);
    if (accion === 'baja_empleado') return bajaEmpleado(datos);
    if (accion === 'guardar_asistencia') return guardarAsistencia(datos);
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

    // El material llega de una lista de botones, no de un campo escrito, así
    // que no hace falta rechazarlo: lo único que importa para poder agrupar
    // por aleación es que "hierro gris" y "Hierro Gris" queden iguales.
    //
    // Antes se rechazaba lo que no estuviera en la lista, y eso obligaba a
    // republicar el script cada vez que el taller sumaba una aleación. Costaba
    // más de lo que evitaba, contra un riesgo que la propia pantalla ya cierra.
    var material = String(datos.material || '').trim().slice(0, 60);
    for (var mi = 0; mi < MATERIALES_FUNDICION.length; mi++) {
      if (normalizar(MATERIALES_FUNDICION[mi]) === normalizar(material)) {
        material = MATERIALES_FUNDICION[mi];
        break;
      }
    }

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
      material: material,
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
