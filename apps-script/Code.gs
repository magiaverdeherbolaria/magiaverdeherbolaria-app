/**
 * Magia Verde Herbolaria — Backend (Google Apps Script)
 * Versión 1.2: insumos (con formatos y elaborados), compras, productos y recetas, producción,
 * inventario, listas editables, método de costo e historial de costos.
 *
 * La planilla es solo el "disco duro": todo se crea, edita, archiva y anula desde la app.
 * Reglas:
 *  - Nada con historia se borra: se archiva (maestros), se oculta (listas) o se anula (registros).
 *  - El stock es la suma de MOVIMIENTOS activos. Nunca se escribe un stock "a mano".
 *  - Toda escritura pasa por LockService para que dos registros no se pisen.
 *  - El costo de cada insumo sale de sus entradas (compras o producción propia) según el
 *    método elegido en Configuración: última entrada (por defecto) o costo promedio.
 *  - Al actualizar la app, las hojas y columnas nuevas se crean solas; los datos no se tocan.
 */

const VERSION_BACKEND = '1.2.0';
const IVA = 0.19;
const BODEGA = 'BODEGA';

const SCHEMA = {
  INSUMOS: ['id', 'nombre', 'tipo', 'unidad', 'stock_min', 'costo_unit', 'ultima_compra', 'proveedor', 'estado', 'creado', 'actualizado', 'formato', 'formato_cant', 'elaborado', 'rinde_lote'],
  PRODUCTOS: ['id', 'nombre', 'categoria', 'presentacion', 'rinde_lote', 'precio_publico', 'precio_directo', 'precio_consig', 'stock_min', 'estado', 'creado', 'actualizado'],
  RECETAS: ['producto_id', 'tipo', 'ref', 'cantidad', 'costo'],
  COMPRAS: ['id', 'fecha', 'insumo_id', 'cantidad', 'total_neto', 'costo_unit', 'proveedor', 'documento', 'iva_incluido', 'estado', 'creado', 'tipo_doc', 'total_pagado', 'formato', 'formatos', 'formato_cant'],
  PRODUCCION: ['id', 'fecha', 'producto_id', 'lotes', 'unidades', 'costo_total', 'costo_unit', 'notas', 'estado', 'creado', 'item_tipo'],
  MOVIMIENTOS: ['id', 'fecha', 'tipo', 'item_tipo', 'item_id', 'cantidad', 'ubicacion', 'ref', 'nota', 'estado', 'creado'],
  FORMATOS: ['id', 'insumo_id', 'nombre', 'cantidad', 'principal', 'estado'],
  LISTAS: ['lista', 'valor', 'estado', 'orden'],
  COSTOS_HIST: ['fecha', 'item_tipo', 'item_id', 'costo_unit', 'motivo', 'creado'],
  CONFIG: ['clave', 'valor']
};

// Columnas numéricas; todas las demás se guardan como texto plano (evita que Sheets convierta fechas o IDs).
const NUMERIC = ['stock_min', 'costo_unit', 'rinde_lote', 'precio_publico', 'precio_directo', 'precio_consig',
  'cantidad', 'costo', 'total_neto', 'lotes', 'unidades', 'costo_total', 'formato_cant', 'total_pagado', 'formatos', 'orden'];

const LISTAS_BASE = {
  tipo_insumo: ['Materia prima', 'Envase', 'Etiqueta', 'Otro'],
  unidad: ['g', 'ml', 'u', 'gotas', 'cm'],
  categoria: [],
  motivo_ajuste: ['Carga inicial', 'Conteo físico', 'Merma o pérdida', 'Vencido', 'Uso interno o muestra', 'Otro']
};

