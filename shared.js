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
    API_URL: '',

    // Debe coincidir con CONFIG.TOKEN en apps-script/Code.gs.
    API_TOKEN: 'rvh-pcp-2026',

    REFRESH_MS: 60000,

    // Reglas de semaforización (días).
    DIAS_ESTANCADA: 30,   // 'A realizar' sin moverse => crítico
    DIAS_CRITICO: 3,      // faltan menos de N para la fecha prometida => rojo
    DIAS_ALERTA: 10       // faltan menos de N => amarillo
  };

  const PROCESOS = ['Carpintería', 'Moldeo', 'Fundición', 'Terminación'];
  const ESTADOS = ['A realizar', 'En proceso', 'Terminado'];

  // Columnas fijas de la planilla de OTs. Las tres últimas son las que
  // suma el PCP; si todavía no existen, el sistema las tolera vacías.
  const CORE_FIELDS = [
    'OT', 'Fecha Ingreso', 'Cliente', 'Tipo', 'Mecanizado', 'Prioridad',
    'Fase de Producción', 'Status Final', 'Cantidad', 'Descripción', 'Material',
    'Fecha Prometida', 'Cantidad Completada', 'Estado'
  ];
  const STAGE_FIELDS = ['Diseño', 'Moldeo', 'Fundición', 'Mecanizado', 'Rechazados', 'Listos'];

  // Nombres alternativos aceptados para una misma columna.
  const CORE_FIELD_ALIASES = {
    'Cantidad': ['Cant Total', 'Cant. Total', 'Cantidad Total'],
    'Fecha Prometida': ['Fecha Entrega', 'Fecha de Entrega', 'Entrega Prometida'],
    'Cantidad Completada': ['Completadas', 'Cant Completada', 'Piezas Completadas']
  };

  // Datos de muestra: solo se usan si la planilla no responde, para que el
  // tablero nunca quede en blanco. Cubre los tres estados del semáforo.
  const DEMO_CSV = `OT,Fecha Ingreso,Cliente,Tipo,Mecanizado,Prioridad,Fase de Producción,Status Final,Cantidad,Descripción,Material,Fecha Prometida,Cantidad Completada,Estado
OT-3001,01/06/2026,Metalúrgica del Sur,Según Plano,SI incluye mecanizado,Urgente,Diseño,Pendiente,4,Anillo cónico rollado,Acero Especial,,0,A realizar
,,,Según Plano,NO,Urgente,Diseño,,12,Bujes de sujeción,Bronce,,,
OT-3002,28/07/2026,Bombas Industriales SA,Según Modelo,NO,Normal,Moldeo,Pendiente,2,Carcasa de bomba,Hierro Gris,06/08/2026,6,En proceso
,,,Según Modelo,SI incluye mecanizado,Normal,Colada,,2,Tapa lateral,Hierro Gris,,,
,,,Según Modelo,NO,Normal,Moldeo,,8,Prisioneros,Acero Especial,,,
OT-3003,15/07/2026,Talleres Ñandutí,Según Muestra,SI incluye mecanizado,Normal,Mecanizado,Pendiente,10,Rueda dentada,Acero Especial,28/07/2026,3,En proceso
OT-3004,20/07/2026,Fundiciones Guaraní,Según Muestra,NO,Urgente,Diseño,Pendiente,6,Codo de escape,Hierro Gris,11/08/2026,0,A realizar
OT-3005,25/07/2026,Agro Repuestos Paraguay,Según Plano,NO,Normal,Mecanizado,Pendiente,20,Eslabón de arado,Acero Especial,30/09/2026,5,En proceso
OT-3006,18/06/2026,Fundiciones del Este,Según Modelo,SI incluye mecanizado,Normal,,Terminado,3,Bridas de acople,Bronce,15/07/2026,3,Terminado`;

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
      const rechazados = order.items.reduce((s, i) => s + (i.stages['Rechazados'] || 0), 0);

      const estado = resolverEstado(order.estadoCrudo, order.statusFinal, cantidadCompletada, cantidadTotal);

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
          : 0
      };

      modelo.semaforo = calcularSemaforo(modelo, hoy);
      return modelo;
    });

    return aplicarAvancePendiente(ordenes);
  }

  // ---------------------------------------------------------------------
  // Avance optimista
  // ---------------------------------------------------------------------
  // El CSV publicado tarda unos minutos en reflejar lo que escribe el Apps
  // Script. Para que el Dashboard muestre la carga recién hecha al instante,
  // se guarda el valor devuelto por la API y se usa hasta que el CSV lo
  // alcanza (ahí se descarta solo).
  const PENDING_KEY = 'rvh_avance_pendiente';

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
  async function fetchCSVText(url) {
    const res = await fetch(url, { cache: 'no-store' });
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
  async function registrarCargaDiaria(datos) {
    if (!CONFIG.API_URL) {
      throw new Error('Falta configurar CONFIG.API_URL en shared.js (ver README.md).');
    }

    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: CONFIG.API_TOKEN }, datos))
    });

    if (!res.ok) throw new Error(`El servidor respondió ${res.status}.`);

    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo guardar el registro.');

    guardarAvancePendiente(json.id_ot, json.cantidad_completada);
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
    ESTADOS,
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
