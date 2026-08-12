// RVH Fundición — Núcleo del sistema de Planeamiento y Control de Producción.
// Lo comparten el Dashboard PCP (index.html) y la Carga Diaria (carga.html).
// Se expone como window.RVH para poder usarse desde un <script> plano.
window.RVH = (function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------
  const CONFIG = {
    // Lectura: CSV publicado de la planilla (solo lectura).
    CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTAruYPjhEHOipPMtNM5Npv3PrJ6U_XwOUhXSeFjejQHWH9ky5E-cKBblL1XdgOrOfK7FFIdq7gmoHk/pub?gid=296832343&single=true&output=csv',

    // Escritura: URL del Web App de Apps Script (ver README.md).
    // Sin esto, la Carga Diaria no puede guardar.
    API_URL: 'https://script.google.com/macros/s/AKfycbzoOpW-L_j5u1n4EZcULNfdwEsZAOEt3dYKqeAko_C5EYizGZpewLQZHNshH68_CXA/exec',

    // Debe coincidir con CONFIG.TOKEN en apps-script/Code.gs.
    API_TOKEN: 'rvh-pcp-2026',

    // Debe coincidir con VERSION en apps-script/Code.gs. Si la planilla
    // tiene publicada una versión anterior, los errores que devuelve no se
    // parecen a la causa real, así que se detecta y se dice explícitamente.
    API_VERSION: 6,

    REFRESH_MS: 60000,

    // Reglas de semaforización (días).
    DIAS_ESTANCADA: 30,   // 'A realizar' sin moverse => crítico
    DIAS_CRITICO: 3,      // faltan menos de N para la fecha prometida => rojo
    DIAS_ALERTA: 10       // faltan menos de N => amarillo
  };

  // Sectores con planilla diaria propia. (PROCESOS queda como alias del
  // mismo listado por compatibilidad con lo ya escrito.)
  const SECTORES = ['Carpintería', 'Moldeo', 'Fundición', 'Terminación'];
  const PROCESOS = SECTORES;
  const ESTADOS = ['A realizar', 'En proceso', 'Terminado'];

  // Recorrido productivo de un pedido. Cada fase, al marcarse, estampa su
  // fecha en la columna homónima de la planilla: eso es lo que después
  // permite medir cuánto tardó cada etapa.
  const FASES = ['Por cargar', 'Modelería', 'Moldeo', 'Colada', 'Terminación', 'Despacho', 'Entregado'];
  const FASES_CERRADAS = ['Entregado', 'Cancelado'];
  // Las seis que se estampan (todas menos "Por cargar", que es el estado inicial).
  const FASES_ESTAMPABLES = FASES.slice(1);
  // Columna de planilla donde vive la fecha de cada fase. Van prefijadas
  // porque "Moldeo" y "Terminación" ya existen como columnas de cantidad
  // por etapa (L-Q) y si compartieran nombre una pisaría a la otra.
  const columnaFase = fase => 'Fecha ' + fase;

  // Umbrales del semáforo cuando el pedido no tiene fecha comprometida:
  // se cae a la antigüedad desde el ingreso.
  const DIAS_SIN_COMPROMISO = { rojo: 30, ambar: 15 };

  // Maestro de materiales: alias tal como se escribe en planilla -> [normalizado, familia].
  // Derivado de los 239 pedidos del histórico; hace que "ASTM A48" y
  // "Hierro Fundido" cuenten como el mismo material sin perder el original.
  const MAESTRO_MATERIALES = {
    "AISI 1045": ["AISI 1045 (carbono medio)", "Acero"],
    "AISI 4120 + Si": ["AISI 4120+Si (aleado)", "Acero"],
    "ASTM 128": ["ASTM A128 (austenítico al Mn)", "Acero"],
    "ASTM 36": ["ASTM A36 (carbono estructural)", "Acero"],
    "ASTM A128": ["ASTM A128 (austenítico al Mn)", "Acero"],
    "ASTM A48": ["ASTM A48 (fundición gris)", "Hierro fundido"],
    "ASTM A532": ["ASTM A532 (blanca antiabrasiva)", "Hierro fundido"],
    "Acero": ["Acero (sin norma indicada)", "Acero"],
    "Acero 1020": ["AISI 1020 (bajo carbono)", "Acero"],
    "Acero 1045": ["AISI 1045 (carbono medio)", "Acero"],
    "Acero 4140": ["AISI 4140 (aleado bonificable)", "Acero"],
    "Acero Manganeso": ["ASTM A128 (austenítico al Mn)", "Acero"],
    "Acero SAE 1045": ["AISI 1045 (carbono medio)", "Acero"],
    "Acero SAE 4140": ["AISI 4140 (aleado bonificable)", "Acero"],
    "Acero al Manganeso": ["ASTM A128 (austenítico al Mn)", "Acero"],
    "Acero inoxidable": ["Inoxidable (sin norma indicada)", "Acero"],
    "Aluminio": ["Aluminio (sin norma indicada)", "Aluminio"],
    "Bronce": ["Bronce SAE 65", "Bronce"],
    "Bronce SAE 65": ["Bronce SAE 65", "Bronce"],
    "Bronce al aluminio": ["Bronce al aluminio", "Bronce"],
    "Fundición Gris": ["ASTM A48 (fundición gris)", "Hierro fundido"],
    "Fundición Nodular": ["ASTM A536 (nodular)", "Hierro fundido"],
    "Hierro Fundido": ["Sin norma indicada", "Hierro fundido"],
    "Hierro Nodular": ["ASTM A536 (nodular)", "Hierro fundido"],
    "Hierro gris": ["ASTM A48 (fundición gris)", "Hierro fundido"],
    "Madera": ["Modelo de madera", "Modelo (madera)"],
    "Modelo": ["Modelo de madera", "Modelo (madera)"],
    "SAE 65": ["Bronce SAE 65", "Bronce"],
    "Acero Inox 304": ["AISI 304 (inoxidable)", "Acero"],
    "Nodular": ["ASTM A536 (nodular)", "Hierro fundido"]
  };

  // Índice normalizado (sin acentos ni mayúsculas) para que la búsqueda
  // en el maestro no dependa de cómo se escribió el material ese día.
  const INDICE_MATERIALES = (() => {
    const idx = {};
    Object.keys(MAESTRO_MATERIALES).forEach(alias => {
      idx[alias.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()] = MAESTRO_MATERIALES[alias];
    });
    return idx;
  })();

  // Columnas fijas de la planilla de OTs. Las tres últimas son las que
  // suma el PCP; si todavía no existen, el sistema las tolera vacías.
  const CORE_FIELDS = [
    'OT', 'Fecha Ingreso', 'Cliente', 'Tipo', 'Mecanizado', 'Prioridad',
    'Fase de Producción', 'Status Final', 'Cantidad', 'Descripción', 'Material',
    'Fecha Prometida', 'Cantidad Completada', 'Estado',
    // Columnas del PCP. Alimentan los indicadores; si faltan, el indicador
    // correspondiente queda "No medible" en vez de mostrar un número falso.
    'Monto', 'Saldo', 'Peso', 'Fecha Entrega Real'
  ].concat(FASES_ESTAMPABLES.map(columnaFase));
  const STAGE_FIELDS = ['Diseño', 'Moldeo', 'Fundición', 'Mecanizado', 'Rechazados', 'Listos'];

  // Nombres alternativos aceptados para una misma columna.
  const CORE_FIELD_ALIASES = {
    'Cantidad': ['Cant Total', 'Cant. Total', 'Cantidad Total'],
    'Fecha Prometida': ['Fecha Entrega', 'Fecha de Entrega', 'Entrega Prometida'],
    'Cantidad Completada': ['Completadas', 'Cant Completada', 'Piezas Completadas']
  };

  // Datos de muestra: solo se usan si la planilla no responde, para que el
  // tablero nunca quede en blanco. Cubre los tres estados del semáforo.
  const DEMO_CSV = `OT,Fecha Ingreso,Cliente,Tipo,Mecanizado,Prioridad,Fase de Producción,Status Final,Cantidad,Descripción,Material,Fecha Prometida,Cantidad Completada,Estado,Monto,Saldo,Peso,Fecha Entrega Real,Fecha Modelería,Fecha Moldeo,Fecha Colada,Fecha Terminación,Fecha Despacho,Fecha Entregado
OT-3001,01/06/2026,Metalúrgica del Sur,Según Plano,SI incluye mecanizado,Urgente,,Pendiente,4,Anillo cónico rollado,Hierro Fundido,,0,,18500000,0,,,,,,,,
,,,Según Plano,NO,Urgente,,,12,Bujes de sujeción,Bronce,,,,,,,,,,,,,
OT-3002,28/07/2026,Bombas Industriales SA,Según Modelo,NO,Normal,,Pendiente,2,Carcasa de bomba,ASTM A48,06/08/2026,6,,24000000,0,180,,29/07/2026,03/08/2026,,,,
,,,Según Modelo,SI incluye mecanizado,Normal,,,2,Tapa lateral,ASTM A48,,,,,,,,,,,,,
,,,Según Modelo,NO,Normal,,,8,Prisioneros,Acero 4140,,,,,,,,,,,,,
OT-3003,15/07/2026,Talleres Ñandutí,Según Muestra,SI incluye mecanizado,Normal,,Pendiente,10,Rueda dentada,Acero Manganeso,28/07/2026,3,,9800000,0,,,16/07/2026,20/07/2026,27/07/2026,,,
OT-3004,20/07/2026,Fundiciones Guaraní,Según Muestra,NO,Urgente,,Pendiente,6,Codo de escape,Fundición Gris,11/08/2026,0,,7200000,0,,,22/07/2026,,,,,
OT-3005,25/07/2026,Agro Repuestos Paraguay,Según Plano,NO,Normal,,Pendiente,20,Eslabón de arado,Acero 1020,30/09/2026,5,,31000000,0,240,,27/07/2026,02/08/2026,,,,
OT-3006,18/06/2026,Fundiciones del Este,Según Modelo,SI incluye mecanizado,Normal,,Terminado,3,Bridas de acople,Bronce SAE 65,15/07/2026,3,,5400000,0,60,12/07/2026,19/06/2026,24/06/2026,28/06/2026,05/07/2026,10/07/2026,12/07/2026`;

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function normalize(str) {
    return (str || '')
      .toString()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toLowerCase();
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function isAffirmative(value) {
    const n = normalize(value);
    return n.startsWith('si') || n === 'true' || n === '1' || n === 'yes';
  }

  function isUrgent(value) {
    return normalize(value).includes('urgente');
  }

  function toNumber(value) {
    const trimmed = (value || '').toString().trim();
    if (trimmed === '') return null;
    const n = Number(trimmed.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  /** Acepta DD/MM/YYYY (planilla) y YYYY-MM-DD (input date). */
  function parseFecha(value) {
    const raw = (value || '').toString().trim();
    if (!raw) return null;

    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
    if (m) {
      const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /** Días enteros de `desde` a `hasta` (negativo = `hasta` ya pasó). */
  function daysBetween(desde, hasta) {
    return Math.round((startOfDay(hasta) - startOfDay(desde)) / 86400000);
  }

  function formatFecha(date) {
    if (!date) return '';
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${date.getFullYear()}`;
  }

  function hoyISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function findHeaderIndex(headers, name, fromIndex) {
    const target = normalize(name);
    for (let i = fromIndex; i < headers.length; i++) {
      if (normalize(headers[i]) === target) return i;
    }
    return -1;
  }

  function resolveCoreIndex(headers, name) {
    let idx = findHeaderIndex(headers, name, 0);
    if (idx === -1 && CORE_FIELD_ALIASES[name]) {
      for (const alias of CORE_FIELD_ALIASES[name]) {
        idx = findHeaderIndex(headers, alias, 0);
        if (idx !== -1) break;
      }
    }
    return idx;
  }

  // ---------------------------------------------------------------------
  // CSV parsing (RFC4180-ish: comillas, comas y saltos embebidos)
  // ---------------------------------------------------------------------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // BOM de Google

    const rows = [];
    let row = [], field = '', inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i + 1];
      if (inQuotes) {
        if (c === '"' && next === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else { field += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* el \n cierra la fila */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    const headers = (rows.shift() || []).map(h => h.trim());

    // Las columnas fijas se resuelven desde el inicio; las de desglose por
    // etapa, recién después de "Material" — así el "Mecanizado" numérico del
    // final no pisa al "Mecanizado" de texto (SI/NO) de las columnas fijas.
    const coreIndex = {};
    CORE_FIELDS.forEach(name => { coreIndex[name] = resolveCoreIndex(headers, name); });
    const tailStart = coreIndex['Material'] === -1 ? 0 : coreIndex['Material'] + 1;
    const stageIndex = {};
    STAGE_FIELDS.forEach(name => { stageIndex[name] = findHeaderIndex(headers, name, tailStart); });

    return rows
      .filter(r => r.some(v => v.trim() !== ''))
      .map(r => {
        const cell = i => (i === -1 || i === undefined ? '' : (r[i] ?? '').trim());
        const obj = {};
        CORE_FIELDS.forEach(name => { obj[name] = cell(coreIndex[name]); });
        obj.stages = {};
        STAGE_FIELDS.forEach(name => { obj.stages[name] = cell(stageIndex[name]); });
        return obj;
      });
  }

  /**
   * En la planilla, una OT ocupa varias filas (una por pieza) y su identidad
   * solo figura en la primera. Se completa hacia abajo.
   */
  function applyCarryOver(rows) {
    const HEREDABLES = ['OT', 'Cliente', 'Fecha Ingreso', 'Fecha Prometida', 'Status Final', 'Estado'];
    const ultimo = {};
    return rows.map(row => {
      if ((row['OT'] || '').trim()) {
        HEREDABLES.forEach(campo => { ultimo[campo] = row[campo]; });
        return row;
      }
      const heredado = {};
      HEREDABLES.forEach(campo => { heredado[campo] = ultimo[campo] || ''; });
      return Object.assign({}, row, heredado);
    });
  }

  // ---------------------------------------------------------------------
  // Modelo: una tarjeta por OT
  // ---------------------------------------------------------------------

  /**
   * El estado explícito de la planilla manda. Si la columna todavía no
   * existe, se deduce del avance para que el sistema funcione igual.
   */
  function resolverEstado(estadoCrudo, statusFinal, completada, total) {
    const e = normalize(estadoCrudo);
    if (e === 'a realizar') return 'A realizar';
    if (e === 'en proceso') return 'En proceso';
    if (e === 'terminado') return 'Terminado';

    if (normalize(statusFinal) === 'terminado') return 'Terminado';
    if (total > 0 && completada >= total) return 'Terminado';
    if (completada > 0) return 'En proceso';
    return 'A realizar';
  }

  /**
   * Semáforo de prioridad:
   *   ROJO     'A realizar' estancada +30 días, o quedan <3 días (o ya venció).
   *   AMARILLO quedan <10 días para la fecha prometida.
   *   VERDE    el resto.
   */
  function calcularSemaforo(orden, hoy) {
    const ref = hoy || new Date();

    const diasDesdeIngreso = orden.fechaIngresoDate
      ? daysBetween(orden.fechaIngresoDate, ref) : null;
    const diasParaEntrega = orden.fechaPrometidaDate
      ? daysBetween(ref, orden.fechaPrometidaDate) : null;

    // Una OT entregada no tiene urgencia: si venció, ya no importa. Marcarla
    // en rojo la pondría a encabezar la prioridad del día sin nada que hacer.
    if (orden.estado === 'Terminado') {
      return { color: 'verde', motivo: 'Entregada', diasDesdeIngreso, diasParaEntrega };
    }

    let color = 'verde';
    let motivo = 'En plazo';

    if (diasParaEntrega !== null && diasParaEntrega < CONFIG.DIAS_ALERTA) {
      color = 'amarillo';
      motivo = diasParaEntrega === 1
        ? 'Entrega en 1 día'
        : `Entrega en ${diasParaEntrega} días`;
    }

    if (orden.estado === 'A realizar' && diasDesdeIngreso !== null && diasDesdeIngreso > CONFIG.DIAS_ESTANCADA) {
      color = 'rojo';
      motivo = `Sin iniciar hace ${diasDesdeIngreso} días`;
    }

    if (diasParaEntrega !== null && diasParaEntrega < CONFIG.DIAS_CRITICO) {
      color = 'rojo';
      if (diasParaEntrega < 0) {
        motivo = `Vencida hace ${Math.abs(diasParaEntrega)} día${Math.abs(diasParaEntrega) === 1 ? '' : 's'}`;
      } else if (diasParaEntrega === 0) {
        motivo = 'Vence hoy';
      } else {
        motivo = `Vence en ${diasParaEntrega} día${diasParaEntrega === 1 ? '' : 's'}`;
      }
    }

    return { color, motivo, diasDesdeIngreso, diasParaEntrega };
  }

  /**
   * Colapsa las variantes con que se escribe un material ("ASTM A48",
   * "Hierro Fundido", "Fundición Gris") en uno solo, conservando siempre
   * cómo estaba escrito originalmente para no perder el dato de origen.
   */
  function normalizarMaterial(crudo) {
    const raw = (crudo || '').trim();
    const hit = INDICE_MATERIALES[normalize(raw)];
    return {
      raw,
      normalizado: hit ? hit[0] : (raw || 'Sin especificar'),
      familia: hit ? hit[1] : (raw ? 'Sin clasificar' : 'Sin especificar'),
      conocido: !!hit
    };
  }

  /**
   * Semáforo del tablero PCP:
   *   con fecha comprometida -> vencido / por vencer / en plazo contra ella
   *   sin fecha comprometida -> se cae a la antigüedad desde el ingreso
   * Un pedido cerrado no tiene urgencia.
   */
  function semaforoPCP(pedido, hoy) {
    const ref = hoy || new Date();
    if (pedido.cerrado) return { color: 'n', texto: '—', dias: null };

    if (pedido.fechaPrometidaDate) {
      const faltan = daysBetween(ref, pedido.fechaPrometidaDate);
      if (faltan < 0) return { color: 'r', texto: 'Vencido', dias: faltan };
      if (faltan <= 7) return { color: 'a', texto: 'Por vencer', dias: faltan };
      return { color: 'v', texto: 'En plazo', dias: faltan };
    }

    const edad = pedido.fechaIngresoDate ? daysBetween(pedido.fechaIngresoDate, ref) : null;
    if (edad == null) return { color: 'n', texto: '—', dias: null };
    if (edad > DIAS_SIN_COMPROMISO.rojo) return { color: 'r', texto: 'Vencido', dias: edad };
    if (edad > DIAS_SIN_COMPROMISO.ambar) return { color: 'a', texto: 'Por vencer', dias: edad };
    return { color: 'v', texto: 'En plazo', dias: edad };
  }

  /** Antigüedad en días desde el ingreso. */
  function antiguedad(pedido, hoy) {
    if (!pedido.fechaIngresoDate) return null;
    return daysBetween(pedido.fechaIngresoDate, hoy || new Date());
  }

  /**
   * Los nueve indicadores. Devuelven `null` cuando faltan los datos que los
   * alimentan: eso se muestra como "No medible" y es deliberado — un
   * indicador que no se puede calcular informa qué falta cargar, mientras
   * que un cero inventado miente.
   */
  function metricas(pedidos, hoy) {
    const ref = hoy || new Date();
    const P = pedidos || [];
    const pend = P.filter(p => !p.cerrado);
    const ent = P.filter(p => p.fase === 'Entregado');

    const edades = pend.map(p => antiguedad(p, ref)).filter(d => d != null);
    const conCompromiso = P.filter(p => p.fechaPrometidaDate);
    const entMedibles = ent.filter(p => p.fechaEntregaRealDate && p.fechaPrometidaDate);
    const entConCierre = ent.filter(p => p.fechaEntregaRealDate && p.fechaIngresoDate);
    const conRech = P.filter(p => p.rechazados != null && p.cantidadTotal > 0);
    const camposDe = p => ['fechaPrometidaDate', 'fechaEntregaRealDate', 'peso']
      .filter(k => p[k] != null && p[k] !== '').length;

    const suma = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

    return {
      total: P.length,
      pend: pend.length,
      ent: ent.length,
      piezas: suma(pend, p => p.cantidadTotal),
      monto: suma(pend, p => p.monto),
      saldoEnt: suma(ent, p => p.saldo),

      edadProm: edades.length ? Math.round(edades.reduce((a, b) => a + b, 0) / edades.length) : null,
      edadMax: edades.length ? Math.max.apply(null, edades) : null,
      vencidos: pend.filter(p => p.semaforoPCP.color === 'r').length,
      porVencer: pend.filter(p => p.semaforoPCP.color === 'a').length,

      backlogVencido: pend.length
        ? pend.filter(p => (antiguedad(p, ref) || 0) > DIAS_SIN_COMPROMISO.rojo).length / pend.length
        : null,

      otd: entMedibles.length
        ? entMedibles.filter(p => p.fechaEntregaRealDate <= p.fechaPrometidaDate).length / entMedibles.length
        : null,
      otdN: entMedibles.length,

      lead: entConCierre.length
        ? Math.round(suma(entConCierre, p => daysBetween(p.fechaIngresoDate, p.fechaEntregaRealDate)) / entConCierre.length)
        : null,
      leadN: entConCierre.length,

      cobertura: P.length ? conCompromiso.length / P.length : null,

      rechazo: conRech.length
        ? suma(conRech, p => p.rechazados) / suma(conRech, p => p.cantidadTotal)
        : null,
      rechazoN: conRech.length,

      completitud: P.length ? suma(P, camposDe) / (P.length * 3) : null
    };
  }

  /** Agrupa y ordena por volumen: sirve para concentración por cliente o material. */
  function concentracion(pedidos, clave, valor) {
    const mapa = new Map();
    pedidos.forEach(p => {
      const k = clave(p) || 'Sin especificar';
      mapa.set(k, (mapa.get(k) || 0) + (valor(p) || 0));
    });
    const total = Array.from(mapa.values()).reduce((a, b) => a + b, 0);
    return Array.from(mapa.entries())
      .map(([nombre, v]) => ({ nombre, valor: v, parte: total ? v / total : 0 }))
      .sort((a, b) => b.valor - a.valor);
  }

  const PESO_SEMAFORO = { rojo: 0, amarillo: 1, verde: 2 };

  /** Rojos siempre primero; dentro de cada color, lo más urgente arriba. */
  function ordenarPorPrioridad(ordenes) {
    return ordenes.slice().sort((a, b) => {
      const peso = PESO_SEMAFORO[a.semaforo.color] - PESO_SEMAFORO[b.semaforo.color];
      if (peso !== 0) return peso;

      // Con fecha prometida primero, y la más próxima antes.
      const da = a.semaforo.diasParaEntrega;
      const db = b.semaforo.diasParaEntrega;
      if (da !== null && db !== null && da !== db) return da - db;
      if (da !== null && db === null) return -1;
      if (da === null && db !== null) return 1;

      // Sin fecha, la que lleva más tiempo esperando.
      return (b.semaforo.diasDesdeIngreso || 0) - (a.semaforo.diasDesdeIngreso || 0);
    });
  }

  function groupOrders(rows, hoy) {
    const filled = applyCarryOver(rows);
    const map = new Map();

    filled.forEach(row => {
      const otNumber = (row['OT'] || '').trim();
      if (!otNumber) return;

      if (!map.has(otNumber)) {
        map.set(otNumber, {
          otNumber,
          cliente: row['Cliente'] || 'Sin cliente',
          fechaIngresoRaw: (row['Fecha Ingreso'] || '').trim(),
          fechaIngresoDate: parseFecha(row['Fecha Ingreso']),
          fechaPrometidaRaw: (row['Fecha Prometida'] || '').trim(),
          fechaPrometidaDate: parseFecha(row['Fecha Prometida']),
          estadoCrudo: row['Estado'] || '',
          statusFinal: row['Status Final'] || '',
          montoCrudo: toNumber(row['Monto']),
          saldoCrudo: toNumber(row['Saldo']),
          pesoCrudo: toNumber(row['Peso']),
          fechaEntregaRealRaw: (row['Fecha Entrega Real'] || '').trim(),
          fasesCrudas: (() => {
            const f = {};
            FASES_ESTAMPABLES.forEach(n => { f[n] = row[columnaFase(n)] || ''; });
            return f;
          })(),
          // El avance vive en la fila cabecera de la OT (la que trae el número).
          completadaCruda: toNumber(row['Cantidad Completada']),
          tipoSet: new Set(),
          urgent: false,
          machining: false,
          items: []
        });
      }

      const order = map.get(otNumber);
      if (row['Tipo']) order.tipoSet.add(row['Tipo']);
      if (isUrgent(row['Prioridad'])) order.urgent = true;
      if (isAffirmative(row['Mecanizado'])) order.machining = true;

      const stages = {};
      STAGE_FIELDS.forEach(name => { stages[name] = toNumber(row.stages[name]); });

      order.items.push({
        cantidad: row['Cantidad'] || '',
        cantidadNum: toNumber(row['Cantidad']),
        descripcion: row['Descripción'] || '',
        material: row['Material'] || '',
        stages
      });
    });

    const ordenes = Array.from(map.values()).map(order => {
      const cantidadTotal = order.items.reduce((s, i) => s + (i.cantidadNum || 0), 0);

      // Si "Cantidad Completada" aún no se usa, se cae a la columna "Listos"
      // que el taller ya venía cargando por pieza.
      const listos = order.items.reduce((s, i) => s + (i.stages['Listos'] || 0), 0);
      const cantidadCompletada = order.completadaCruda !== null ? order.completadaCruda : listos;
      // Ojo con la diferencia entre "cero rechazos" y "nadie registró
      // rechazos": si ningún ítem trae el dato queda null, para que la tasa
      // de rechazo salga "No medible" en vez de un 0% que aparenta calidad
      // perfecta.
      const itemsConRechazo = order.items.filter(i => i.stages['Rechazados'] != null);
      const rechazados = itemsConRechazo.length
        ? itemsConRechazo.reduce((s, i) => s + i.stages['Rechazados'], 0)
        : null;

      const estado = resolverEstado(order.estadoCrudo, order.statusFinal, cantidadCompletada, cantidadTotal);

      // Fases estampadas: {fase: 'DD/MM/AAAA'}. La fase actual es la última
      // con fecha; sin ninguna, el pedido está "Por cargar".
      const fechasFase = {};
      FASES_ESTAMPABLES.forEach(f => {
        const v = (order.fasesCrudas[f] || '').trim();
        if (v) fechasFase[f] = v;
      });
      const marcadas = FASES_ESTAMPABLES.filter(f => fechasFase[f]);
      const fase = marcadas.length ? marcadas[marcadas.length - 1] : 'Por cargar';

      const modelo = {
        otNumber: order.otNumber,
        cliente: order.cliente,
        tipoOrigen: Array.from(order.tipoSet).filter(Boolean).join(' / ') || 'N/D',
        urgent: order.urgent,
        machining: order.machining,
        items: order.items,
        piezasDescripcion: order.items.map(i => i.descripcion).filter(Boolean).join(', '),
        materiales: Array.from(new Set(order.items.map(i => i.material).filter(Boolean))).join(' / '),
        fechaIngreso: order.fechaIngresoRaw,
        fechaIngresoDate: order.fechaIngresoDate,
        fechaPrometida: order.fechaPrometidaRaw,
        fechaPrometidaDate: order.fechaPrometidaDate,
        cantidadTotal,
        cantidadCompletada,
        rechazados,
        estado,
        activa: estado !== 'Terminado',
        faltantes: Math.max(0, cantidadTotal - cantidadCompletada),
        avance: cantidadTotal > 0
          ? Math.min(100, Math.round((cantidadCompletada / cantidadTotal) * 100))
          : 0,

        // --- Modelo PCP -------------------------------------------------
        fase,
        fechasFase,
        cerrado: FASES_CERRADAS.indexOf(fase) !== -1,
        material: normalizarMaterial(order.items.length ? order.items[0].material : ''),
        monto: order.montoCrudo,
        saldo: order.saldoCrudo,
        peso: order.pesoCrudo,
        fechaEntregaReal: order.fechaEntregaRealRaw,
        fechaEntregaRealDate: parseFecha(order.fechaEntregaRealRaw)
      };

      modelo.semaforo = calcularSemaforo(modelo, hoy);
      // Semáforo del PCP: prioriza la fecha comprometida y, sin ella, cae a
      // la antigüedad. Va aparte de `semaforo` para no alterar lo que ya
      // consume carga.html.
      modelo.semaforoPCP = semaforoPCP(modelo, hoy);
      return modelo;
    });

    const conFases = aplicarFasesPendientes(ordenes);
    conFases.forEach(p => { p.semaforoPCP = semaforoPCP(p, hoy); });
    return aplicarAvancePendiente(conFases);
  }

  // ---------------------------------------------------------------------
  // Avance optimista
  // ---------------------------------------------------------------------
  // El CSV publicado tarda unos minutos en reflejar lo que escribe el Apps
  // Script. Para que el Dashboard muestre la carga recién hecha al instante,
  // se guarda el valor devuelto por la API y se usa hasta que el CSV lo
  // alcanza (ahí se descarta solo).
  const PENDING_KEY = 'rvh_avance_pendiente';
  const PENDING_FASES_KEY = 'rvh_fases_pendientes';

  function leerFasesPendientes() {
    try {
      return JSON.parse(localStorage.getItem(PENDING_FASES_KEY) || '{}');
    } catch (err) {
      return {};
    }
  }

  function guardarFasePendiente(otNumber, fase, fecha) {
    try {
      const pend = leerFasesPendientes();
      if (!pend[otNumber]) pend[otNumber] = {};
      pend[otNumber][fase] = { fecha, ts: Date.now() };
      localStorage.setItem(PENDING_FASES_KEY, JSON.stringify(pend));
    } catch (err) { /* no crítico */ }
  }

  /**
   * Igual que el avance: la fase recién marcada se muestra al instante y se
   * descarta sola cuando el CSV publicado la trae (o a las 24 h).
   */
  function aplicarFasesPendientes(pedidos) {
    const pend = leerFasesPendientes();
    if (!Object.keys(pend).length) return pedidos;

    const LIMITE_MS = 24 * 60 * 60 * 1000;
    let cambio = false;

    pedidos.forEach(p => {
      const marcas = pend[p.otNumber];
      if (!marcas) return;

      Object.keys(marcas).forEach(fase => {
        const m = marcas[fase];
        if (p.fechasFase[fase] || (Date.now() - m.ts) > LIMITE_MS) {
          delete marcas[fase];
          cambio = true;
          return;
        }
        p.fechasFase[fase] = m.fecha;
        p.fasePendiente = true;
      });

      if (!Object.keys(marcas).length) { delete pend[p.otNumber]; cambio = true; }

      // La fase actual se recalcula: es la última marcada del recorrido.
      const marcadas = FASES_ESTAMPABLES.filter(f => p.fechasFase[f]);
      p.fase = marcadas.length ? marcadas[marcadas.length - 1] : 'Por cargar';
      p.cerrado = FASES_CERRADAS.indexOf(p.fase) !== -1;
    });

    if (cambio) {
      try { localStorage.setItem(PENDING_FASES_KEY, JSON.stringify(pend)); } catch (err) { /* noop */ }
    }
    return pedidos;
  }

  function leerPendientes() {
    try {
      return JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
    } catch (err) {
      return {};
    }
  }

  function guardarAvancePendiente(otNumber, cantidadCompletada) {
    try {
      const pend = leerPendientes();
      pend[otNumber] = { cantidad: cantidadCompletada, ts: Date.now() };
      localStorage.setItem(PENDING_KEY, JSON.stringify(pend));
    } catch (err) { /* localStorage lleno o bloqueado: no es crítico */ }
  }

  function aplicarAvancePendiente(ordenes) {
    const pend = leerPendientes();
    if (!Object.keys(pend).length) return ordenes;

    const LIMITE_MS = 24 * 60 * 60 * 1000;
    let cambio = false;

    ordenes.forEach(orden => {
      const p = pend[orden.otNumber];
      if (!p) return;

      // El CSV ya se puso al día (o el dato quedó viejo): se descarta.
      if (orden.cantidadCompletada >= p.cantidad || (Date.now() - p.ts) > LIMITE_MS) {
        delete pend[orden.otNumber];
        cambio = true;
        return;
      }

      orden.cantidadCompletada = p.cantidad;
      orden.faltantes = Math.max(0, orden.cantidadTotal - p.cantidad);
      orden.avance = orden.cantidadTotal > 0
        ? Math.min(100, Math.round((p.cantidad / orden.cantidadTotal) * 100))
        : 0;
      orden.avancePendiente = true;
    });

    if (cambio) {
      try { localStorage.setItem(PENDING_KEY, JSON.stringify(pend)); } catch (err) { /* noop */ }
    }
    return ordenes;
  }

  // ---------------------------------------------------------------------
  // Acceso a datos
  // ---------------------------------------------------------------------
  // Cuánto se espera antes de darse por vencido. Sin esto un pedido que se
  // cuelga deja la pantalla en "Cargando" para siempre y la única salida es
  // recargar a mano, que es justo lo que pasaba en el taller.
  const TIMEOUT_LECTURA_MS = 20000;
  const TIMEOUT_ESCRITURA_MS = 25000;

  const esperar = ms => new Promise(r => setTimeout(r, ms));

  /**
   * fetch que se rinde solo. Traduce el corte a un mensaje que se entienda:
   * "AbortError" no le dice nada a nadie en la planta.
   */
  async function fetchConTimeout(url, opciones, ms, quien) {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, Object.assign({ signal: ctrl.signal }, opciones));
    } catch (err) {
      if (err.name === 'AbortError') {
        const agotado = new Error(quien + ' no respondió en ' + Math.round(ms / 1000) +
          ' segundos. Puede ser la señal: probá de nuevo.');
        // Que se haya agotado el tiempo significa que del otro lado hay
        // alguien, pero lento. Reintentar solo duplica la espera y le suma
        // trabajo a un servidor que ya viene ahogado: mejor avisar ahora.
        agotado.definitivo = true;
        throw agotado;
      }
      // Sin conexión, fetch tira un TypeError pelado ("Failed to fetch" /
      // "Load failed" según el navegador). En el taller eso no le dice nada
      // a nadie: lo que hace falta saber es que hay que mirar la señal.
      if (err instanceof TypeError) {
        throw new Error('No se pudo conectar con ' + quien.toLowerCase() +
          '. Revisá la conexión y probá de nuevo.');
      }
      throw err;
    } finally {
      clearTimeout(reloj);
    }
  }

  async function fetchCSVText(url) {
    const res = await fetchConTimeout(url, { cache: 'no-store' },
      TIMEOUT_LECTURA_MS, 'La planilla');
    if (!res.ok) throw new Error(`No se pudo obtener la planilla (HTTP ${res.status})`);
    return res.text();
  }

  /** Carga y arma todas las OTs, ya ordenadas por prioridad. */
  async function cargarOrdenes() {
    try {
      const text = await fetchCSVText(CONFIG.CSV_URL);
      return { ordenes: ordenarPorPrioridad(groupOrders(parseCSV(text))), demo: false };
    } catch (err) {
      return {
        ordenes: ordenarPorPrioridad(groupOrders(parseCSV(DEMO_CSV))),
        demo: true,
        error: err.message
      };
    }
  }

  /**
   * Registra una carga diaria en la planilla vía Apps Script.
   *
   * Se manda como text/plain a propósito: con application/json el navegador
   * dispara un preflight OPTIONS que Apps Script no responde, y la petición
   * falla por CORS.
   */
  // Acciones que solo leen: se pueden repetir sin consecuencias.
  const ACCIONES_LECTURA = ['leer_dia', 'leer_registro'];

  async function enviar(cuerpo) {
    if (!CONFIG.API_URL) {
      throw new Error(
        'Todavía no se puede guardar: falta publicar el Apps Script de la planilla. ' +
        'En la planilla: Extensiones → Apps Script → Implementar → Nueva implementación → ' +
        'Aplicación web (ejecutar como "Yo", acceso "Cualquier usuario"). ' +
        'Después pegá la URL que termina en /exec en CONFIG.API_URL de shared.js.'
      );
    }

    const accion = cuerpo.accion || 'carga_diaria';
    const esLectura = ACCIONES_LECTURA.indexOf(accion) !== -1;

    // Apps Script arranca en frío seguido y a veces devuelve un 5xx pasajero.
    // Una lectura se reintenta porque repetirla no cuesta nada; una carga o
    // un borrado NO, porque reintentar podría duplicar la tanda o borrar de
    // más sin que nadie se entere.
    const intentos = esLectura ? 2 : 1;
    const ms = esLectura ? TIMEOUT_LECTURA_MS : TIMEOUT_ESCRITURA_MS;

    var ultimoError;
    for (var i = 0; i < intentos; i++) {
      if (i) await esperar(2000);
      try {
        return await enviarUnaVez(cuerpo, ms);
      } catch (err) {
        // El script contestó y dijo que no: repetirlo va a dar lo mismo.
        if (err.definitivo) throw err;
        ultimoError = err;
      }
    }
    throw ultimoError;
  }

  async function enviarUnaVez(cuerpo, ms) {
    const res = await fetchConTimeout(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: CONFIG.API_TOKEN }, cuerpo))
    }, ms, 'La planilla');

    if (!res.ok) {
      const err = new Error(`El servidor respondió ${res.status}.`);
      // Un 4xx no se arregla repitiendo; un 5xx suele ser pasajero.
      err.definitivo = res.status < 500;
      throw err;
    }

    const json = await res.json();

    // Un script publicado viejo devuelve errores que no se parecen a la
    // causa (ej. "Falta la OT." al pedir la producción del día). No se
    // bloquea por eso: si la respuesta vino bien, se usa igual. Solo si
    // falla se agrega la explicación de qué actualizar.
    const desactualizado = !json.version || json.version < CONFIG.API_VERSION;

    if (!json.ok) {
      var detalle = json.error || 'No se pudo guardar.';
      if (desactualizado) {
        detalle += ' — Probablemente sea porque el script publicado en la planilla ' +
          'está desactualizado (' + (json.version ? 'v' + json.version : 'sin versión') +
          ', se necesita v' + CONFIG.API_VERSION + '). Abrí la URL del Web App en el ' +
          'navegador: si no dice "version":' + CONFIG.API_VERSION + ', hay que volver a ' +
          'pegar Code.gs, guardar con Ctrl+S y publicar con el lápiz ✏️ de la ' +
          'implementación existente eligiendo Versión: "Nueva versión".';
      }
      const err = new Error(detalle);
      // El script se expresó. Repetir el pedido va a dar exactamente lo mismo,
      // salvo cuando dice que está ocupado: eso sí se destraba solo.
      err.definitivo = !/ocupado/i.test(json.error || '');
      throw err;
    }

    return json;
  }

  async function registrarCargaDiaria(datos) {
    const json = await enviar(Object.assign({ accion: 'carga_diaria' }, datos));
    // Solo hay avance que reflejar si la carga se asoció a una OT.
    if (json.id_ot && json.cantidad_completada != null) {
      guardarAvancePendiente(json.id_ot, json.cantidad_completada);
    }
    return json;
  }

  /**
   * Sugiere OTs a partir del nombre de la pieza. En la planilla de papel no
   * figura el número de OT: lo que se anota es la pieza ("Travesaño
   * liviano"), y alguien lo cruza después. Esto hace ese cruce en el momento,
   * sin obligar al operario a saber el número.
   */
  function sugerirOT(textoPieza, ordenes) {
    const q = normalize(textoPieza);
    if (q.length < 3) return [];

    const palabras = q.split(/\s+/).filter(p => p.length >= 3);
    if (!palabras.length) return [];

    return ordenes
      .filter(o => !o.cerrado)
      .map(o => {
        const heno = normalize(o.piezasDescripcion + ' ' + o.cliente);
        // Cuenta cuántas palabras de la pieza aparecen en el pedido: así
        // "travesaño liviano" pesa más que un pedido que solo dice "travesaño".
        const aciertos = palabras.filter(p => heno.includes(p)).length;
        return { orden: o, aciertos };
      })
      .filter(x => x.aciertos > 0)
      .sort((a, b) => b.aciertos - a.aciertos)
      .slice(0, 5)
      .map(x => x.orden);
  }

  /** Trae todas las tandas cargadas en una fecha, de todos los sectores. */
  async function leerDia(fecha) {
    const json = await enviar({ accion: 'leer_dia', fecha: fecha || hoyISO() });
    return json.filas || [];
  }

  /** Registro histórico: tandas desde una fecha, más nuevas primero. */
  async function leerRegistro(desde, sector) {
    const json = await enviar({ accion: 'leer_registro', desde: desde || '', sector: sector || '' });
    return json.filas || [];
  }

  /** Borra tandas del parte diario por id. */
  async function borrarRegistro(ids) {
    const json = await enviar({ accion: 'borrar_registro', ids: ids });
    return json.borradas || 0;
  }

  /** Estampa la fecha de una fase en la OT. Sin fecha, usa hoy. */
  async function marcarFase(otNumber, fase, fecha) {
    if (FASES_ESTAMPABLES.indexOf(fase) === -1) {
      throw new Error('Fase desconocida: ' + fase);
    }
    const usada = fecha || hoyISO();
    const json = await enviar({ accion: 'marcar_fase', id_ot: otNumber, fase, fecha: usada });
    guardarFasePendiente(otNumber, fase, json.fecha || usada);
    return json;
  }

  // ---------------------------------------------------------------------
  // UI compartida
  // ---------------------------------------------------------------------
  const SEMAFORO_UI = {
    rojo: {
      etiqueta: 'CRÍTICO',
      punto: 'bg-red-500',
      chip: 'bg-red-50 text-red-700 border-red-300',
      borde: 'border-l-4 border-l-red-500'
    },
    amarillo: {
      etiqueta: 'ALERTA',
      punto: 'bg-amber-500',
      chip: 'bg-amber-50 text-amber-700 border-amber-300',
      borde: 'border-l-4 border-l-amber-500'
    },
    verde: {
      etiqueta: 'A TIEMPO',
      punto: 'bg-emerald-500',
      chip: 'bg-emerald-50 text-emerald-700 border-emerald-300',
      borde: 'border-l-4 border-l-emerald-500'
    }
  };

  function badge(text, classes) {
    const span = document.createElement('span');
    span.className = `inline-flex items-center px-2 py-1 rounded-md text-[11px] font-bold border ${classes}`;
    span.textContent = text;
    return span;
  }

  return {
    CONFIG,
    PROCESOS,
    SECTORES,
    sugerirOT,
    ESTADOS,
    FASES,
    FASES_ESTAMPABLES,
    FASES_CERRADAS,
    columnaFase,
    MAESTRO_MATERIALES,
    normalizarMaterial,
    semaforoPCP,
    antiguedad,
    metricas,
    concentracion,
    marcarFase,
    leerDia,
    leerRegistro,
    borrarRegistro,
    DEMO_CSV,
    SEMAFORO_UI,
    normalize,
    debounce,
    parseCSV,
    parseFecha,
    formatFecha,
    hoyISO,
    daysBetween,
    groupOrders,
    calcularSemaforo,
    ordenarPorPrioridad,
    cargarOrdenes,
    registrarCargaDiaria,
    guardarAvancePendiente,
    badge
  };
})();
