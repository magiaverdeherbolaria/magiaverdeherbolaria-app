/**
 * Magia Verde Herbolaria — Backend (Google Apps Script)
 * Fase 1: insumos y compras, productos y recetas, producción, inventario.
 *
 * La planilla es solo el "disco duro": todo se crea, edita, archiva y anula desde la app.
 * Reglas:
 *  - Nada con historia se borra: se archiva (maestros) o se anula (registros).
 *  - El stock es la suma de MOVIMIENTOS activos. Nunca se escribe un stock "a mano".
 *  - Toda escritura pasa por LockService para que dos registros no se pisen.
 *  - El costo de cada insumo es el de su última compra activa.
 */

const IVA = 0.19;
const BODEGA = 'BODEGA';

const SCHEMA = {
  INSUMOS: ['id', 'nombre', 'tipo', 'unidad', 'stock_min', 'costo_unit', 'ultima_compra', 'proveedor', 'estado', 'creado', 'actualizado', 'formato', 'formato_cant'],
  PRODUCTOS: ['id', 'nombre', 'categoria', 'presentacion', 'rinde_lote', 'precio_publico', 'precio_directo', 'precio_consig', 'stock_min', 'estado', 'creado', 'actualizado'],
  RECETAS: ['producto_id', 'tipo', 'ref', 'cantidad', 'costo'],
  COMPRAS: ['id', 'fecha', 'insumo_id', 'cantidad', 'total_neto', 'costo_unit', 'proveedor', 'documento', 'iva_incluido', 'estado', 'creado', 'tipo_doc', 'total_pagado', 'formato', 'formatos', 'formato_cant'],
  PRODUCCION: ['id', 'fecha', 'producto_id', 'lotes', 'unidades', 'costo_total', 'costo_unit', 'notas', 'estado', 'creado'],
  MOVIMIENTOS: ['id', 'fecha', 'tipo', 'item_tipo', 'item_id', 'cantidad', 'ubicacion', 'ref', 'nota', 'estado', 'creado']
};

// Columnas numéricas; todas las demás se guardan como texto plano (evita que Sheets convierta fechas o IDs).
const NUMERIC = ['stock_min', 'costo_unit', 'rinde_lote', 'precio_publico', 'precio_directo', 'precio_consig',
  'cantidad', 'costo', 'total_neto', 'lotes', 'unidades', 'costo_total', 'formato_cant', 'total_pagado', 'formatos'];

// ─────────────────────────────────────────────────────────────
// Instalación: ejecutar UNA vez desde el editor (botón ▶ con "setup" seleccionado)
// ─────────────────────────────────────────────────────────────
function setup() {
  Object.keys(SCHEMA).forEach(function (name) { getSheet_(name); });
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('API_KEY', key);
  }
  const def = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Hoja 1') || SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && SpreadsheetApp.getActiveSpreadsheet().getSheets().length > 1) {
    SpreadsheetApp.getActiveSpreadsheet().deleteSheet(def);
  }
  Logger.log('Listo. Clave de la app (pégala en Configuración): ' + key);
  return key;
}

/** Muestra la clave actual en el registro de ejecución. */
function verClave() {
  Logger.log(PropertiesService.getScriptProperties().getProperty('API_KEY'));
}

