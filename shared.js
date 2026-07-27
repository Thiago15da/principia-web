// Lógica compartida entre index.html (portal de cliente) y fabrica.html
// (panel interno). Se expone como window.RVH para poder usarla desde un
// <script> plano en cada página, sin necesidad de un bundler.
window.RVH = (function () {
  'use strict';

  // ---------------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------------
  const CONFIG = {
    CSV_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTAruYPjhEHOipPMtNM5Npv3PrJ6U_XwOUhXSeFjejQHWH9ky5E-cKBblL1XdgOrOfK7FFIdq7gmoHk/pub?gid=296832343&single=true&output=csv',
    REFRESH_MS: 60000,
    DIAS_ALERTA: 15
  };

  const TABS = [
    { id: 'pendiente', label: '📋 Trabajos Pendientes / En Curso' },
    { id: 'terminado', label: '✅ Trabajos Terminados' }
  ];

  // Columnas A-K (fijas, nunca cambian de significado) y columnas
  // opcionales que pueden aparecer al final de la planilla (L-Q) con el
  // desglose de cantidad por etapa. "Mecanizado" se repite a propósito:
  // en A-K es texto (SI/NO), acá es un número de piezas en esa etapa.
  const CORE_FIELDS = ['OT', 'Fecha Ingreso', 'Cliente', 'Tipo', 'Mecanizado', 'Prioridad', 'Fase de Producción', 'Status Final', 'Cantidad', 'Descripción', 'Material'];
  const STAGE_FIELDS = ['Diseño', 'Moldeo', 'Fundición', 'Mecanizado', 'Rechazados', 'Listos'];
  // Columna opcional de código de cliente (además del nombre en
  // "Cliente"), usada para el matcheo estricto de ?cliente=. No forma
  // parte de A-K; si la planilla no la tiene, simplemente queda vacía.
  const OPTIONAL_ID_FIELD = 'ID_Cliente';
  // Algunas planillas nombran la columna de cantidad distinto; si no se
  // encuentra "Cantidad" tal cual, se prueban estos alias en orden.
  const CORE_FIELD_ALIASES = { 'Cantidad': ['Cant Total', 'Cant. Total', 'Cantidad Total'] };

  // Datos de muestra usados solo si la planilla real no responde. Incluye
  // filas de continuación con OT/Cliente/Fecha Ingreso/Status Final en
  // blanco (carry-over), y desgloses por etapa en algunas filas.
  const DEMO_CSV = `OT,Fecha Ingreso,Cliente,Tipo,Mecanizado,Prioridad,Fase de Producción,Status Final,Cantidad,Descripción,Material,Diseño,Moldeo,Fundición,Mecanizado,Rechazados,Listos
OT-3001,01/07/2026,Metalúrgica del Sur,Según Plano,SI incluye mecanizado,Urgente,Diseño,Pendiente,4,Anillo cónico rollado,Acero Especial,1,1,0,0,1,1
,,,Según Plano,NO,Urgente,Diseño,,12,Bujes de sujeción,Bronce
OT-3002,28/06/2026,Bombas Industriales SA,Según Modelo,NO,Normal,Moldeo,Pendiente,2,Carcasa de bomba,Hierro Gris,0,0,1,0,0,1
,,,Según Modelo,SI incluye mecanizado,Normal,Colada,,2,Tapa lateral,Hierro Gris
,,,Según Modelo,NO,Normal,Moldeo,,8,Prisioneros,Acero Especial
OT-3003,15/07/2026,Talleres Ñandutí,Según Muestra,SI incluye mecanizado,Normal,Mecanizado,Pendiente,1,Rueda dentada,Acero Especial
OT-3004,10/07/2026,Fundiciones Guaraní,Según Muestra,NO,Urgente,Diseño,Pendiente,6,Codo de escape,Hierro Gris
OT-3005,05/07/2026,Agro Repuestos Paraguay,Según Plano,NO,Normal,Mecanizado,Terminado,20,Eslabón de arado,Acero Especial
,,,Según Plano,NO,Normal,Colada,,5,Contrapesos,Hierro Gris
OT-3006,18/06/2026,Fundiciones del Este,Según Modelo,SI incluye mecanizado,Normal,,Terminado,3,Bridas de acople,Bronce`;

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

  // Clave de comparación para el portal de cliente: sin acentos, espacios
  // ni caracteres especiales, para que "Kove" o "kove s.a." matcheen igual.
  function normalizeClientKey(value) {
    return normalize(value).replace(/[^a-z0-9]/g, '');
  }

  // Sanitización para comparación EXACTA (?cliente=, código admin): solo
  // minúsculas + trim, sin tocar guiones ni otros caracteres — a
  // diferencia de normalizeClientKey, acá "abc-1" y "abc1" NO deben
  // considerarse iguales.
  function sanitizeExact(value) {
    return (value || '').toString().trim().toLowerCase();
  }

  function toNumber(value) {
    const trimmed = (value || '').toString().trim();
    if (trimmed === '') return null;
    const n = Number(trimmed.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function parseDDMMYYYY(value) {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((value || '').trim());
    if (!m) return null;
    const date = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function daysSince(date) {
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffMs = startOfDay(new Date()) - startOfDay(date);
    return Math.round(diffMs / 86400000);
  }

  // Busca el índice de un encabezado por nombre (sin distinguir
  // acentos/mayúsculas), desde una posición de la fila en adelante. Se usa
  // con fromIndex para separar la columna A-K "Mecanizado" (texto) de la
  // columna opcional "Mecanizado" (cantidad) que puede repetir el nombre.
  function findHeaderIndex(headers, name, fromIndex) {
    const target = normalize(name);
    for (let i = fromIndex; i < headers.length; i++) {
      if (normalize(headers[i]) === target) return i;
    }
    return -1;
  }

  // Igual que findHeaderIndex, pero si el nombre no aparece prueba sus
  // alias conocidos (ej. "Cantidad" también puede venir como "Cant Total").
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
  // CSV parsing (RFC4180-ish: handles quoted fields, embedded commas/newlines)
  // Processes every row the sheet returns; no row cap. Columns A-K are
  // resolved by name (first occurrence), and any optional stage-quantity
  // columns L-Q at the end of the sheet are resolved separately, by name,
  // starting right after "Material" — so a repeated header name (like the
  // optional "Mecanizado" quantity column) never overwrites the original
  // A-K field.
  // ---------------------------------------------------------------------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM (Google Sheets export)

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
        else if (c === '\r') { /* ignore, \n handles the break */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }

    const headers = (rows.shift() || []).map(h => h.trim());

    const coreIndex = {};
    CORE_FIELDS.forEach(name => { coreIndex[name] = resolveCoreIndex(headers, name); });
    const tailStart = coreIndex['Material'] === -1 ? 0 : coreIndex['Material'] + 1;
    const stageIndex = {};
    STAGE_FIELDS.forEach(name => { stageIndex[name] = findHeaderIndex(headers, name, tailStart); });
    const idClienteIndex = findHeaderIndex(headers, OPTIONAL_ID_FIELD, 0);

    return rows
      .filter(r => r.some(v => v.trim() !== ''))
      .map(r => {
        const cell = i => (i === -1 || i === undefined ? '' : (r[i] ?? '').trim());
        const obj = {};
        CORE_FIELDS.forEach(name => { obj[name] = cell(coreIndex[name]); });
        obj[OPTIONAL_ID_FIELD] = cell(idClienteIndex);
        obj.stages = {};
        STAGE_FIELDS.forEach(name => { obj.stages[name] = cell(stageIndex[name]); });
        return obj;
      });
  }

  // Google Sheets merges an OT's identity onto its first row only; item
  // rows that follow leave OT/Cliente/Fecha Ingreso/Status Final blank.
  // Fill those from the nearest row above that had them.
  function applyCarryOver(rows) {
    let lastOT = '', lastCliente = '', lastFecha = '', lastStatus = '', lastIdCliente = '';
    return rows.map(row => {
      if ((row['OT'] || '').trim()) {
        lastOT = row['OT'];
        lastCliente = row['Cliente'];
        lastFecha = row['Fecha Ingreso'];
        lastStatus = row['Status Final'];
        lastIdCliente = row[OPTIONAL_ID_FIELD];
        return row;
      }
      return {
        ...row,
        OT: lastOT,
        Cliente: lastCliente,
        'Fecha Ingreso': lastFecha,
        'Status Final': lastStatus,
        [OPTIONAL_ID_FIELD]: lastIdCliente
      };
    });
  }

  // ---------------------------------------------------------------------
  // Group flat CSV rows into one card per "OT". Each order is bucketed
  // whole into "pendiente" (Pendiente / anything not finished) or
  // "terminado" (Status Final === Terminado) — no per-item filtering.
  // ---------------------------------------------------------------------
  function groupOrders(rows) {
    const filled = applyCarryOver(rows);
    const map = new Map();

    filled.forEach(row => {
      const otNumber = (row['OT'] || '').trim();
      if (!otNumber) return;

      if (!map.has(otNumber)) {
        map.set(otNumber, {
          otNumber,
          cliente: row['Cliente'] || 'Sin cliente',
          idCliente: (row[OPTIONAL_ID_FIELD] || '').trim(),
          fechaIngresoRaw: (row['Fecha Ingreso'] || '').trim(),
          fechaIngresoDate: parseDDMMYYYY(row['Fecha Ingreso']),
          statusFinal: row['Status Final'] || '',
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

    return Array.from(map.values()).map(order => {
      const totalCantidad = order.items.reduce((sum, i) => sum + (i.cantidadNum || 0), 0);
      const totalListos = order.items.reduce((sum, i) => sum + (i.stages['Listos'] || 0), 0);
      const totalRechazados = order.items.reduce((sum, i) => sum + (i.stages['Rechazados'] || 0), 0);

      return {
        otNumber: order.otNumber,
        cliente: order.cliente,
        idCliente: order.idCliente,
        tipoOrigen: Array.from(order.tipoSet).filter(Boolean).join(' / ') || 'N/D',
        urgent: order.urgent,
        machining: order.machining,
        items: order.items,
        fechaIngreso: order.fechaIngresoRaw,
        diasEnProceso: order.fechaIngresoDate ? daysSince(order.fechaIngresoDate) : null,
        bucket: normalize(order.statusFinal) === 'terminado' ? 'terminado' : 'pendiente',
        totalCantidad,
        totalListos,
        totalRechazados,
        // Piezas Faltantes = Cantidad Total - Listos (nunca negativo).
        faltantes: Math.max(0, totalCantidad - totalListos)
      };
    });
  }

  // Resuelve, contra una lista de órdenes ya cargadas, cuál cliente real
  // matchea el parámetro ?cliente=. Coincidencia EXACTA únicamente (nunca
  // substring/.includes()): compara contra 'Cliente' o, si la planilla la
  // trae, contra 'ID_Cliente'. Se usa normalizeClientKey (sin acentos, sin
  // espacios/símbolos) en vez de sanitizeExact porque en la práctica nadie
  // escribe tildes al buscar — pero sigue siendo estricta: no es substring,
  // "metalurgica" matchea "Metalúrgica del Sur" completo, no "Metal".
  function matchClient(orders, rawParam) {
    const target = normalizeClientKey(rawParam);
    if (!target) return null;
    const match = orders.find(o =>
      normalizeClientKey(o.cliente) === target ||
      (o.idCliente && normalizeClientKey(o.idCliente) === target)
    );
    return match ? match.cliente : null;
  }

  // ---------------------------------------------------------------------
  // Card rendering (usado igual en el portal de cliente y en fábrica)
  // ---------------------------------------------------------------------
  function badge(text, classes) {
    const span = document.createElement('span');
    span.className = `inline-flex items-center px-2 py-1 rounded-md text-[11px] font-bold border ${classes}`;
    span.textContent = text;
    return span;
  }

  function buildCard(order) {
    const card = document.createElement('article');
    card.className = `card-enter bg-white border rounded-xl shadow-sm overflow-hidden flex flex-col ${
      order.urgent ? 'border-rvh-amber/70 ring-1 ring-rvh-amber/30' : 'border-rvh-border'
    }`;

    // Header
    const header = document.createElement('div');
    header.className = 'bg-rvh-navy text-white px-4 py-3 flex items-start justify-between gap-2';
    const headerLeft = document.createElement('div');
    const otLine = document.createElement('h3');
    otLine.className = 'font-black text-base leading-tight';
    otLine.textContent = order.otNumber;
    const clientLine = document.createElement('p');
    clientLine.className = 'text-xs text-slate-300 font-medium mt-0.5';
    clientLine.textContent = order.cliente;
    headerLeft.append(otLine, clientLine);
    if (order.fechaIngreso) {
      const dateLine = document.createElement('p');
      dateLine.className = 'text-[11px] text-slate-400 font-medium mt-0.5';
      dateLine.textContent = `📅 Ingreso: ${order.fechaIngreso}`;
      headerLeft.appendChild(dateLine);
    }
    header.appendChild(headerLeft);

    if (order.urgent) {
      const flag = document.createElement('span');
      flag.className = 'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold bg-rvh-amber text-white';
      flag.textContent = '⚠ URGENTE';
      header.appendChild(flag);
    }
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'p-4 flex flex-col gap-3';

    // Badges
    const badges = document.createElement('div');
    badges.className = 'flex flex-wrap gap-1.5';
    badges.appendChild(badge(order.tipoOrigen, 'text-rvh-steel bg-slate-100 border-slate-200'));
    badges.appendChild(
      order.machining
        ? badge('Mecanizado: SI', 'text-rvh-amber bg-amber-50 border-amber-200')
        : badge('Sin mecanizado', 'text-slate-400 bg-slate-50 border-slate-200')
    );
    if (order.diasEnProceso !== null) {
      const isStale = order.diasEnProceso > CONFIG.DIAS_ALERTA;
      badges.appendChild(badge(
        `⏱️ ${order.diasEnProceso} días en taller`,
        isStale ? 'text-red-700 bg-red-50 border-red-300' : 'text-slate-500 bg-slate-50 border-slate-200'
      ));
    }
    body.appendChild(badges);

    // Piezas Faltantes = Cantidad Total - Listos. Fila destacada para que
    // producción vea de un vistazo cuánto le falta a la OT. Solo aplica a
    // órdenes activas con datos numéricos de Cantidad: una OT ya
    // Terminada no necesita este cálculo, aunque su columna Listos no se
    // haya completado retroactivamente.
    if (order.bucket === 'pendiente' && order.totalCantidad > 0) {
      const isDone = order.faltantes === 0;
      const remaining = document.createElement('div');
      remaining.className = `flex items-center justify-between px-3 py-2 rounded-lg border ${
        isDone ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-300'
      }`;
      const label = document.createElement('span');
      label.className = 'text-[11px] font-bold uppercase tracking-wide text-slate-500';
      label.textContent = 'Piezas Faltantes';
      const value = document.createElement('span');
      value.className = `text-lg font-black ${isDone ? 'text-emerald-600' : 'text-rvh-amber'}`;
      value.textContent = isDone ? '✓ Completo' : String(order.faltantes);
      remaining.append(label, value);
      body.appendChild(remaining);
    }

    // Items table
    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'border border-rvh-border rounded-lg overflow-hidden';

    const itemsHeader = document.createElement('div');
    itemsHeader.className = 'grid grid-cols-[2.5rem_1fr_5.5rem] gap-2 px-3 py-1.5 text-[10px] font-bold uppercase text-slate-400 bg-slate-50 border-b border-rvh-border';
    ['Cant.', 'Descripción', 'Material'].forEach(t => {
      const s = document.createElement('span');
      s.textContent = t;
      itemsHeader.appendChild(s);
    });
    itemsWrap.appendChild(itemsHeader);

    order.items.forEach((item, idx) => {
      const rowWrap = document.createElement('div');
      rowWrap.className = `border-b border-rvh-border last:border-b-0 ${idx % 2 === 1 ? 'bg-slate-50/60' : ''}`;

      const row = document.createElement('div');
      row.className = 'grid grid-cols-[2.5rem_1fr_5.5rem] gap-2 px-3 py-1.5 text-xs';

      const cant = document.createElement('span');
      cant.className = 'font-bold text-slate-700';
      cant.textContent = item.cantidad;

      const desc = document.createElement('span');
      desc.className = 'text-slate-600 truncate';
      desc.title = item.descripcion;
      desc.textContent = item.descripcion;

      const mat = document.createElement('span');
      mat.className = 'text-slate-500 truncate';
      mat.title = item.material;
      mat.textContent = item.material;

      row.append(cant, desc, mat);
      rowWrap.appendChild(row);

      // Si la planilla trae el desglose por etapa (columnas opcionales
      // L-Q), mostrarlo como badges; si no, la Cantidad de arriba ya
      // alcanza (fallback seamless).
      const stageEntries = STAGE_FIELDS
        .map(name => ({ name, value: item.stages[name] }))
        .filter(s => s.value !== null && s.value > 0);

      if (stageEntries.length > 0) {
        const breakdown = document.createElement('div');
        breakdown.className = 'flex flex-wrap gap-1 px-3 pb-2';
        stageEntries.forEach(({ name, value }) => {
          const isRechazados = normalize(name) === normalize('Rechazados');
          breakdown.appendChild(badge(
            `${name}: ${value}`,
            isRechazados ? 'text-red-700 bg-red-50 border-red-300' : 'text-rvh-steel bg-slate-100 border-slate-200'
          ));
        });
        rowWrap.appendChild(breakdown);
      }

      itemsWrap.appendChild(rowWrap);
    });

    body.appendChild(itemsWrap);

    const footer = document.createElement('p');
    footer.className = 'text-[11px] text-slate-400 font-medium';
    footer.textContent = `${order.items.length} ${order.items.length === 1 ? 'ítem' : 'ítems'} en esta OT`;
    body.appendChild(footer);

    card.appendChild(body);
    return card;
  }

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------
  async function fetchCSVText(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`No se pudo obtener la planilla (HTTP ${res.status})`);
    return res.text();
  }

  return {
    CONFIG,
    TABS,
    DEMO_CSV,
    normalize,
    normalizeClientKey,
    sanitizeExact,
    debounce,
    parseCSV,
    groupOrders,
    matchClient,
    badge,
    buildCard,
    fetchCSVText
  };
})();