// ─────────────────────────────────────────────────────────────
// Instalación: ejecutar UNA vez desde el editor (botón ▶ con "setup" seleccionado)
// ─────────────────────────────────────────────────────────────
function setup() {
  Object.keys(SCHEMA).forEach(function (name) { getSheet_(name); });
  sembrarListas_();
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '').slice(0, 16);
    props.setProperty('API_KEY', key);
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const def = ss.getSheetByName('Hoja 1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
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
  return json_({ ok: true, app: 'Magia Verde', version: VERSION_BACKEND, msg: 'Backend activo. La app usa POST.' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = body.action;
    if (action === 'ping') return json_({ ok: true, version: VERSION_BACKEND });
    const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
    if (!key || body.key !== key) throw new Error('Clave incorrecta. Revisa la clave en Configuración.');

    const writes = {
      saveInsumo: saveInsumo_, deleteInsumo: deleteInsumo_, restoreInsumo: restoreInsumo_,
      saveProducto: saveProducto_, deleteProducto: deleteProducto_, restoreProducto: restoreProducto_,
      registrarCompra: registrarCompra_, anularCompra: anularCompra_,
      registrarProduccion: registrarProduccion_, anularProduccion: anularProduccion_,
      ajustarStock: ajustarStock_,
      listaAdd: listaAdd_, listaRename: listaRename_, listaDelete: listaDelete_, listaRestore: listaRestore_,
      setConfig: setConfig_
    };
    if (action === 'getAll') {
      if (!readAll_('LISTAS').length) conLock_(sembrarListas_); // primera vez tras actualizar
      return json_(getAll_());
    }
    if (writes[action]) return json_(conLock_(function () { return writes[action](body); }));
    throw new Error('Acción desconocida: ' + action);
  } catch (err) {
    return json_({ error: err.message || String(err) });
  }
}

function conLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); }
  finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────
// Utilidades de planilla
// ─────────────────────────────────────────────────────────────
const HEADERS_ = {}; // encabezados reales de cada hoja (se leen una vez por ejecución)
const CACHE_ = {};   // lecturas por ejecución; se invalidan al escribir en esa hoja

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
  if (CACHE_[name]) return CACHE_[name];
  const sh = getSheet_(name);
  const headers = headers_(name);
  const last = sh.getLastRow();
  const out = [];
  if (last >= 2) {
    const values = sh.getRange(2, 1, last - 1, headers.length).getValues();
    values.forEach(function (row, i) {
      if (row.every(function (v) { return v === '' || v === null; })) return;
      const o = { _row: i + 2 };
      headers.forEach(function (h, j) {
        o[h] = NUMERIC.indexOf(h) >= 0 ? num_(row[j]) : (row[j] === null ? '' : String(row[j]));
      });
      out.push(o);
    });
  }
  CACHE_[name] = out;
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
  delete CACHE_[name];
}

function update_(name, obj) {
  const sh = getSheet_(name);
  const row = toRow_(name, obj);
  sh.getRange(obj._row, 1, 1, row.length).setValues([row]);
  // El objeto en caché es el mismo que se modificó, así que la caché sigue válida.
}