// ─────────────────────────────────────────────────────────────
// Entrada web
// ─────────────────────────────────────────────────────────────
function doGet() {
  return json_({ ok: true, app: 'Magia Verde', msg: 'Backend activo. La app usa POST.' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    if (action === 'ping') return json_({ ok: true });
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || body.key !== key) throw new Error('Clave incorrecta. Revisa la clave en Configuración.');

    const reads = { getAll: getAll_ };
    const writes = {
      saveInsumo: saveInsumo_, deleteInsumo: deleteInsumo_, restoreInsumo: restoreInsumo_,
      saveProducto: saveProducto_, deleteProducto: deleteProducto_, restoreProducto: restoreProducto_,
      registrarCompra: registrarCompra_, anularCompra: anularCompra_,
      registrarProduccion: registrarProduccion_, anularProduccion: anularProduccion_,
      ajustarStock: ajustarStock_
    };
    if (reads[action]) return json_(reads[action](body));
    if (writes[action]) {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try { return json_(writes[action](body)); }
      finally { SpreadsheetApp.flush(); lock.releaseLock(); }
    }
    throw new Error('Acción desconocida: ' + action);
  } catch (err) {
    return json_({ error: err.message || String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// Utilidades de planilla
// ─────────────────────────────────────────────────────────────
const HEADERS_ = {}; // encabezados reales de cada hoja (se leen una vez por ejecución)

/**
 * Devuelve la hoja, creándola si no existe. Si a una hoja existente le faltan columnas
 * nuevas del SCHEMA (por una actualización de la app), las agrega al final sin tocar los datos.
 */
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  const schema = SCHEMA[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, schema.length).setValues([schema]).setFontWeight('bold');
    sh.setFrozenRows(1);
    schema.forEach(function (h, i) {
      if (NUMERIC.indexOf(h) === -1) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
    HEADERS_[name] = schema.slice();
    return sh;
  }
  if (!HEADERS_[name]) {
    const lastCol = Math.max(sh.getLastColumn ? sh.getLastColumn() : schema.length, 1);
    const current = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String).filter(function (h) { return h !== ''; });
    const missing = schema.filter(function (h) { return current.indexOf(h) === -1; });
    missing.forEach(function (h) {
      const col = current.length + 1;
      sh.getRange(1, col, 1, 1).setValues([[h]]).setFontWeight('bold');
      if (NUMERIC.indexOf(h) === -1) sh.getRange(2, col, sh.getMaxRows() - 1, 1).setNumberFormat('@');
      current.push(h);
    });
    HEADERS_[name] = current;
  }
  return sh;
}

function headers_(name) { getSheet_(name); return HEADERS_[name]; }

function readAll_(name) {
  const sh = getSheet_(name);
  const headers = headers_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  const out = [];
  values.forEach(function (row, i) {
    if (row.every(function (v) { return v === '' || v === null; })) return;
    const o = { _row: i + 2 };
    headers.forEach(function (h, j) {
      o[h] = NUMERIC.indexOf(h) >= 0 ? num_(row[j]) : (row[j] === null ? '' : String(row[j]));
    });
    out.push(o);
  });
  return out;
}

function toRow_(name, obj) {
  return headers_(name).map(function (h) {
    const v = obj[h];
    if (NUMERIC.indexOf(h) >= 0) return (v === '' || v === null || v === undefined) ? '' : num_(v);
    return v === undefined || v === null ? '' : String(v);
  });
}

function append_(name, objs) {
  if (!objs.length) return;
  const sh = getSheet_(name);
  const rows = objs.map(function (o) { return toRow_(name, o); });
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}

function update_(name, obj) {
  const sh = getSheet_(name);
  const row = toRow_(name, obj);
  sh.getRange(obj._row, 1, 1, row.length).setValues([row]);
}

function findById_(name, id) {
  const all = readAll_(name);
  for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function num_(v) {
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v === undefined || v === null ? '' : v).replace(/[$\s]/g, '');
  if (s === '') return 0;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);           // 1234 o 0.5
  const n = Number(s.replace(/\./g, '').replace(',', '.'));   // 1.234,5 (formato chileno)
  return isNaN(n) ? 0 : n;
}

function now_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function uid_(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase();
}

/** Correlativo legible (C-0001, L-0001...). Se llama siempre dentro del lock. */
function nextSeq_(name, prefix) {
  let max = 0;
  readAll_(name).forEach(function (r) {
    const m = String(r.id).match(new RegExp('^' + prefix + '-(\\d+)$'));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return prefix + '-' + ('000' + (max + 1)).slice(-4);
}

function norm_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function strip_(o) {
  const c = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; });
  return c;
}

function validDate_(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : today_();
}

// ─────────────────────────────────────────────────────────────
// Stock
// ─────────────────────────────────────────────────────────────
function stockMap_(movs) {
  const s = {};
  (movs || readAll_('MOVIMIENTOS')).forEach(function (m) {
    if (m.estado !== 'activo') return;
    s[m.item_id] = s[m.item_id] || {};
    s[m.item_id][m.ubicacion] = round_((s[m.item_id][m.ubicacion] || 0) + m.cantidad);
  });
  return s;
}

function stockDe_(itemId, ubicacion, movs) {
  const s = stockMap_(movs);
  return (s[itemId] && s[itemId][ubicacion || BODEGA]) || 0;
}

function round_(n) { return Math.round(n * 1000) / 1000; }

function mov_(fecha, tipo, itemTipo, itemId, cantidad, ref, nota) {
  return {
    id: uid_('M'), fecha: fecha, tipo: tipo, item_tipo: itemTipo, item_id: itemId,
    cantidad: round_(cantidad), ubicacion: BODEGA, ref: ref || '', nota: nota || '',
    estado: 'activo', creado: now_()
  };
}

function anularMovsDeRef_(ref) {
  readAll_('MOVIMIENTOS').forEach(function (m) {
    if (m.ref === ref && m.estado === 'activo') { m.estado = 'anulado'; update_('MOVIMIENTOS', m); }
  });
}

// ─────────────────────────────────────────────────────────────
// Lectura general
// ─────────────────────────────────────────────────────────────
function getAll_() {
  const movs = readAll_('MOVIMIENTOS');
  const lastN = function (arr, n) {
    return arr.slice().sort(function (a, b) {
      return (b.fecha + b.creado).localeCompare(a.fecha + a.creado);
    }).slice(0, n).map(strip_);
  };
  return {
    insumos: readAll_('INSUMOS').map(strip_),
    productos: readAll_('PRODUCTOS').map(strip_),
    recetas: readAll_('RECETAS').map(strip_),
    compras: lastN(readAll_('COMPRAS'), 300),
    produccion: lastN(readAll_('PRODUCCION'), 300),
    movimientos: lastN(movs, 400),
    stock: stockMap_(movs),
    serverTime: now_()
  };
}

// ─────────────────────────────────────────────────────────────
// Insumos
// ─────────────────────────────────────────────────────────────
function saveInsumo_(b) {
  const d = b.insumo || {};
  const nombre = String(d.nombre || '').trim();
  if (!nombre) throw new Error('El insumo necesita un nombre.');
  if (!d.unidad) throw new Error('Indica la unidad del insumo (g, ml, u...).');
  const all = readAll_('INSUMOS');
  const dup = all.filter(function (x) { return x.id !== d.id && x.estado !== 'archivado' && norm_(x.nombre) === norm_(nombre); });
  if (dup.length) throw new Error('Ya existe un insumo llamado "' + dup[0].nombre + '".');

  if (d.id) {
    const cur = all.filter(function (x) { return x.id === d.id; })[0];
    if (!cur) throw new Error('No encontré ese insumo.');
    const usado = readAll_('MOVIMIENTOS').some(function (m) { return m.item_id === d.id && m.estado === 'activo'; });
    if (usado && cur.unidad !== d.unidad) throw new Error('No se puede cambiar la unidad de un insumo que ya tiene movimientos.');
    cur.nombre = nombre; cur.tipo = d.tipo || cur.tipo; cur.unidad = d.unidad;
    cur.stock_min = num_(d.stock_min); cur.costo_unit = num_(d.costo_unit);
    cur.proveedor = d.proveedor || ''; cur.formato = d.formato || ''; cur.formato_cant = num_(d.formato_cant);
    cur.actualizado = now_();
    update_('INSUMOS', cur);
    return { ok: true, insumo: strip_(cur) };
  }
  const nuevo = {
    id: uid_('INS'), nombre: nombre, tipo: d.tipo || 'Materia prima', unidad: d.unidad,
    stock_min: num_(d.stock_min), costo_unit: num_(d.costo_unit), ultima_compra: '',
    proveedor: d.proveedor || '', estado: 'activo', creado: now_(), actualizado: now_(),
    formato: d.formato || '', formato_cant: num_(d.formato_cant)
  };
  append_('INSUMOS', [nuevo]);
  return { ok: true, insumo: nuevo };
}

function deleteInsumo_(b) {
  const cur = findById_('INSUMOS', b.id);
  if (!cur) throw new Error('No encontré ese insumo.');
  const enMovs = readAll_('MOVIMIENTOS').some(function (m) { return m.item_id === b.id; });
  const enRecetas = readAll_('RECETAS').some(function (r) { return r.tipo === 'insumo' && r.ref === b.id; });
  if (enMovs || enRecetas) {
    cur.estado = 'archivado'; cur.actualizado = now_(); update_('INSUMOS', cur);
    return { ok: true, result: 'archivado' };
  }
  getSheet_('INSUMOS').deleteRow(cur._row);
  return { ok: true, result: 'eliminado' };
}

function restoreInsumo_(b) {
  const cur = findById_('INSUMOS', b.id);
  if (!cur) throw new Error('No encontré ese insumo.');
  cur.estado = 'activo'; cur.actualizado = now_(); update_('INSUMOS', cur);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Productos y recetas
// ─────────────────────────────────────────────────────────────
function saveProducto_(b) {
  const d = b.producto || {};
  const nombre = String(d.nombre || '').trim();
  if (!nombre) throw new Error('El producto necesita un nombre.');
  if (num_(d.rinde_lote) <= 0) throw new Error('Indica cuántas unidades rinde un lote.');
  const all = readAll_('PRODUCTOS');
  const dup = all.filter(function (x) { return x.id !== d.id && x.estado !== 'archivado' && norm_(x.nombre) === norm_(nombre); });
  if (dup.length) throw new Error('Ya existe un producto llamado "' + dup[0].nombre + '".');

  const lineas = (b.receta || []).filter(function (l) {
    return l && ((l.tipo === 'insumo' && l.ref && num_(l.cantidad) > 0) || (l.tipo === 'extra' && String(l.ref || '').trim() && num_(l.costo) > 0));
  });
  const insumosIds = readAll_('INSUMOS').map(function (i) { return i.id; });
  lineas.forEach(function (l) {
    if (l.tipo === 'insumo' && insumosIds.indexOf(l.ref) === -1) throw new Error('La receta tiene un insumo que no existe.');
  });

  let prod;
  if (d.id) {
    prod = all.filter(function (x) { return x.id === d.id; })[0];
    if (!prod) throw new Error('No encontré ese producto.');
  } else {
    prod = { id: uid_('PRD'), estado: 'activo', creado: now_() };
  }
  prod.nombre = nombre; prod.categoria = d.categoria || ''; prod.presentacion = d.presentacion || '';
  prod.rinde_lote = num_(d.rinde_lote); prod.precio_publico = num_(d.precio_publico);
  prod.precio_directo = num_(d.precio_directo); prod.precio_consig = num_(d.precio_consig);
  prod.stock_min = num_(d.stock_min); prod.actualizado = now_();
  if (prod._row) update_('PRODUCTOS', prod); else append_('PRODUCTOS', [prod]);

  // Reemplazar receta: borrar filas del producto (de abajo hacia arriba) y escribir las nuevas.
  const sh = getSheet_('RECETAS');
  readAll_('RECETAS').filter(function (r) { return r.producto_id === prod.id; })
    .sort(function (a, b2) { return b2._row - a._row; })
    .forEach(function (r) { sh.deleteRow(r._row); });
  append_('RECETAS', lineas.map(function (l) {
    return {
      producto_id: prod.id, tipo: l.tipo, ref: l.tipo === 'extra' ? String(l.ref).trim() : l.ref,
      cantidad: l.tipo === 'insumo' ? num_(l.cantidad) : '', costo: l.tipo === 'extra' ? num_(l.costo) : ''
    };
  }));
  return { ok: true, producto: strip_(prod) };
}

function deleteProducto_(b) {
  const cur = findById_('PRODUCTOS', b.id);
  if (!cur) throw new Error('No encontré ese producto.');
  const usado = readAll_('MOVIMIENTOS').some(function (m) { return m.item_id === b.id; });
  if (usado) {
    cur.estado = 'archivado'; cur.actualizado = now_(); update_('PRODUCTOS', cur);
    return { ok: true, result: 'archivado' };
  }
  const sh = getSheet_('RECETAS');
  readAll_('RECETAS').filter(function (r) { return r.producto_id === b.id; })
    .sort(function (a, b2) { return b2._row - a._row; })
    .forEach(function (r) { sh.deleteRow(r._row); });
  getSheet_('PRODUCTOS').deleteRow(findById_('PRODUCTOS', b.id)._row);
  return { ok: true, result: 'eliminado' };
}

function restoreProducto_(b) {
  const cur = findById_('PRODUCTOS', b.id);
  if (!cur) throw new Error('No encontré ese producto.');
  cur.estado = 'activo'; cur.actualizado = now_(); update_('PRODUCTOS', cur);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Compras de insumos
// ─────────────────────────────────────────────────────────────
/**
 * Compra de insumo. Javi ingresa lo que pagó (total pagado) y el tipo de documento:
 *  - factura → el IVA se recupera como crédito fiscal, así que el costo es el neto (total / 1,19).
 *  - boleta o sin documento → el IVA no se recupera: el costo es el total pagado.
 * La cantidad puede venir como N formatos × contenido (ej. 2 bolsas × 250 g) o directa.
 */
function registrarCompra_(b) {
  const ins = findById_('INSUMOS', b.insumo_id);
  if (!ins) throw new Error('Elige un insumo.');
  const formatos = num_(b.formatos), contenido = num_(b.formato_cant);
  const cantidad = formatos > 0 && contenido > 0 ? round_(formatos * contenido) : num_(b.cantidad);
  const pagado = num_(b.total_pagado !== undefined ? b.total_pagado : b.total);
  if (cantidad <= 0) throw new Error('La cantidad comprada debe ser mayor a 0.');
  if (pagado <= 0) throw new Error('Ingresa el total pagado.');
  const tipoDoc = b.tipo_doc === 'factura' ? 'factura' : 'boleta';
  const costo = tipoDoc === 'factura' ? pagado / (1 + IVA) : pagado;
  const fecha = validDate_(b.fecha);
  const compra = {
    id: nextSeq_('COMPRAS', 'C'), fecha: fecha, insumo_id: ins.id, cantidad: cantidad,
    total_neto: Math.round(costo), costo_unit: round_(costo / cantidad),
    proveedor: b.proveedor || '', documento: b.documento || '', iva_incluido: '',
    estado: 'activa', creado: now_(), tipo_doc: tipoDoc, total_pagado: Math.round(pagado),
    formato: b.formato || '', formatos: formatos > 0 && contenido > 0 ? formatos : '', formato_cant: formatos > 0 && contenido > 0 ? contenido : ''
  };
  append_('COMPRAS', [compra]);
  append_('MOVIMIENTOS', [mov_(fecha, 'compra', 'insumo', ins.id, cantidad, compra.id, compra.proveedor)]);
  // Recordar el formato como habitual si el insumo aún no tiene uno.
  if (compra.formato && contenido > 0 && !ins.formato) {
    const cur = findById_('INSUMOS', ins.id); cur.formato = compra.formato; cur.formato_cant = contenido; update_('INSUMOS', cur);
  }
  recalcularCostoInsumo_(ins.id);
  return { ok: true, compra: compra };
}

function anularCompra_(b) {
  const c = findById_('COMPRAS', b.id);
  if (!c) throw new Error('No encontré esa compra.');
  if (c.estado === 'anulada') return { ok: true };
  c.estado = 'anulada'; update_('COMPRAS', c);
  anularMovsDeRef_(c.id);
  recalcularCostoInsumo_(c.insumo_id);
  return { ok: true };
}

/** Costo del insumo = costo unitario de su última compra activa (por fecha y luego por registro). */
function recalcularCostoInsumo_(insumoId) {
  const compras = readAll_('COMPRAS').filter(function (c) { return c.insumo_id === insumoId && c.estado === 'activa'; })
    .sort(function (a, b) { return (b.fecha + b.creado).localeCompare(a.fecha + a.creado); });
  const ins = findById_('INSUMOS', insumoId);
  if (!ins) return;
  if (compras.length) {
    ins.costo_unit = compras[0].costo_unit;
    ins.ultima_compra = compras[0].fecha;
    if (compras[0].proveedor) ins.proveedor = compras[0].proveedor;
  } else {
    ins.ultima_compra = '';
  }
  ins.actualizado = now_();
  update_('INSUMOS', ins);
}

// ─────────────────────────────────────────────────────────────
// Producción
// ─────────────────────────────────────────────────────────────
function registrarProduccion_(b) {
  const prod = findById_('PRODUCTOS', b.producto_id);
  if (!prod) throw new Error('Elige un producto.');
  const lotes = num_(b.lotes);
  if (lotes <= 0) throw new Error('Indica cuántos lotes produjiste.');
  const unidades = num_(b.unidades) > 0 ? num_(b.unidades) : lotes * prod.rinde_lote;
  const receta = readAll_('RECETAS').filter(function (r) { return r.producto_id === prod.id; });
  if (!receta.length) throw new Error('Este producto no tiene receta. Agrégala antes de producir.');
  const insumos = {};
  readAll_('INSUMOS').forEach(function (i) { insumos[i.id] = i; });

  const fecha = validDate_(b.fecha);
  const id = nextSeq_('PRODUCCION', 'L');
  const movs = [];
  let costo = 0;
  receta.forEach(function (r) {
    if (r.tipo === 'insumo') {
      const ins = insumos[r.ref];
      const consumo = r.cantidad * lotes;
      costo += consumo * (ins ? ins.costo_unit : 0);
      movs.push(mov_(fecha, 'produccion', 'insumo', r.ref, -consumo, id, prod.nombre));
    } else {
      costo += r.costo * lotes;
    }
  });
  movs.push(mov_(fecha, 'produccion', 'producto', prod.id, unidades, id, lotes + ' lote(s)'));
  const lote = {
    id: id, fecha: fecha, producto_id: prod.id, lotes: lotes, unidades: unidades,
    costo_total: Math.round(costo), costo_unit: Math.round(costo / unidades), notas: b.notas || '',
    estado: 'activa', creado: now_()
  };
  append_('PRODUCCION', [lote]);
  append_('MOVIMIENTOS', movs);
  return { ok: true, lote: lote };
}

function anularProduccion_(b) {
  const l = findById_('PRODUCCION', b.id);
  if (!l) throw new Error('No encontré ese lote.');
  if (l.estado === 'anulada') return { ok: true };
  l.estado = 'anulada'; update_('PRODUCCION', l);
  anularMovsDeRef_(l.id);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Ajustes de inventario (conteo físico o carga inicial)
// ─────────────────────────────────────────────────────────────
function ajustarStock_(b) {
  const itemTipo = b.item_tipo === 'producto' ? 'producto' : 'insumo';
  const item = findById_(itemTipo === 'producto' ? 'PRODUCTOS' : 'INSUMOS', b.item_id);
  if (!item) throw new Error('No encontré ese ítem.');
  const conteo = num_(b.conteo);
  if (conteo < 0) throw new Error('El conteo no puede ser negativo.');
  const actual = stockDe_(item.id, BODEGA);
  const diff = round_(conteo - actual);
  if (diff === 0) return { ok: true, diff: 0 };
  const ref = uid_('AJ');
  append_('MOVIMIENTOS', [mov_(validDate_(b.fecha), 'ajuste', itemTipo, item.id, diff, ref, b.nota || 'Conteo físico')]);
  return { ok: true, diff: diff };
}