/** Borra filas (de abajo hacia arriba para no desplazar las demás). */
function deleteRows_(name, objs) {
  const sh = getSheet_(name);
  objs.slice().sort(function (a, b) { return b._row - a._row; }).forEach(function (o) { sh.deleteRow(o._row); });
  delete CACHE_[name];
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

function now_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'); }
function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

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

function validDate_(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? String(d) : today_(); }
function round_(n) { return Math.round(n * 1000) / 1000; }
const byDateAsc_ = function (a, b) { return (a.fecha + a.creado).localeCompare(b.fecha + b.creado); };

// ─────────────────────────────────────────────────────────────
// Configuración y listas editables
// ─────────────────────────────────────────────────────────────
function config_() {
  const c = { metodo_costo: 'ultima' };
  readAll_('CONFIG').forEach(function (r) { c[r.clave] = r.valor; });
  return c;
}

function setConfig_(b) {
  const permitidas = { metodo_costo: ['ultima', 'promedio'] };
  if (!permitidas[b.clave] || permitidas[b.clave].indexOf(b.valor) === -1) throw new Error('Configuración no válida.');
  const row = readAll_('CONFIG').filter(function (r) { return r.clave === b.clave; })[0];
  if (row) { row.valor = b.valor; update_('CONFIG', row); } else append_('CONFIG', [{ clave: b.clave, valor: b.valor }]);
  if (b.clave === 'metodo_costo') {
    readAll_('INSUMOS').forEach(function (i) { recalcularCostoInsumo_(i.id); });
    snapshotCostos_('Cambio de método de costo a ' + (b.valor === 'promedio' ? 'costo promedio' : 'última entrada'));
  }
  return { ok: true };
}

function sembrarListas_() {
  if (readAll_('LISTAS').length) return;
  const filas = [];
  Object.keys(LISTAS_BASE).forEach(function (lista) {
    let vals = LISTAS_BASE[lista].slice();
    // Conservar valores que ya se usan en los datos (versiones anteriores).
    if (lista === 'tipo_insumo') readAll_('INSUMOS').forEach(function (i) { if (i.tipo && vals.indexOf(i.tipo) === -1) vals.push(i.tipo); });
    if (lista === 'unidad') readAll_('INSUMOS').forEach(function (i) { if (i.unidad && vals.indexOf(i.unidad) === -1) vals.push(i.unidad); });
    if (lista === 'categoria') readAll_('PRODUCTOS').forEach(function (p) { if (p.categoria && vals.indexOf(p.categoria) === -1) vals.push(p.categoria); });
    vals.forEach(function (v, k) { filas.push({ lista: lista, valor: v, estado: 'activo', orden: k + 1 }); });
  });
  append_('LISTAS', filas);
}

/** Registros que usan un valor de lista (para renombrar en cascada o decidir si se puede borrar). */
function usosLista_(lista, valor) {
  const n = norm_(valor);
  if (lista === 'tipo_insumo') return { hoja: 'INSUMOS', campo: 'tipo', filas: readAll_('INSUMOS').filter(function (i) { return norm_(i.tipo) === n; }) };
  if (lista === 'unidad') return { hoja: 'INSUMOS', campo: 'unidad', filas: readAll_('INSUMOS').filter(function (i) { return norm_(i.unidad) === n; }) };
  if (lista === 'categoria') return { hoja: 'PRODUCTOS', campo: 'categoria', filas: readAll_('PRODUCTOS').filter(function (p) { return norm_(p.categoria) === n; }) };
  if (lista === 'motivo_ajuste') return { hoja: 'MOVIMIENTOS', campo: 'nota', filas: readAll_('MOVIMIENTOS').filter(function (m) { return m.tipo === 'ajuste' && norm_(m.nota) === n; }) };
  throw new Error('Lista desconocida.');
}

function filaLista_(lista, valor) {
  return readAll_('LISTAS').filter(function (r) { return r.lista === lista && norm_(r.valor) === norm_(valor); })[0];
}

function listaAdd_(b) {
  const valor = String(b.valor || '').trim();
  if (!LISTAS_BASE.hasOwnProperty(b.lista)) throw new Error('Lista desconocida.');
  if (!valor) throw new Error('Escribe un valor.');
  const ex = filaLista_(b.lista, valor);
  if (ex) {
    if (ex.estado === 'oculto') { ex.estado = 'activo'; update_('LISTAS', ex); return { ok: true, result: 'restaurado' }; }
    throw new Error('«' + ex.valor + '» ya está en la lista.');
  }
  const orden = readAll_('LISTAS').filter(function (r) { return r.lista === b.lista; }).length + 1;
  append_('LISTAS', [{ lista: b.lista, valor: valor, estado: 'activo', orden: orden }]);
  return { ok: true };
}

function listaRename_(b) {
  const fila = filaLista_(b.lista, b.valor);
  const nuevo = String(b.nuevo || '').trim();
  if (!fila) throw new Error('No encontré ese valor.');
  if (!nuevo) throw new Error('Escribe el nuevo nombre.');
  const otro = filaLista_(b.lista, nuevo);
  if (otro && otro !== fila) throw new Error('«' + otro.valor + '» ya existe en la lista.');
  const u = usosLista_(b.lista, fila.valor);
  u.filas.forEach(function (r) { r[u.campo] = nuevo; update_(u.hoja, r); });
  fila.valor = nuevo; update_('LISTAS', fila);
  return { ok: true, cambiados: u.filas.length };
}

function listaDelete_(b) {
  const fila = filaLista_(b.lista, b.valor);
  if (!fila) throw new Error('No encontré ese valor.');
  const usos = usosLista_(b.lista, fila.valor).filas.length;
  if (usos) { fila.estado = 'oculto'; update_('LISTAS', fila); return { ok: true, result: 'oculto', usos: usos }; }
  deleteRows_('LISTAS', [fila]);
  return { ok: true, result: 'eliminado' };
}

function listaRestore_(b) {
  const fila = filaLista_(b.lista, b.valor);
  if (!fila) throw new Error('No encontré ese valor.');
  fila.estado = 'activo'; update_('LISTAS', fila);
  return { ok: true };
}

/** Si se usa un valor que no está en la lista (ej. categoría nueva escrita en un producto), se agrega solo. */
function asegurarEnLista_(lista, valor) {
  valor = String(valor || '').trim();
  if (!valor) return;
  const ex = filaLista_(lista, valor);
  if (!ex) listaAdd_({ lista: lista, valor: valor });
  else if (ex.estado === 'oculto') { ex.estado = 'activo'; update_('LISTAS', ex); }
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

function stockDe_(itemId, ubicacion) {
  const s = stockMap_();
  return (s[itemId] && s[itemId][ubicacion || BODEGA]) || 0;
}

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
// Costos
// ─────────────────────────────────────────────────────────────
/**
 * Recalcula el costo de un insumo a partir de sus entradas activas:
 *  - compras (costo según factura/boleta) y
 *  - producción propia, si es un insumo elaborado (costo del lote).
 * Método "ultima": costo de la entrada más reciente.
 * Método "promedio": promedio ponderado entre lo que había en bodega y lo que entra,
 *   recorriendo todos los movimientos en orden (las salidas bajan el stock, no el costo).
 * Sin entradas, se conserva el costo ingresado a mano.
 */
function recalcularCostoInsumo_(insumoId) {
  const ins = findById_('INSUMOS', insumoId);
  if (!ins) return;
  const entradas = {};
  readAll_('COMPRAS').forEach(function (c) {
    if (c.insumo_id === insumoId && c.estado === 'activa') entradas[c.id] = { fecha: c.fecha, creado: c.creado, cu: c.costo_unit, proveedor: c.proveedor };
  });
  readAll_('PRODUCCION').forEach(function (l) {
    if (l.item_tipo === 'insumo' && l.producto_id === insumoId && l.estado === 'activa') entradas[l.id] = { fecha: l.fecha, creado: l.creado, cu: l.costo_unit, proveedor: '' };
  });
  const lista = Object.keys(entradas).map(function (k) { return entradas[k]; }).sort(byDateAsc_);
  if (!lista.length) {
    ins.ultima_compra = '';
  } else {
    const ult = lista[lista.length - 1];
    let costo = ult.cu;
    if (config_().metodo_costo === 'promedio') {
      let s = 0, c = 0;
      readAll_('MOVIMIENTOS').filter(function (m) { return m.item_id === insumoId && m.estado === 'activo'; })
        .sort(byDateAsc_).forEach(function (m) {
          const e = entradas[m.ref];
          if (e && m.cantidad > 0) {
            const base = Math.max(s, 0);
            c = base > 0 ? (base * c + m.cantidad * e.cu) / (base + m.cantidad) : e.cu;
          }
          s += m.cantidad;
        });
      costo = round_(c);
    }
    ins.costo_unit = costo;
    ins.ultima_compra = ult.fecha;
    const conProv = lista.filter(function (e) { return e.proveedor; });
    if (conProv.length) ins.proveedor = conProv[conProv.length - 1].proveedor;
  }
  ins.actualizado = now_();
  update_('INSUMOS', ins);
}

/** Costo de 1 unidad de insumo. Un elaborado sin producción aún se estima desde su receta. */
function costoInsumo_(ins, prof) {
  if (!ins) return 0;
  if (ins.costo_unit > 0 || ins.elaborado !== 'si' || (prof || 0) > 3) return ins.costo_unit || 0;
  return costoReceta_(ins.id, ins.rinde_lote, (prof || 0) + 1);
}

function costoReceta_(itemId, rinde, prof) {
  if (!(rinde > 0)) return 0;
  const insumos = {};
  readAll_('INSUMOS').forEach(function (i) { insumos[i.id] = i; });
  let lote = 0;
  readAll_('RECETAS').forEach(function (r) {
    if (r.producto_id !== itemId) return;
    lote += r.tipo === 'insumo' ? r.cantidad * costoInsumo_(insumos[r.ref], prof) : r.costo;
  });
  return lote / rinde;
}

/** Guarda en COSTOS_HIST el costo de cada producto activo si cambió desde su último registro. */
function snapshotCostos_(motivo) {
  const ult = {};
  readAll_('COSTOS_HIST').forEach(function (h) {
    if (!ult[h.item_id] || (h.fecha + h.creado) >= (ult[h.item_id].fecha + ult[h.item_id].creado)) ult[h.item_id] = h;
  });
  const filas = [];
  readAll_('PRODUCTOS').forEach(function (p) {
    if (p.estado !== 'activo') return;
    const c = Math.round(costoReceta_(p.id, p.rinde_lote, 0));
    if (!c) return;
    if (ult[p.id] && Math.round(ult[p.id].costo_unit) === c) return;
    filas.push({ fecha: today_(), item_tipo: 'producto', item_id: p.id, costo_unit: c, motivo: motivo, creado: now_() });
  });
  append_('COSTOS_HIST', filas);
}

// ─────────────────────────────────────────────────────────────
// Lectura general
// ─────────────────────────────────────────────────────────────
function getAll_() {
  const movs = readAll_('MOVIMIENTOS');
  const desc = function (arr, n) {
    return arr.slice().sort(function (a, b) { return (b.fecha + b.creado).localeCompare(a.fecha + a.creado); }).slice(0, n).map(strip_);
  };
  const cfg = config_();
  return {
    version: VERSION_BACKEND,
    config: { metodo_costo: cfg.metodo_costo },
    insumos: readAll_('INSUMOS').map(strip_),
    productos: readAll_('PRODUCTOS').map(strip_),
    recetas: readAll_('RECETAS').map(strip_),
    formatos: readAll_('FORMATOS').map(strip_),
    listas: readAll_('LISTAS').map(strip_),
    compras: desc(readAll_('COMPRAS'), 5000),
    produccion: desc(readAll_('PRODUCCION'), 1000),
    movimientos: desc(movs, 500),
    costos_hist: desc(readAll_('COSTOS_HIST'), 3000),
    stock: stockMap_(movs),
    serverTime: now_()
  };
}

// ─────────────────────────────────────────────────────────────
// Recetas (compartidas por productos e insumos elaborados)
// ─────────────────────────────────────────────────────────────
function limpiarReceta_(receta, itemId) {
  const insumosIds = readAll_('INSUMOS').map(function (i) { return i.id; });
  const lineas = (receta || []).filter(function (l) {
    return l && ((l.tipo === 'insumo' && l.ref && num_(l.cantidad) > 0) || (l.tipo === 'extra' && String(l.ref || '').trim() && num_(l.costo) > 0));
  });
  lineas.forEach(function (l) {
    if (l.tipo === 'insumo' && insumosIds.indexOf(l.ref) === -1) throw new Error('La receta tiene un insumo que no existe.');
    if (l.tipo === 'insumo' && l.ref === itemId) throw new Error('Un insumo no puede ser parte de su propia receta.');
  });
  return lineas;
}

function guardarReceta_(itemId, lineas) {
  deleteRows_('RECETAS', readAll_('RECETAS').filter(function (r) { return r.producto_id === itemId; }));
  append_('RECETAS', lineas.map(function (l) {
    return {
      producto_id: itemId, tipo: l.tipo, ref: l.tipo === 'extra' ? String(l.ref).trim() : l.ref,
      cantidad: l.tipo === 'insumo' ? num_(l.cantidad) : '', costo: l.tipo === 'extra' ? num_(l.costo) : ''
    };
  }));
}

// ─────────────────────────────────────────────────────────────
// Insumos
// ─────────────────────────────────────────────────────────────
function saveInsumo_(b) {
  const d = b.insumo || {};
  const nombre = String(d.nombre || '').trim();
  if (!nombre) throw new Error('El insumo necesita un nombre.');
  if (!d.unidad) throw new Error('Indica la unidad del insumo (g, ml, u...).');
  const elaborado = d.elaborado === 'si' || d.elaborado === true;
  if (elaborado && num_(d.rinde_lote) <= 0) throw new Error('Indica cuánto rinde un lote del insumo elaborado.');
  const all = readAll_('INSUMOS');
  const dup = all.filter(function (x) { return x.id !== d.id && x.estado !== 'archivado' && norm_(x.nombre) === norm_(nombre); });
  if (dup.length) throw new Error('Ya existe un insumo llamado "' + dup[0].nombre + '".');

  let cur;
  if (d.id) {
    cur = all.filter(function (x) { return x.id === d.id; })[0];
    if (!cur) throw new Error('No encontré ese insumo.');
    const usado = readAll_('MOVIMIENTOS').some(function (m) { return m.item_id === d.id && m.estado === 'activo'; });
    if (usado && cur.unidad !== d.unidad) throw new Error('No se puede cambiar la unidad de un insumo que ya tiene movimientos.');
  } else {
    cur = { id: uid_('INS'), estado: 'activo', creado: now_(), ultima_compra: '', costo_unit: 0 };
  }
  const lineas = elaborado ? limpiarReceta_(b.receta, cur.id) : [];
  cur.nombre = nombre; cur.tipo = d.tipo || 'Materia prima'; cur.unidad = d.unidad;
  cur.stock_min = num_(d.stock_min); cur.proveedor = d.proveedor || cur.proveedor || '';
  cur.elaborado = elaborado ? 'si' : ''; cur.rinde_lote = elaborado ? num_(d.rinde_lote) : '';
  if (!cur.ultima_compra) cur.costo_unit = num_(d.costo_unit); // con entradas, el costo lo calcula el sistema
  cur.actualizado = now_();

  // Formatos de compra: se reemplazan por los enviados; el principal queda también en la ficha.
  const fmts = (b.formatos || []).filter(function (f) { return String(f.nombre || '').trim() && num_(f.cantidad) > 0; });
  if (b.formatos) {
    if (fmts.length && !fmts.some(function (f) { return f.principal; })) fmts[0].principal = true;
    deleteRows_('FORMATOS', readAll_('FORMATOS').filter(function (f) { return f.insumo_id === cur.id; }));
    append_('FORMATOS', fmts.map(function (f) {
      return { id: uid_('FMT'), insumo_id: cur.id, nombre: String(f.nombre).trim(), cantidad: num_(f.cantidad), principal: f.principal ? 'si' : '', estado: 'activo' };
    }));
    const pr = fmts.filter(function (f) { return f.principal; })[0];
    cur.formato = pr ? String(pr.nombre).trim() : ''; cur.formato_cant = pr ? num_(pr.cantidad) : '';
  }

  if (cur._row) update_('INSUMOS', cur); else append_('INSUMOS', [cur]);
  if (elaborado) guardarReceta_(cur.id, lineas);
  else if (readAll_('RECETAS').some(function (r) { return r.producto_id === cur.id; })) guardarReceta_(cur.id, []);
  asegurarEnLista_('tipo_insumo', cur.tipo);
  asegurarEnLista_('unidad', cur.unidad);
  snapshotCostos_('Cambio en insumo ' + nombre);
  return { ok: true, insumo: strip_(findById_('INSUMOS', cur.id)) };
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
  deleteRows_('FORMATOS', readAll_('FORMATOS').filter(function (f) { return f.insumo_id === b.id; }));
  deleteRows_('RECETAS', readAll_('RECETAS').filter(function (r) { return r.producto_id === b.id; }));
  deleteRows_('INSUMOS', [findById_('INSUMOS', b.id)]);
  return { ok: true, result: 'eliminado' };
}

function restoreInsumo_(b) {
  const cur = findById_('INSUMOS', b.id);
  if (!cur) throw new Error('No encontré ese insumo.');
  cur.estado = 'activo'; cur.actualizado = now_(); update_('INSUMOS', cur);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────
function saveProducto_(b) {
  const d = b.producto || {};
  const nombre = String(d.nombre || '').trim();
  if (!nombre) throw new Error('El producto necesita un nombre.');
  if (num_(d.rinde_lote) <= 0) throw new Error('Indica cuántas unidades rinde un lote.');
  const all = readAll_('PRODUCTOS');
  const dup = all.filter(function (x) { return x.id !== d.id && x.estado !== 'archivado' && norm_(x.nombre) === norm_(nombre); });
  if (dup.length) throw new Error('Ya existe un producto llamado "' + dup[0].nombre + '".');

  let prod;
  if (d.id) {
    prod = all.filter(function (x) { return x.id === d.id; })[0];
    if (!prod) throw new Error('No encontré ese producto.');
  } else {
    prod = { id: uid_('PRD'), estado: 'activo', creado: now_() };
  }
  const lineas = limpiarReceta_(b.receta, prod.id);
  prod.nombre = nombre; prod.categoria = String(d.categoria || '').trim(); prod.presentacion = d.presentacion || '';
  prod.rinde_lote = num_(d.rinde_lote); prod.precio_publico = num_(d.precio_publico);
  prod.precio_directo = num_(d.precio_directo); prod.precio_consig = num_(d.precio_consig);
  prod.stock_min = num_(d.stock_min); prod.actualizado = now_();
  if (prod._row) update_('PRODUCTOS', prod); else append_('PRODUCTOS', [prod]);
  guardarReceta_(prod.id, lineas);
  asegurarEnLista_('categoria', prod.categoria);
  snapshotCostos_(d.id ? 'Receta editada' : 'Producto creado');
  return { ok: true, producto: strip_(findById_('PRODUCTOS', prod.id)) };
}

function deleteProducto_(b) {
  const cur = findById_('PRODUCTOS', b.id);
  if (!cur) throw new Error('No encontré ese producto.');
  const usado = readAll_('MOVIMIENTOS').some(function (m) { return m.item_id === b.id; });
  if (usado) {
    cur.estado = 'archivado'; cur.actualizado = now_(); update_('PRODUCTOS', cur);
    return { ok: true, result: 'archivado' };
  }
  deleteRows_('RECETAS', readAll_('RECETAS').filter(function (r) { return r.producto_id === b.id; }));
  deleteRows_('COSTOS_HIST', readAll_('COSTOS_HIST').filter(function (h) { return h.item_id === b.id; }));
  deleteRows_('PRODUCTOS', [findById_('PRODUCTOS', b.id)]);
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
 * La cantidad viene como N formatos × contenido (ej. 2 bolsas × 250 g) o directa.
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
  const fmtNombre = String(b.formato || '').trim();
  const compra = {
    id: nextSeq_('COMPRAS', 'C'), fecha: fecha, insumo_id: ins.id, cantidad: cantidad,
    total_neto: Math.round(costo), costo_unit: round_(costo / cantidad),
    proveedor: b.proveedor || '', documento: b.documento || '', iva_incluido: '',
    estado: 'activa', creado: now_(), tipo_doc: tipoDoc, total_pagado: Math.round(pagado),
    formato: fmtNombre, formatos: formatos > 0 && contenido > 0 ? formatos : '', formato_cant: formatos > 0 && contenido > 0 ? contenido : ''
  };
  append_('COMPRAS', [compra]);
  append_('MOVIMIENTOS', [mov_(fecha, 'compra', 'insumo', ins.id, cantidad, compra.id, compra.proveedor)]);

  // Formato nuevo → se guarda en la lista de formatos del insumo (principal si no tenía ninguno).
  if (fmtNombre && contenido > 0) {
    let suyos = readAll_('FORMATOS').filter(function (f) { return f.insumo_id === ins.id && f.estado === 'activo'; });
    // Migración desde 1.1: el formato que estaba en la ficha pasa a la lista como principal.
    if (!suyos.length && ins.formato && ins.formato_cant > 0) {
      append_('FORMATOS', [{ id: uid_('FMT'), insumo_id: ins.id, nombre: ins.formato, cantidad: ins.formato_cant, principal: 'si', estado: 'activo' }]);
      suyos = readAll_('FORMATOS').filter(function (f) { return f.insumo_id === ins.id && f.estado === 'activo'; });
    }
    const existe = suyos.some(function (f) { return norm_(f.nombre) === norm_(fmtNombre) && f.cantidad === contenido; });
    if (!existe) {
      const principal = !suyos.length;
      append_('FORMATOS', [{ id: uid_('FMT'), insumo_id: ins.id, nombre: fmtNombre, cantidad: contenido, principal: principal ? 'si' : '', estado: 'activo' }]);
      if (principal) { ins.formato = fmtNombre; ins.formato_cant = contenido; update_('INSUMOS', ins); }
    }
  }
  recalcularCostoInsumo_(ins.id);
  snapshotCostos_('Compra ' + compra.id + ' · ' + ins.nombre);
  return { ok: true, compra: compra };
}

function anularCompra_(b) {
  const c = findById_('COMPRAS', b.id);
  if (!c) throw new Error('No encontré esa compra.');
  if (c.estado === 'anulada') return { ok: true };
  c.estado = 'anulada'; update_('COMPRAS', c);
  anularMovsDeRef_(c.id);
  recalcularCostoInsumo_(c.insumo_id);
  const ins = findById_('INSUMOS', c.insumo_id);
  snapshotCostos_('Compra ' + c.id + ' anulada' + (ins ? ' · ' + ins.nombre : ''));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Producción (productos terminados e insumos elaborados)
// ─────────────────────────────────────────────────────────────
function registrarProduccion_(b) {
  const esInsumo = b.item_tipo === 'insumo';
  const itemId = b.item_id || b.producto_id;
  const item = findById_(esInsumo ? 'INSUMOS' : 'PRODUCTOS', itemId);
  if (!item) throw new Error(esInsumo ? 'Elige un insumo elaborado.' : 'Elige un producto.');
  if (esInsumo && item.elaborado !== 'si') throw new Error('Ese insumo no es elaborado.');
  const lotes = num_(b.lotes);
  if (lotes <= 0) throw new Error('Indica cuántos lotes produjiste.');
  const unidades = num_(b.unidades) > 0 ? num_(b.unidades) : lotes * item.rinde_lote;
  const receta = readAll_('RECETAS').filter(function (r) { return r.producto_id === item.id; });
  if (!receta.length) throw new Error('No tiene receta. Agrégala antes de producir.');
  const insumos = {};
  readAll_('INSUMOS').forEach(function (i) { insumos[i.id] = i; });

  const fecha = validDate_(b.fecha);
  const id = nextSeq_('PRODUCCION', 'L');
  const movs = [];
  let costo = 0;
  receta.forEach(function (r) {
    if (r.tipo === 'insumo') {
      const consumo = r.cantidad * lotes;
      costo += consumo * costoInsumo_(insumos[r.ref]);
      movs.push(mov_(fecha, 'produccion', 'insumo', r.ref, -consumo, id, item.nombre));
    } else {
      costo += r.costo * lotes;
    }
  });
  movs.push(mov_(fecha, 'produccion', esInsumo ? 'insumo' : 'producto', item.id, unidades, id, lotes + ' lote(s)'));
  const lote = {
    id: id, fecha: fecha, producto_id: item.id, item_tipo: esInsumo ? 'insumo' : 'producto', lotes: lotes, unidades: unidades,
    costo_total: Math.round(costo), costo_unit: esInsumo ? round_(costo / unidades) : Math.round(costo / unidades),
    notas: b.notas || '', estado: 'activa', creado: now_()
  };
  append_('PRODUCCION', [lote]);
  append_('MOVIMIENTOS', movs);
  if (esInsumo) { recalcularCostoInsumo_(item.id); snapshotCostos_('Producción ' + id + ' · ' + item.nombre); }
  return { ok: true, lote: lote };
}

function anularProduccion_(b) {
  const l = findById_('PRODUCCION', b.id);
  if (!l) throw new Error('No encontré ese lote.');
  if (l.estado === 'anulada') return { ok: true };
  l.estado = 'anulada'; update_('PRODUCCION', l);
  anularMovsDeRef_(l.id);
  if (l.item_tipo === 'insumo') { recalcularCostoInsumo_(l.producto_id); snapshotCostos_('Lote ' + l.id + ' anulado'); }
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
  const diff = round_(conteo - stockDe_(item.id, BODEGA));
  if (diff === 0) return { ok: true, diff: 0 };
  append_('MOVIMIENTOS', [mov_(validDate_(b.fecha), 'ajuste', itemTipo, item.id, diff, uid_('AJ'), b.nota || 'Conteo físico')]);
  return { ok: true, diff: diff };
}
