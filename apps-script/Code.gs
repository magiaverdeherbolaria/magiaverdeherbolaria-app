/**
 * Magia Verde Herbolaria — Backend (Google Apps Script)
 * Versión 2.0: insumos (con formatos y elaborados), compras, productos y recetas, producción,
 * inventario, listas editables, método de costo, historial de costos y VENTAS: clientes (empresas
 * con locales y precios negociados), venta rápida, órdenes de venta con folio y pagos,
 * consignaciones y liquidaciones.
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

const VERSION_BACKEND = '2.3.0';
const IVA = 0.19;
const BODEGA = 'BODEGA';

const SCHEMA = {
  INSUMOS: ['id', 'nombre', 'tipo', 'unidad', 'stock_min', 'costo_unit', 'ultima_compra', 'proveedor', 'estado', 'creado', 'actualizado', 'formato', 'formato_cant', 'elaborado', 'rinde_lote'],
  PRODUCTOS: ['id', 'nombre', 'categoria', 'presentacion', 'rinde_lote', 'precio_publico', 'precio_directo', 'precio_consig', 'stock_min', 'estado', 'creado', 'actualizado', 'precio_b2b', 'tipo'],
  RECETAS: ['producto_id', 'tipo', 'ref', 'cantidad', 'costo'],
  COMPRAS: ['id', 'fecha', 'insumo_id', 'cantidad', 'total_neto', 'costo_unit', 'proveedor', 'documento', 'iva_incluido', 'estado', 'creado', 'tipo_doc', 'total_pagado', 'formato', 'formatos', 'formato_cant'],
  PRODUCCION: ['id', 'fecha', 'producto_id', 'lotes', 'unidades', 'costo_total', 'costo_unit', 'notas', 'estado', 'creado', 'item_tipo'],
  MOVIMIENTOS: ['id', 'fecha', 'tipo', 'item_tipo', 'item_id', 'cantidad', 'ubicacion', 'ref', 'nota', 'estado', 'creado'],
  FORMATOS: ['id', 'insumo_id', 'nombre', 'cantidad', 'principal', 'estado'],
  LISTAS: ['lista', 'valor', 'estado', 'orden'],
  COSTOS_HIST: ['fecha', 'item_tipo', 'item_id', 'costo_unit', 'motivo', 'creado'],
  CONFIG: ['clave', 'valor'],
  EMPRESAS: ['rut', 'razon_social', 'giro', 'direccion', 'comuna', 'email', 'telefono', 'contacto', 'cond_pago_dias', 'modalidades', 'modalidad_habitual', 'notas', 'estado', 'creado', 'actualizado'],
  LOCALES: ['id', 'rut', 'nombre', 'direccion', 'comuna', 'contacto', 'telefono', 'email', 'estado', 'creado'],
  PRECIOS_CLIENTE: ['rut', 'producto_id', 'precio_directo', 'precio_consig', 'precio'],
  VENTAS: ['id', 'fecha', 'canal', 'rut', 'local_id', 'estado', 'neto', 'iva', 'total', 'folio', 'fecha_folio', 'medio_pago', 'lugar', 'origen', 'notas', 'creado', 'actualizado',
    'medio_venta', 'feria_id', 'feria_dia', 'persona_id', 'documento'],
  VENTAS_DET: ['venta_id', 'producto_id', 'cantidad', 'precio', 'subtotal', 'costo_unit'],
  PAGOS: ['id', 'venta_id', 'fecha', 'monto', 'medio', 'estado', 'creado'],
  CONSIGNACIONES: ['id', 'fecha', 'rut', 'local_id', 'guia', 'notas', 'estado', 'creado'],
  CONSIG_DET: ['oc_id', 'producto_id', 'cantidad', 'precio'],
  LIQUIDACIONES: ['id', 'fecha', 'rut', 'local_id', 'venta_id', 'notas', 'estado', 'creado'],
  LIQ_DET: ['lq_id', 'producto_id', 'en_local', 'contado', 'vendido', 'devuelto', 'precio'],
  PROYECTOS: ['id', 'nombre', 'origen', 'institucion', 'rut', 'id_licitacion', 'estado', 'fecha_postulacion', 'fecha_inicio', 'fecha_fin',
    'alumnos', 'sesiones', 'horas', 'presupuesto_max', 'margen_obj', 'precio_ofertado', 'afecto_iva', 'link_doc', 'notas',
    'venta_id', 'ejecutado_fecha', 'alumnos_reales', 'costo_mat_real', 'creado', 'actualizado'],
  PROY_MAT: ['proyecto_id', 'tipo', 'ref', 'cantidad'],
  PROY_COSTOS: ['proyecto_id', 'descripcion', 'cantidad', 'valor_unit'],
  FERIAS: ['id', 'nombre', 'lugar', 'costo_puesto', 'notas', 'estado', 'creado', 'actualizado'],
  FERIA_DIAS: ['feria_id', 'dia', 'fecha', 'hora_inicio', 'hora_fin'],
  PERSONAS: ['id', 'nombre', 'telefono', 'instagram', 'email', 'notas', 'estado', 'creado', 'actualizado'],
  PROY_SESIONES: ['proyecto_id', 'n', 'fecha', 'hora_inicio', 'hora_fin', 'lugar'],
  EVENTOS: ['id', 'titulo', 'fecha', 'fecha_fin', 'hora_inicio', 'hora_fin', 'lugar', 'notas', 'estado', 'creado', 'actualizado'],
  GCAL: ['clave', 'event_id', 'hash', 'actualizado']
};

// Columnas numéricas; todas las demás se guardan como texto plano (evita que Sheets convierta fechas o IDs).
const NUMERIC = ['stock_min', 'costo_unit', 'rinde_lote', 'precio_publico', 'precio_directo', 'precio_consig', 'precio_b2b',
  'cantidad', 'costo', 'total_neto', 'lotes', 'unidades', 'costo_total', 'formato_cant', 'total_pagado', 'formatos', 'orden',
  'cond_pago_dias', 'neto', 'iva', 'total', 'precio', 'subtotal', 'monto', 'en_local', 'contado', 'vendido', 'devuelto',
  'alumnos', 'sesiones', 'horas', 'presupuesto_max', 'margen_obj', 'precio_ofertado', 'alumnos_reales', 'costo_mat_real', 'valor_unit', 'costo_puesto', 'dia', 'feria_dia', 'n'];

const LISTAS_BASE = {
  tipo_insumo: ['Materia prima', 'Envase', 'Etiqueta', 'Otro'],
  unidad: ['g', 'ml', 'u', 'gotas', 'cm'],
  categoria: [],
  motivo_ajuste: ['Carga inicial', 'Conteo físico', 'Merma o pérdida', 'Vencido', 'Uso interno o muestra', 'Otro'],
  canal_venta: ['Instagram', 'WhatsApp', 'Online', 'Venta directa'] // «Feria» es fijo (no está en la lista)
};
const CANAL_FERIA = 'Feria';

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
      setConfig: setConfig_, setEmpresaDatos: setEmpresaDatos_,
      saveCliente: saveCliente_, deleteCliente: deleteCliente_, restoreCliente: restoreCliente_,
      ventaRapida: ventaRapida_, saveOrden: saveOrden_, entregarOrden: entregarOrden_,
      asignarFolio: asignarFolio_, registrarPago: registrarPago_, anularPago: anularPago_, anularVenta: anularVenta_,
      entregarConsignacion: entregarConsignacion_, anularConsignacion: anularConsignacion_,
      liquidar: liquidar_, anularLiquidacion: anularLiquidacion_,
      saveProyecto: saveProyecto_, estadoProyecto: estadoProyecto_, ejecutarProyecto: ejecutarProyecto_,
      anularEjecucion: anularEjecucion_, facturarProyecto: facturarProyecto_, deleteProyecto: deleteProyecto_,
      saveFeria: saveFeria_, deleteFeria: deleteFeria_, restoreFeria: restoreFeria_,
      savePersona: savePersona_, deletePersona: deletePersona_, restorePersona: restorePersona_, setPersonaVenta: setPersonaVenta_,
      saveEvento: saveEvento_, deleteEvento: deleteEvento_, setSeguimiento: setSeguimiento_,
      gcalActivar: gcalActivar_, gcalDesactivar: gcalDesactivar_, gcalSync: gcalSync_
    };
    // Acciones que cambian fechas del calendario: después se copia a Google Calendar (si está activado).
    const tocaCal = ['saveFeria', 'deleteFeria', 'restoreFeria', 'saveProyecto', 'estadoProyecto', 'deleteProyecto', 'saveEvento', 'deleteEvento'];
    if (action === 'getAll') {
      const hay = {}; readAll_('LISTAS').forEach(function (r) { hay[r.lista] = true; });
      if (Object.keys(LISTAS_BASE).some(function (l) { return !hay[l]; })) conLock_(sembrarListas_); // primera vez o lista nueva tras actualizar
      return json_(getAll_());
    }
    if (writes[action]) return json_(conLock_(function () { const r = writes[action](body); if (tocaCal.indexOf(action) >= 0) gcalIntentar_(); return r; }));
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

/** Reglas de seguimiento de clientes habituales (días). */
function setSeguimiento_(b) {
  const una = Math.round(num_(b.seg_una)), min = Math.round(num_(b.seg_min));
  if (!(una >= 7 && una <= 365) || !(min >= 1 && min <= 180)) throw new Error('Usa entre 7 y 365 días (una compra) y entre 1 y 180 días (mínimo).');
  [['seg_una', una], ['seg_min', min]].forEach(function (kv) {
    const row = readAll_('CONFIG').filter(function (r) { return r.clave === kv[0]; })[0];
    if (row) { row.valor = String(kv[1]); update_('CONFIG', row); } else append_('CONFIG', [{ clave: kv[0], valor: String(kv[1]) }]);
  });
  return { ok: true };
}

/** Crea las listas que aún no existen (primera instalación o listas nuevas tras una actualización). */
function sembrarListas_() {
  const existentes = {};
  readAll_('LISTAS').forEach(function (r) { existentes[r.lista] = true; });
  const filas = [];
  Object.keys(LISTAS_BASE).forEach(function (lista) {
    if (existentes[lista]) return;
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
  if (lista === 'canal_venta') return { hoja: 'VENTAS', campo: 'medio_venta', filas: readAll_('VENTAS').filter(function (v) { return norm_(v.medio_venta) === n; }) };
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
  if (b.lista === 'canal_venta' && norm_(valor) === norm_(CANAL_FERIA)) throw new Error('«Feria» ya existe como canal fijo (con su calendario de ferias).');
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
  u.filas.forEach(function (r) {
    if (b.lista === 'canal_venta' && !r.feria_id && norm_(r.lugar) === norm_(r.medio_venta)) r.lugar = nuevo;
    r[u.campo] = nuevo; update_(u.hoja, r);
  });
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
    config: cfg,
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
    empresas: readAll_('EMPRESAS').map(strip_),
    locales: readAll_('LOCALES').map(strip_),
    precios_cliente: readAll_('PRECIOS_CLIENTE').map(strip_),
    ventas: desc(readAll_('VENTAS'), 5000),
    ventas_det: readAll_('VENTAS_DET').map(strip_),
    pagos: readAll_('PAGOS').map(strip_),
    consignaciones: desc(readAll_('CONSIGNACIONES'), 2000),
    consig_det: readAll_('CONSIG_DET').map(strip_),
    liquidaciones: desc(readAll_('LIQUIDACIONES'), 2000),
    liq_det: readAll_('LIQ_DET').map(strip_),
    proyectos: desc(readAll_('PROYECTOS'), 2000),
    proy_mat: readAll_('PROY_MAT').map(strip_),
    proy_costos: readAll_('PROY_COSTOS').map(strip_),
    ferias: readAll_('FERIAS').map(strip_),
    feria_dias: readAll_('FERIA_DIAS').map(strip_),
    personas: readAll_('PERSONAS').map(strip_),
    proy_sesiones: readAll_('PROY_SESIONES').map(strip_),
    eventos: readAll_('EVENTOS').map(strip_),
    gcal_activo: !!PropertiesService.getScriptProperties().getProperty('GCAL_ID'),
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
  if (d.tipo !== 'servicio' && num_(d.rinde_lote) <= 0) throw new Error('Indica cuántas unidades rinde un lote.');
  if (d.tipo === 'servicio') { d.rinde_lote = d.rinde_lote || 1; b.receta = []; }
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
  // Desde 2.0.1 hay un solo precio para negocios (B2B, neto). Las columnas antiguas quedan vacías.
  prod.precio_b2b = num_(d.precio_b2b); prod.precio_directo = ''; prod.precio_consig = '';
  prod.stock_min = num_(d.stock_min); prod.actualizado = now_();
  prod.tipo = d.tipo === 'servicio' ? 'servicio' : '';
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


// ─────────────────────────────────────────────────────────────
// Datos de la empresa (encabezado de las órdenes)
// ─────────────────────────────────────────────────────────────
const CLAVES_EMPRESA = ['emp_razon', 'emp_rut', 'emp_giro', 'emp_direccion', 'emp_telefono', 'emp_email'];
function setEmpresaDatos_(b) {
  const cfg = readAll_('CONFIG');
  CLAVES_EMPRESA.forEach(function (k) {
    const v = String((b.datos || {})[k] || '').trim().slice(0, 200);
    const row = cfg.filter(function (r) { return r.clave === k; })[0];
    if (row) { row.valor = v; update_('CONFIG', row); } else append_('CONFIG', [{ clave: k, valor: v }]);
  });
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Clientes: empresas (por RUT) con sus locales y precios negociados
// ─────────────────────────────────────────────────────────────
function normRut_(r) {
  const s = String(r || '').toUpperCase().replace(/[^0-9K]/g, '');
  if (s.length < 2) return '';
  return s.slice(0, -1).replace(/^0+/, '') + '-' + s.slice(-1);
}
function rutValido_(r) {
  const m = String(r).match(/^(\d{1,9})-([\dK])$/);
  if (!m) return false;
  let suma = 0, mul = 2;
  for (let i = m[1].length - 1; i >= 0; i--) { suma += Number(m[1][i]) * mul; mul = mul === 7 ? 2 : mul + 1; }
  const dv = 11 - (suma % 11);
  return m[2] === (dv === 11 ? '0' : dv === 10 ? 'K' : String(dv));
}
function empresa_(rut) { return readAll_('EMPRESAS').filter(function (e) { return e.rut === rut; })[0] || null; }
function clienteUsado_(rut) {
  return readAll_('VENTAS').some(function (v) { return v.rut === rut; }) || readAll_('CONSIGNACIONES').some(function (c) { return c.rut === rut; });
}
function localUsado_(id) {
  return readAll_('VENTAS').some(function (v) { return v.local_id === id; }) || readAll_('CONSIGNACIONES').some(function (c) { return c.local_id === id; });
}

function saveCliente_(b) {
  const e = b.empresa || {};
  const nuevo = !b.rut_original;
  const rut = normRut_(nuevo ? e.rut : b.rut_original);
  if (!rutValido_(rut)) throw new Error('El RUT ' + (e.rut || '') + ' no es válido. Revisa el dígito verificador.');
  const razon = String(e.razon_social || '').trim();
  if (!razon) throw new Error('Falta la razón social.');
  let emp = empresa_(rut);
  if (nuevo && emp) throw new Error('Ya existe un cliente con el RUT ' + rut + ' (' + emp.razon_social + ').');
  if (!nuevo && !emp) throw new Error('No encontré ese cliente.');
  if (!emp) emp = { rut: rut, estado: 'activo', creado: now_() };
  const mods = (e.modalidades || []).filter(function (m) { return m === 'directa' || m === 'consignacion'; });
  if (!mods.length) throw new Error('Marca al menos una modalidad (venta directa o consignación).');
  ['giro', 'direccion', 'comuna', 'email', 'telefono', 'contacto', 'notas'].forEach(function (k) { emp[k] = String(e[k] || '').trim(); });
  emp.razon_social = razon; emp.cond_pago_dias = num_(e.cond_pago_dias);
  emp.modalidades = mods.join(','); emp.modalidad_habitual = mods.indexOf(e.modalidad_habitual) >= 0 ? e.modalidad_habitual : mods[0];
  emp.actualizado = now_();

  // Locales: al menos uno; el nombre del local identifica al cliente en la app, así que no se repite.
  const locs = (b.locales || []).filter(function (l) { return String(l.nombre || '').trim(); });
  if (!locs.length) throw new Error('Agrega al menos un local (el nombre con que lo conoces).');
  const todos = readAll_('LOCALES');
  const nombres = {};
  locs.forEach(function (l) {
    const n = norm_(l.nombre);
    if (nombres[n]) throw new Error('El local «' + l.nombre + '» está repetido.');
    nombres[n] = 1;
    const otro = todos.filter(function (x) { return x.estado === 'activo' && norm_(x.nombre) === n && x.id !== l.id && x.rut !== rut; })[0];
    if (otro) throw new Error('Ya existe un local llamado «' + otro.nombre + '» de otro cliente. Usa un nombre distinto (ej. agrega la comuna).');
  });

  if (emp._row) update_('EMPRESAS', emp); else append_('EMPRESAS', [emp]);
  const suyos = todos.filter(function (x) { return x.rut === rut; });
  const enviados = {};
  locs.forEach(function (l) {
    const cur = l.id ? suyos.filter(function (x) { return x.id === l.id; })[0] : null;
    const obj = cur || { id: uid_('LOC'), rut: rut, creado: now_() };
    ['nombre', 'direccion', 'comuna', 'contacto', 'telefono', 'email'].forEach(function (k) { obj[k] = String(l[k] || '').trim(); });
    obj.estado = 'activo';
    if (cur) update_('LOCALES', cur); else append_('LOCALES', [obj]);
    enviados[obj.id] = 1;
  });
  // Locales quitados: se archivan si tienen historia o stock en consignación; si no, se borran.
  const borrar = [];
  readAll_('LOCALES').forEach(function (x) {
    if (x.rut !== rut || enviados[x.id]) return;
    if (localUsado_(x.id)) { x.estado = 'archivado'; update_('LOCALES', x); } else borrar.push(x);
  });
  deleteRows_('LOCALES', borrar);

  // Precios negociados por empresa (reemplazo completo).
  deleteRows_('PRECIOS_CLIENTE', readAll_('PRECIOS_CLIENTE').filter(function (pc) { return pc.rut === rut; }));
  append_('PRECIOS_CLIENTE', (b.precios || []).filter(function (pc) { return pc.producto_id && num_(pc.precio) > 0; })
    .map(function (pc) { return { rut: rut, producto_id: pc.producto_id, precio: num_(pc.precio) }; }));
  return { ok: true, rut: rut };
}

function deleteCliente_(b) {
  const emp = empresa_(b.rut);
  if (!emp) throw new Error('No encontré ese cliente.');
  if (clienteUsado_(emp.rut)) {
    emp.estado = 'archivado'; emp.actualizado = now_(); update_('EMPRESAS', emp);
    return { ok: true, result: 'archivado' };
  }
  deleteRows_('PRECIOS_CLIENTE', readAll_('PRECIOS_CLIENTE').filter(function (pc) { return pc.rut === emp.rut; }));
  deleteRows_('LOCALES', readAll_('LOCALES').filter(function (l) { return l.rut === emp.rut; }));
  deleteRows_('EMPRESAS', [emp]);
  return { ok: true, result: 'eliminado' };
}

function restoreCliente_(b) {
  const emp = empresa_(b.rut);
  if (!emp) throw new Error('No encontré ese cliente.');
  emp.estado = 'activo'; emp.actualizado = now_(); update_('EMPRESAS', emp);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Ventas: utilidades
// ─────────────────────────────────────────────────────────────
function lineasVenta_(lineas) {
  const prods = {};
  readAll_('PRODUCTOS').forEach(function (p) { prods[p.id] = p; });
  const out = (lineas || []).filter(function (l) { return l && l.producto_id && num_(l.cantidad) > 0; }).map(function (l) {
    const p = prods[l.producto_id];
    if (!p) throw new Error('Hay un producto que no existe.');
    return { producto_id: p.id, cantidad: num_(l.cantidad), precio: num_(l.precio), costo_unit: Math.round(costoReceta_(p.id, p.rinde_lote, 0)), servicio: p.tipo === 'servicio' };
  });
  if (!out.length) throw new Error('Agrega al menos un producto con cantidad.');
  return out;
}
function guardarDetalle_(ventaId, lineas) {
  deleteRows_('VENTAS_DET', readAll_('VENTAS_DET').filter(function (d) { return d.venta_id === ventaId; }));
  append_('VENTAS_DET', lineas.map(function (l) {
    return { venta_id: ventaId, producto_id: l.producto_id, cantidad: l.cantidad, precio: l.precio, subtotal: Math.round(l.cantidad * l.precio), costo_unit: l.costo_unit };
  }));
}
function totalesNeto_(lineas) {
  const neto = Math.round(lineas.reduce(function (s, l) { return s + l.cantidad * l.precio; }, 0));
  const iva = Math.round(neto * IVA);
  return { neto: neto, iva: iva, total: neto + iva };
}
function localActivo_(id) {
  const l = readAll_('LOCALES').filter(function (x) { return x.id === id; })[0];
  if (!l) throw new Error('Elige el local del cliente.');
  return l;
}
function pagadoDe_(ventaId) {
  return readAll_('PAGOS').filter(function (p) { return p.venta_id === ventaId && p.estado === 'activo'; })
    .reduce(function (s, p) { return s + p.monto; }, 0);
}

// ─────────────────────────────────────────────────────────────
// Venta rápida (ferias y público): precios con IVA, pagada al momento
// ─────────────────────────────────────────────────────────────
function ventaRapida_(b) {
  const lineas = lineasVenta_(b.lineas);
  const medios = ['Débito', 'Crédito', 'Efectivo', 'Transferencia'];
  if (medios.indexOf(b.medio_pago) === -1) throw new Error('Elige el medio de pago.');
  const total = Math.round(lineas.reduce(function (s, l) { return s + l.cantidad * l.precio; }, 0));
  const neto = Math.round(total / (1 + IVA));
  const fecha = validDate_(b.fecha);
  // Canal: «Feria» (con su feria y día) o uno de la lista de canales. Ventas de apps antiguas traen solo «lugar».
  const canalV = String(b.medio_venta || '').trim();
  let feria = null, dia = '';
  if (norm_(canalV) === norm_(CANAL_FERIA)) {
    feria = findById_('FERIAS', b.feria_id);
    if (!feria || feria.estado !== 'activa') throw new Error('Elige la feria (o créala en Ferias).');
    const d = readAll_('FERIA_DIAS').filter(function (x) { return x.feria_id === feria.id && x.fecha === fecha; })[0];
    dia = d ? d.dia : '';
  }
  const persona = personaVenta_(b);
  const v = {
    id: nextSeq_('VENTAS', 'V'), fecha: fecha, canal: 'publico', rut: '', local_id: '', estado: 'entregada',
    neto: neto, iva: total - neto, total: total, folio: '', fecha_folio: '', medio_pago: b.medio_pago,
    lugar: feria ? feria.nombre : (canalV || String(b.lugar || '').trim()), origen: '', notas: String(b.comprador || '').trim(),
    creado: now_(), actualizado: now_(),
    medio_venta: feria ? CANAL_FERIA : canalV, feria_id: feria ? feria.id : '', feria_dia: dia, persona_id: persona ? persona.id : ''
  };
  if (canalV && !feria) asegurarEnLista_('canal_venta', canalV);
  append_('VENTAS', [v]);
  guardarDetalle_(v.id, lineas);
  append_('MOVIMIENTOS', lineas.filter(function (l) { return !l.servicio; }).map(function (l) { return mov_(fecha, 'venta', 'producto', l.producto_id, -l.cantidad, v.id, v.lugar || 'Venta rápida'); }));
  append_('PAGOS', [{ id: uid_('PG'), venta_id: v.id, fecha: fecha, monto: total, medio: b.medio_pago, estado: 'activo', creado: now_() }]);
  return { ok: true, venta: v };
}

/** Cliente habitual de la venta: uno existente (persona_id) o uno nuevo creado en el momento (persona_nueva). */
function personaVenta_(b) {
  if (b.persona_id) {
    const p = findById_('PERSONAS', b.persona_id);
    if (!p) throw new Error('No encontré a ese cliente.');
    return p;
  }
  const nv = b.persona_nueva;
  if (!nv || !String(nv.nombre || '').trim()) return null;
  const nombre = String(nv.nombre).trim();
  const ex = readAll_('PERSONAS').filter(function (p) { return norm_(p.nombre) === norm_(nombre) && p.estado === 'activo'; })[0];
  if (ex) return ex;
  const p = { id: nextSeq_('PERSONAS', 'P'), nombre: nombre, telefono: String(nv.telefono || '').trim(), instagram: '', email: '', notas: '', estado: 'activo', creado: now_(), actualizado: now_() };
  append_('PERSONAS', [p]);
  return p;
}

// ─────────────────────────────────────────────────────────────
// Ferias: calendario (varios días con horario) y costo del puesto. Las ventas rápidas quedan con feria y día.
// ─────────────────────────────────────────────────────────────
function saveFeria_(b) {
  const f0 = b.feria || {};
  const nombre = String(f0.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre de la feria.');
  const dias = (b.dias || []).filter(function (d) { return d && /^\d{4}-\d{2}-\d{2}$/.test(String(d.fecha || '')); })
    .sort(function (a, c) { return String(a.fecha).localeCompare(String(c.fecha)); });
  if (!dias.length) throw new Error('Agrega al menos un día con su fecha.');
  const vistos = {};
  dias.forEach(function (d) { if (vistos[d.fecha]) throw new Error('El día ' + d.fecha + ' está repetido.'); vistos[d.fecha] = true; });
  let f;
  if (f0.id) { f = findById_('FERIAS', f0.id); if (!f) throw new Error('No encontré esa feria.'); }
  else f = { id: nextSeq_('FERIAS', 'FE'), estado: 'activa', creado: now_() };
  f.nombre = nombre; f.lugar = String(f0.lugar || '').trim(); f.costo_puesto = num_(f0.costo_puesto) || '';
  f.notas = String(f0.notas || '').trim(); f.actualizado = now_();
  if (f._row) update_('FERIAS', f); else append_('FERIAS', [f]);
  deleteRows_('FERIA_DIAS', readAll_('FERIA_DIAS').filter(function (d) { return d.feria_id === f.id; }));
  append_('FERIA_DIAS', dias.map(function (d, k) { return { feria_id: f.id, dia: k + 1, fecha: d.fecha, hora_inicio: String(d.hora_inicio || ''), hora_fin: String(d.hora_fin || '') }; }));
  // Las ventas ya registradas se vuelven a asignar al día que corresponde a su fecha (y al nombre nuevo).
  const porFecha = {};
  dias.forEach(function (d, k) { porFecha[d.fecha] = k + 1; });
  readAll_('VENTAS').filter(function (v) { return v.feria_id === f.id; }).forEach(function (v) {
    const nd = porFecha[v.fecha] || '';
    if ((Number(v.feria_dia) || 0) !== (nd || 0) || v.lugar !== f.nombre) { v.feria_dia = nd; v.lugar = f.nombre; update_('VENTAS', v); }
  });
  return { ok: true, feria: strip_(f) };
}

function deleteFeria_(b) {
  const f = findById_('FERIAS', b.id);
  if (!f) throw new Error('No encontré esa feria.');
  const conVentas = readAll_('VENTAS').some(function (v) { return v.feria_id === f.id && v.estado !== 'anulada'; });
  if (conVentas) { f.estado = 'archivada'; f.actualizado = now_(); update_('FERIAS', f); return { ok: true, result: 'archivada' }; }
  deleteRows_('FERIA_DIAS', readAll_('FERIA_DIAS').filter(function (d) { return d.feria_id === f.id; }));
  deleteRows_('FERIAS', [f]);
  return { ok: true, result: 'eliminada' };
}

function restoreFeria_(b) {
  const f = findById_('FERIAS', b.id);
  if (!f) throw new Error('No encontré esa feria.');
  f.estado = 'activa'; f.actualizado = now_(); update_('FERIAS', f);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Clientes habituales (personas): ficha liviana para seguimiento y fidelización.
// ─────────────────────────────────────────────────────────────
function savePersona_(b) {
  const nombre = String(b.nombre || '').trim();
  if (!nombre) throw new Error('Falta el nombre.');
  const otro = readAll_('PERSONAS').filter(function (p) { return p.id !== b.id && p.estado === 'activo' && norm_(p.nombre) === norm_(nombre); })[0];
  if (otro) throw new Error('Ya existe un cliente llamado «' + otro.nombre + '». Agrega el apellido o una referencia para distinguirlos.');
  let p;
  if (b.id) { p = findById_('PERSONAS', b.id); if (!p) throw new Error('No encontré ese cliente.'); }
  else p = { id: nextSeq_('PERSONAS', 'P'), estado: 'activo', creado: now_() };
  p.nombre = nombre; p.telefono = String(b.telefono || '').trim(); p.instagram = String(b.instagram || '').trim().replace(/^@/, '');
  p.email = String(b.email || '').trim(); p.notas = String(b.notas || '').trim(); p.actualizado = now_();
  if (p._row) update_('PERSONAS', p); else append_('PERSONAS', [p]);
  return { ok: true, persona: strip_(p) };
}

function deletePersona_(b) {
  const p = findById_('PERSONAS', b.id);
  if (!p) throw new Error('No encontré ese cliente.');
  if (readAll_('VENTAS').some(function (v) { return v.persona_id === p.id; })) { p.estado = 'archivado'; p.actualizado = now_(); update_('PERSONAS', p); return { ok: true, result: 'archivado' }; }
  deleteRows_('PERSONAS', [p]);
  return { ok: true, result: 'eliminado' };
}

function restorePersona_(b) {
  const p = findById_('PERSONAS', b.id);
  if (!p) throw new Error('No encontré ese cliente.');
  p.estado = 'activo'; p.actualizado = now_(); update_('PERSONAS', p);
  return { ok: true };
}

/** Cambiar el cliente habitual de una venta rápida ya registrada (o quitarlo). */
function setPersonaVenta_(b) {
  const v = findById_('VENTAS', b.venta_id);
  if (!v || v.canal !== 'publico') throw new Error('Solo se puede en ventas rápidas.');
  const p = personaVenta_(b);
  v.persona_id = p ? p.id : ''; v.actualizado = now_(); update_('VENTAS', v);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Calendario: eventos libres + copia opcional a Google Calendar (calendario «Magia Verde»).
// ─────────────────────────────────────────────────────────────
function saveEvento_(b) {
  const titulo = String(b.titulo || '').trim();
  if (!titulo) throw new Error('Falta el título del evento.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha || ''))) throw new Error('Falta la fecha.');
  const fin = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fecha_fin || '')) && b.fecha_fin > b.fecha ? b.fecha_fin : '';
  let e;
  if (b.id) { e = findById_('EVENTOS', b.id); if (!e) throw new Error('No encontré ese evento.'); }
  else e = { id: nextSeq_('EVENTOS', 'EV'), estado: 'activo', creado: now_() };
  e.titulo = titulo; e.fecha = b.fecha; e.fecha_fin = fin;
  e.hora_inicio = fin ? '' : String(b.hora_inicio || ''); e.hora_fin = fin ? '' : String(b.hora_fin || '');
  e.lugar = String(b.lugar || '').trim(); e.notas = String(b.notas || '').trim(); e.actualizado = now_();
  if (e._row) update_('EVENTOS', e); else append_('EVENTOS', [e]);
  return { ok: true, evento: strip_(e) };
}

function deleteEvento_(b) {
  const e = findById_('EVENTOS', b.id);
  if (!e) throw new Error('No encontré ese evento.');
  deleteRows_('EVENTOS', [e]);
  return { ok: true };
}

const ESTADOS_CAL = ['adjudicado', 'ejecutado', 'cerrado']; // proyectos que van a Google Calendar (los postulados solo se ven en la app)

/** Todos los eventos del calendario (ferias, sesiones de proyectos adjudicados, eventos libres), con una clave estable. */
function eventosCal_() {
  const out = [];
  const diasPorFeria = {};
  readAll_('FERIA_DIAS').forEach(function (d) { (diasPorFeria[d.feria_id] = diasPorFeria[d.feria_id] || []).push(d); });
  readAll_('FERIAS').filter(function (f) { return f.estado === 'activa'; }).forEach(function (f) {
    const ds = (diasPorFeria[f.id] || []).sort(function (a, c) { return a.fecha.localeCompare(c.fecha); });
    ds.forEach(function (d, k) {
      out.push({ clave: 'FE:' + f.id + ':' + d.fecha, titulo: 'Feria: ' + f.nombre + (ds.length > 1 ? ' (día ' + (k + 1) + ' de ' + ds.length + ')' : ''),
        fecha: d.fecha, fin: '', hi: d.hora_inicio, hf: d.hora_fin, lugar: f.lugar, notas: f.notas });
    });
  });
  const sesPorProy = {};
  readAll_('PROY_SESIONES').forEach(function (x) { (sesPorProy[x.proyecto_id] = sesPorProy[x.proyecto_id] || []).push(x); });
  readAll_('PROYECTOS').filter(function (p) { return ESTADOS_CAL.indexOf(p.estado) >= 0; }).forEach(function (p) {
    const pref = (p.origen === 'Licitación' || p.origen === 'Compra Ágil') ? 'Licitación: ' : 'Taller: ';
    const ses = (sesPorProy[p.id] || []).sort(function (a, c) { return a.fecha.localeCompare(c.fecha); });
    if (ses.length) ses.forEach(function (x, k) {
      out.push({ clave: 'FP:' + p.id + ':' + x.fecha + ':' + k, titulo: pref + p.nombre + (ses.length > 1 ? ' (sesión ' + (k + 1) + ' de ' + ses.length + ')' : ''),
        fecha: x.fecha, fin: '', hi: x.hora_inicio, hf: x.hora_fin, lugar: x.lugar || p.institucion, notas: p.institucion });
    });
    else if (p.fecha_inicio) out.push({ clave: 'FP:' + p.id, titulo: pref + p.nombre, fecha: p.fecha_inicio, fin: p.fecha_fin > p.fecha_inicio ? p.fecha_fin : '', hi: '', hf: '', lugar: p.institucion, notas: '' });
  });
  readAll_('EVENTOS').filter(function (e) { return e.estado === 'activo'; }).forEach(function (e) {
    out.push({ clave: 'EV:' + e.id, titulo: e.titulo, fecha: e.fecha, fin: e.fecha_fin, hi: e.hora_inicio, hf: e.hora_fin, lugar: e.lugar, notas: e.notas });
  });
  return out;
}

function fechaHora_(f, h) {
  const p = String(f).split('-').map(Number), t = String(h || '0:0').split(':').map(Number);
  return new Date(p[0], p[1] - 1, p[2], t[0] || 0, t[1] || 0);
}

/** Deja el calendario de Google igual a los eventos de la app: crea, cambia (borra y crea) o borra solo lo necesario. */
function gcalSync_() {
  const calId = PropertiesService.getScriptProperties().getProperty('GCAL_ID');
  if (!calId) return { ok: true, activo: false };
  const cal = CalendarApp.getCalendarById(calId);
  if (!cal) throw new Error('No encuentro el calendario de Google. Desactívalo y vuelve a activarlo en Configuración.');
  const quiero = {};
  eventosCal_().forEach(function (e) { quiero[e.clave] = e; });
  const filas = readAll_('GCAL'), vistas = {};
  let creados = 0, borrados = 0;
  const borrar = function (id) { try { const ev = cal.getEventById(id); if (ev) ev.deleteEvent(); } catch (x) { } borrados++; };
  const crear = function (e) {
    let ev;
    if (e.hi) {
      const ini = fechaHora_(e.fecha, e.hi), fin = e.hf && e.hf > e.hi ? fechaHora_(e.fecha, e.hf) : new Date(ini.getTime() + 3600000);
      ev = cal.createEvent(e.titulo, ini, fin, { location: e.lugar || '', description: e.notas || '' });
      ev.addPopupReminder(60); ev.addPopupReminder(1440);
    } else {
      const ini = fechaHora_(e.fecha), fin = e.fin ? fechaHora_(e.fin) : null;
      ev = fin ? cal.createAllDayEvent(e.titulo, ini, new Date(fin.getTime() + 86400000), { location: e.lugar || '', description: e.notas || '' })
        : cal.createAllDayEvent(e.titulo, ini, { location: e.lugar || '', description: e.notas || '' });
      ev.addPopupReminder(540); // 15:00 del día anterior
    }
    creados++;
    return ev.getId();
  };
  const aBorrar = [];
  filas.forEach(function (r) {
    const e = quiero[r.clave];
    if (!e || vistas[r.clave]) { borrar(r.event_id); aBorrar.push(r); return; }
    vistas[r.clave] = true;
    const h = JSON.stringify(e);
    if (r.hash !== h) { borrar(r.event_id); r.event_id = crear(e); r.hash = h; r.actualizado = now_(); update_('GCAL', r); }
  });
  if (aBorrar.length) deleteRows_('GCAL', aBorrar);
  const nuevas = [];
  Object.keys(quiero).forEach(function (k) { if (!vistas[k]) { const e = quiero[k]; nuevas.push({ clave: k, event_id: crear(e), hash: JSON.stringify(e), actualizado: now_() }); } });
  if (nuevas.length) append_('GCAL', nuevas);
  setCfg_('gcal_ultimo', now_()); setCfg_('gcal_error', '');
  return { ok: true, activo: true, creados: creados, borrados: borrados, total: Object.keys(quiero).length };
}

/** Sincroniza sin interrumpir el guardado si Google falla; el error queda visible en Configuración. */
function gcalIntentar_() {
  if (!PropertiesService.getScriptProperties().getProperty('GCAL_ID')) return;
  try { gcalSync_(); } catch (err) { setCfg_('gcal_error', String(err.message || err)); }
}

function setCfg_(k, v) {
  const row = readAll_('CONFIG').filter(function (r) { return r.clave === k; })[0];
  if (row) { row.valor = v; update_('CONFIG', row); } else append_('CONFIG', [{ clave: k, valor: v }]);
}

function gcalActivar_() {
  const props = PropertiesService.getScriptProperties();
  let cal = props.getProperty('GCAL_ID') ? CalendarApp.getCalendarById(props.getProperty('GCAL_ID')) : null;
  if (!cal) {
    const ex = CalendarApp.getCalendarsByName('Magia Verde');
    cal = ex && ex.length ? ex[0] : CalendarApp.createCalendar('Magia Verde', { timeZone: 'America/Santiago', summary: 'Ferias, talleres y eventos (lo mantiene la app de Magia Verde)' });
    props.setProperty('GCAL_ID', cal.getId());
    deleteRows_('GCAL', readAll_('GCAL')); // calendario nuevo: se vuelve a crear todo
  }
  setCfg_('gcal_nombre', cal.getName());
  const r = gcalSync_();
  return { ok: true, calendario: cal.getName(), creados: r.creados };
}

function gcalDesactivar_() {
  PropertiesService.getScriptProperties().deleteProperty('GCAL_ID');
  setCfg_('gcal_nombre', ''); setCfg_('gcal_error', '');
  return { ok: true };
}

/**
 * Ejecutar UNA vez desde el editor (▶ con «autorizarCalendario» seleccionado) para dar permiso de Google Calendar.
 * Después: Implementar → Administrar implementaciones → editar → Nueva versión.
 */
function autorizarCalendario() {
  Logger.log('Permiso de Calendar listo. Calendario principal: ' + CalendarApp.getDefaultCalendar().getName());
}

// ─────────────────────────────────────────────────────────────
// Órdenes de venta a negocios (precios netos + IVA)
// Estados: borrador → entregada (descuenta stock). La factura (folio) y los pagos se registran aparte.
// ─────────────────────────────────────────────────────────────
function saveOrden_(b) {
  const loc = localActivo_(b.local_id);
  const emp = empresa_(loc.rut);
  if (!emp) throw new Error('El local no tiene empresa asociada.');
  const lineas = lineasVenta_(b.lineas);
  if (lineas.some(function (l) { return !(l.precio > 0); })) throw new Error('Todos los productos necesitan precio.');
  let v;
  if (b.id) {
    v = findById_('VENTAS', b.id);
    if (!v) throw new Error('No encontré esa orden.');
    if (v.estado !== 'borrador') throw new Error('Solo se pueden editar órdenes en borrador.');
  } else {
    v = { id: nextSeq_('VENTAS', 'OV'), canal: 'directa', estado: 'borrador', folio: '', fecha_folio: '', medio_pago: '', lugar: '', origen: '', creado: now_() };
  }
  const t = totalesNeto_(lineas);
  v.fecha = validDate_(b.fecha); v.rut = emp.rut; v.local_id = loc.id; v.neto = t.neto; v.iva = t.iva; v.total = t.total;
  v.notas = String(b.notas || '').trim(); v.actualizado = now_();
  if (v._row) update_('VENTAS', v); else append_('VENTAS', [v]);
  guardarDetalle_(v.id, lineas);
  if (b.entregar) entregarOrden_({ id: v.id, fecha: v.fecha });
  return { ok: true, venta: strip_(findById_('VENTAS', v.id)) };
}

function entregarOrden_(b) {
  const v = findById_('VENTAS', b.id);
  if (!v) throw new Error('No encontré esa orden.');
  if (v.estado !== 'borrador') throw new Error('La orden ya fue entregada o anulada.');
  const fecha = validDate_(b.fecha || v.fecha);
  const det = readAll_('VENTAS_DET').filter(function (d) { return d.venta_id === v.id; });
  // El costo se congela al momento de entregar (para calcular el margen real de la venta).
  const prods = {};
  readAll_('PRODUCTOS').forEach(function (p) { prods[p.id] = p; });
  det.forEach(function (d) { const p = prods[d.producto_id]; if (p) { d.costo_unit = Math.round(costoReceta_(p.id, p.rinde_lote, 0)); update_('VENTAS_DET', d); } });
  append_('MOVIMIENTOS', det.filter(function (d) { return prods[d.producto_id] && prods[d.producto_id].tipo !== 'servicio'; }).map(function (d) { return mov_(fecha, 'venta', 'producto', d.producto_id, -d.cantidad, v.id, 'Orden de venta'); }));
  v.estado = 'entregada'; v.fecha = fecha; v.actualizado = now_(); update_('VENTAS', v);
  return { ok: true };
}

/** Asigna (o quita, con folio vacío) el folio SII a una o varias órdenes (factura múltiple). */
function asignarFolio_(b) {
  const ids = b.ids || [b.id];
  const folio = String(b.folio || '').trim();
  ids.forEach(function (id) {
    const v = findById_('VENTAS', id);
    if (!v) throw new Error('No encontré la orden ' + id + '.');
    if (v.canal === 'publico') throw new Error('Las ventas rápidas no llevan folio de factura.');
    if (v.estado !== 'entregada') throw new Error('La orden ' + id + ' debe estar entregada para facturarla.');
    v.folio = folio; v.fecha_folio = folio ? validDate_(b.fecha) : ''; v.actualizado = now_(); update_('VENTAS', v);
  });
  return { ok: true };
}

function registrarPago_(b) {
  const v = findById_('VENTAS', b.venta_id);
  if (!v) throw new Error('No encontré esa venta.');
  if (v.estado !== 'entregada') throw new Error('Solo se registran pagos de ventas entregadas.');
  const monto = Math.round(num_(b.monto));
  if (monto <= 0) throw new Error('Ingresa el monto pagado.');
  const saldo = v.total - pagadoDe_(v.id);
  if (monto > saldo + 1) throw new Error('El pago (' + monto + ') es mayor que el saldo pendiente (' + saldo + ').');
  append_('PAGOS', [{ id: uid_('PG'), venta_id: v.id, fecha: validDate_(b.fecha), monto: monto, medio: String(b.medio || '').trim() || 'Transferencia', estado: 'activo', creado: now_() }]);
  return { ok: true };
}

function anularPago_(b) {
  const p = findById_('PAGOS', b.id);
  if (!p) throw new Error('No encontré ese pago.');
  p.estado = 'anulado'; update_('PAGOS', p);
  return { ok: true };
}

function anularVenta_(b) {
  const v = findById_('VENTAS', b.id);
  if (!v) throw new Error('No encontré esa venta.');
  if (v.estado === 'anulada') return { ok: true };
  if (v.origen && v.origen.indexOf('LQ-') === 0) throw new Error('Esta orden viene de la liquidación ' + v.origen + '. Anula la liquidación.');
  if (v.origen && v.origen.indexOf('FP-') === 0) { const pr = findById_('PROYECTOS', v.origen); if (pr && pr.venta_id === v.id) { pr.venta_id = ''; pr.actualizado = now_(); update_('PROYECTOS', pr); } }
  readAll_('PAGOS').forEach(function (p) { if (p.venta_id === v.id && p.estado === 'activo') { p.estado = 'anulado'; update_('PAGOS', p); } });
  anularMovsDeRef_(v.id);
  v.estado = 'anulada'; v.actualizado = now_(); update_('VENTAS', v);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Consignación: el producto sigue siendo de Magia Verde, pero está en el local del cliente.
// El stock se mueve de BODEGA a la ubicación LOCAL:<id>. Se cobra al liquidar.
// ─────────────────────────────────────────────────────────────
function entregarConsignacion_(b) {
  const loc = localActivo_(b.local_id);
  const lineas = lineasVenta_(b.lineas);
  const fecha = validDate_(b.fecha);
  const oc = { id: nextSeq_('CONSIGNACIONES', 'OC'), fecha: fecha, rut: loc.rut, local_id: loc.id, guia: String(b.guia || '').trim(), notas: String(b.notas || '').trim(), estado: 'entregada', creado: now_() };
  append_('CONSIGNACIONES', [oc]);
  append_('CONSIG_DET', lineas.map(function (l) { return { oc_id: oc.id, producto_id: l.producto_id, cantidad: l.cantidad, precio: l.precio }; }));
  const movs = [];
  lineas.forEach(function (l) {
    movs.push(mov_(fecha, 'consignacion', 'producto', l.producto_id, -l.cantidad, oc.id, 'A ' + loc.nombre));
    const m = mov_(fecha, 'consignacion', 'producto', l.producto_id, l.cantidad, oc.id, loc.nombre); m.ubicacion = 'LOCAL:' + loc.id; movs.push(m);
  });
  append_('MOVIMIENTOS', movs);
  return { ok: true, consignacion: oc };
}

function anularConsignacion_(b) {
  const oc = findById_('CONSIGNACIONES', b.id);
  if (!oc) throw new Error('No encontré esa consignación.');
  if (oc.estado === 'anulada') return { ok: true };
  const st = stockMap_();
  const det = readAll_('CONSIG_DET').filter(function (d) { return d.oc_id === oc.id; });
  det.forEach(function (d) {
    const enLocal = (st[d.producto_id] && st[d.producto_id]['LOCAL:' + oc.local_id]) || 0;
    if (enLocal < d.cantidad) throw new Error('Parte de esta entrega ya se liquidó. Anula primero la liquidación posterior.');
  });
  anularMovsDeRef_(oc.id);
  oc.estado = 'anulada'; update_('CONSIGNACIONES', oc);
  return { ok: true };
}

/**
 * Liquidación de un local: Javi cuenta lo que queda. Vendido = en local − contado.
 * Lo que se retira vuelve a bodega; el resto sigue en consignación.
 * Si hubo ventas, se genera una orden de venta (entregada) por lo vendido, lista para folio y cobro.
 */
function liquidar_(b) {
  const loc = localActivo_(b.local_id);
  const ubic = 'LOCAL:' + loc.id;
  const st = stockMap_();
  const prods = {};
  readAll_('PRODUCTOS').forEach(function (p) { prods[p.id] = p; });
  const fecha = validDate_(b.fecha);
  const lineas = (b.lineas || []).map(function (l) {
    const enLocal = (st[l.producto_id] && st[l.producto_id][ubic]) || 0;
    const contado = num_(l.contado), devuelto = num_(l.devuelto);
    const p = prods[l.producto_id];
    if (!p) throw new Error('Hay un producto que no existe.');
    if (contado < 0 || contado > enLocal) throw new Error(p.nombre + ': el conteo (' + contado + ') no puede ser mayor a lo que hay en el local (' + enLocal + ').');
    if (devuelto < 0 || devuelto > contado) throw new Error(p.nombre + ': lo que vuelve a bodega no puede ser mayor a lo contado.');
    return { producto_id: p.id, en_local: enLocal, contado: contado, vendido: round_(enLocal - contado), devuelto: devuelto, precio: num_(l.precio), costo_unit: Math.round(costoReceta_(p.id, p.rinde_lote, 0)) };
  }).filter(function (l) { return l.en_local > 0; });
  if (!lineas.length) throw new Error('Este local no tiene productos en consignación.');
  if (lineas.some(function (l) { return l.vendido > 0 && !(l.precio > 0); })) throw new Error('Falta el precio de algún producto vendido.');

  const lq = { id: nextSeq_('LIQUIDACIONES', 'LQ'), fecha: fecha, rut: loc.rut, local_id: loc.id, venta_id: '', notas: String(b.notas || '').trim(), estado: 'activa', creado: now_() };
  const vendidas = lineas.filter(function (l) { return l.vendido > 0; });
  if (vendidas.length) {
    const vl = vendidas.map(function (l) { return { producto_id: l.producto_id, cantidad: l.vendido, precio: l.precio, costo_unit: l.costo_unit }; });
    const t = totalesNeto_(vl);
    const v = { id: nextSeq_('VENTAS', 'OV'), fecha: fecha, canal: 'consignacion', rut: loc.rut, local_id: loc.id, estado: 'entregada', neto: t.neto, iva: t.iva, total: t.total,
      folio: '', fecha_folio: '', medio_pago: '', lugar: '', origen: lq.id, notas: 'Liquidación ' + lq.id, creado: now_(), actualizado: now_() };
    append_('VENTAS', [v]);
    guardarDetalle_(v.id, vl);
    lq.venta_id = v.id;
  }
  append_('LIQUIDACIONES', [lq]);
  append_('LIQ_DET', lineas.map(function (l) { return { lq_id: lq.id, producto_id: l.producto_id, en_local: l.en_local, contado: l.contado, vendido: l.vendido, devuelto: l.devuelto, precio: l.precio }; }));
  const movs = [];
  lineas.forEach(function (l) {
    if (l.vendido > 0) { const m = mov_(fecha, 'venta', 'producto', l.producto_id, -l.vendido, lq.id, 'Vendido en ' + loc.nombre); m.ubicacion = ubic; movs.push(m); }
    if (l.devuelto > 0) {
      const a = mov_(fecha, 'devolucion', 'producto', l.producto_id, -l.devuelto, lq.id, 'Retirado de ' + loc.nombre); a.ubicacion = ubic; movs.push(a);
      movs.push(mov_(fecha, 'devolucion', 'producto', l.producto_id, l.devuelto, lq.id, 'Vuelve de ' + loc.nombre));
    }
  });
  append_('MOVIMIENTOS', movs);
  return { ok: true, liquidacion: lq };
}

function anularLiquidacion_(b) {
  const lq = findById_('LIQUIDACIONES', b.id);
  if (!lq) throw new Error('No encontré esa liquidación.');
  if (lq.estado === 'anulada') return { ok: true };
  // Solo se puede anular la última liquidación del local (las siguientes partieron de su conteo).
  const posterior = readAll_('LIQUIDACIONES').some(function (x) { return x.local_id === lq.local_id && x.estado === 'activa' && x.id !== lq.id && (x.fecha + x.creado) > (lq.fecha + lq.creado); });
  if (posterior) throw new Error('Hay una liquidación posterior en este local. Anula primero la más reciente.');
  if (lq.venta_id) {
    const v = findById_('VENTAS', lq.venta_id);
    if (v && pagadoDe_(v.id) > 0) throw new Error('La orden ' + v.id + ' ya tiene pagos. Anula los pagos primero.');
    if (v && v.folio) throw new Error('La orden ' + v.id + ' ya tiene folio ' + v.folio + '. Quita el folio primero (y emite la nota de crédito en el SII si corresponde).');
    if (v) { v.estado = 'anulada'; v.actualizado = now_(); update_('VENTAS', v); }
  }
  anularMovsDeRef_(lq.id);
  lq.estado = 'anulada'; update_('LIQUIDACIONES', lq);
  return { ok: true };
}


// ─────────────────────────────────────────────────────────────
// Formación: talleres y cursos (licitaciones, Compra Ágil, trato directo o privados)
// Etapas: costeo → postulado → adjudicado → ejecutado → cerrado (o no_adjudicado / cancelado).
// Los materiales se costean por alumno; al ejecutar se descuentan del stock; la venta se
// genera como una orden (canal «formacion») que sigue el flujo normal de folio y cobro.
// ─────────────────────────────────────────────────────────────
const ESTADOS_PROY = ['costeo', 'postulado', 'adjudicado', 'ejecutado', 'cerrado', 'no_adjudicado', 'cancelado'];

function saveProyecto_(b) {
  const d = b.proyecto || {};
  const nombre = String(d.nombre || '').trim();
  if (!nombre) throw new Error('El proyecto necesita un nombre.');
  let pr;
  if (d.id) { pr = findById_('PROYECTOS', d.id); if (!pr) throw new Error('No encontré ese proyecto.'); }
  else pr = { id: nextSeq_('PROYECTOS', 'FP'), estado: 'costeo', venta_id: '', ejecutado_fecha: '', alumnos_reales: '', costo_mat_real: '', creado: now_() };
  const ejecutado = !!pr.ejecutado_fecha;
  ['nombre', 'institucion', 'id_licitacion', 'link_doc', 'notas'].forEach(function (k) { pr[k] = String(d[k] || '').trim(); });
  pr.origen = ['Licitación', 'Compra Ágil', 'Trato directo', 'Privado'].indexOf(d.origen) >= 0 ? d.origen : 'Licitación';
  pr.rut = d.rut ? normRut_(d.rut) : '';
  if (pr.rut && !rutValido_(pr.rut)) throw new Error('El RUT de la institución no es válido.');
  ['fecha_postulacion', 'fecha_inicio', 'fecha_fin'].forEach(function (k) { pr[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(d[k] || '')) ? d[k] : ''; });
  ['alumnos', 'sesiones', 'horas', 'presupuesto_max', 'margen_obj', 'precio_ofertado'].forEach(function (k) { pr[k] = num_(d[k]); });
  // Sesiones (fecha, horario y lugar de cada clase): definen inicio, término y cantidad de sesiones.
  const ses = Array.isArray(b.sesiones_det) ? b.sesiones_det.filter(function (x) { return x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.fecha || '')); })
    .sort(function (a, c) { return (a.fecha + (a.hora_inicio || '')).localeCompare(c.fecha + (c.hora_inicio || '')); }) : null;
  if (ses && ses.length) { pr.fecha_inicio = ses[0].fecha; pr.fecha_fin = ses[ses.length - 1].fecha; pr.sesiones = ses.length; }
  pr.afecto_iva = d.afecto_iva === 'no' ? 'no' : 'si';
  pr.nombre = nombre; pr.actualizado = now_();
  if (pr._row) update_('PROYECTOS', pr); else append_('PROYECTOS', [pr]);
  if (ses) {
    deleteRows_('PROY_SESIONES', readAll_('PROY_SESIONES').filter(function (x) { return x.proyecto_id === pr.id; }));
    append_('PROY_SESIONES', ses.map(function (x, k) { return { proyecto_id: pr.id, n: k + 1, fecha: x.fecha, hora_inicio: String(x.hora_inicio || ''), hora_fin: String(x.hora_fin || ''), lugar: String(x.lugar || '').trim() }; }));
  }
  if (!ejecutado || b.forzarMateriales) {
    const ins = {}, prods = {};
    readAll_('INSUMOS').forEach(function (i) { ins[i.id] = 1; });
    readAll_('PRODUCTOS').forEach(function (p) { prods[p.id] = 1; });
    const mats = (b.materiales || []).filter(function (m) { return m && m.ref && num_(m.cantidad) > 0 && (m.tipo === 'producto' ? prods[m.ref] : ins[m.ref]); });
    deleteRows_('PROY_MAT', readAll_('PROY_MAT').filter(function (m) { return m.proyecto_id === pr.id; }));
    append_('PROY_MAT', mats.map(function (m) { return { proyecto_id: pr.id, tipo: m.tipo === 'producto' ? 'producto' : 'insumo', ref: m.ref, cantidad: num_(m.cantidad) }; }));
  }
  const costos = (b.costos || []).filter(function (c) { return c && String(c.descripcion || '').trim() && num_(c.valor) > 0; });
  deleteRows_('PROY_COSTOS', readAll_('PROY_COSTOS').filter(function (c) { return c.proyecto_id === pr.id; }));
  append_('PROY_COSTOS', costos.map(function (c) { return { proyecto_id: pr.id, descripcion: String(c.descripcion).trim(), cantidad: num_(c.cantidad) || 1, valor_unit: num_(c.valor) }; }));
  return { ok: true, proyecto: strip_(findById_('PROYECTOS', pr.id)) };
}

function estadoProyecto_(b) {
  const pr = findById_('PROYECTOS', b.id);
  if (!pr) throw new Error('No encontré ese proyecto.');
  if (ESTADOS_PROY.indexOf(b.estado) === -1) throw new Error('Estado no válido.');
  if (b.estado === 'ejecutado' && !pr.ejecutado_fecha) throw new Error('Registra la ejecución para descontar los materiales.');
  if ((b.estado === 'cancelado' || b.estado === 'no_adjudicado') && pr.ejecutado_fecha) throw new Error('El proyecto ya se ejecutó. Anula la ejecución primero.');
  if (b.estado === 'postulado' && !pr.fecha_postulacion) pr.fecha_postulacion = today_();
  pr.estado = b.estado; pr.actualizado = now_(); update_('PROYECTOS', pr);
  return { ok: true };
}

/** Descuenta del stock los materiales (cantidad por alumno × alumnos reales) y guarda su costo. */
function ejecutarProyecto_(b) {
  const pr = findById_('PROYECTOS', b.id);
  if (!pr) throw new Error('No encontré ese proyecto.');
  if (pr.ejecutado_fecha) throw new Error('Este proyecto ya tiene la ejecución registrada.');
  const alumnos = num_(b.alumnos_reales) || pr.alumnos;
  if (!(alumnos > 0)) throw new Error('Indica cuántos alumnos participaron.');
  const fecha = validDate_(b.fecha);
  const ins = {}, prods = {};
  readAll_('INSUMOS').forEach(function (i) { ins[i.id] = i; });
  readAll_('PRODUCTOS').forEach(function (p) { prods[p.id] = p; });
  let costo = 0;
  const movs = [];
  readAll_('PROY_MAT').filter(function (m) { return m.proyecto_id === pr.id; }).forEach(function (m) {
    const q = round_(m.cantidad * alumnos);
    if (m.tipo === 'producto') {
      const p = prods[m.ref]; if (!p) return;
      costo += q * costoReceta_(p.id, p.rinde_lote, 0);
      if (p.tipo !== 'servicio') movs.push(mov_(fecha, 'formacion', 'producto', p.id, -q, pr.id, pr.nombre));
    } else {
      const i = ins[m.ref]; if (!i) return;
      costo += q * costoInsumo_(i);
      movs.push(mov_(fecha, 'formacion', 'insumo', i.id, -q, pr.id, pr.nombre));
    }
  });
  append_('MOVIMIENTOS', movs);
  pr.ejecutado_fecha = fecha; pr.alumnos_reales = alumnos; pr.costo_mat_real = Math.round(costo);
  if (pr.estado !== 'cerrado') pr.estado = 'ejecutado';
  pr.actualizado = now_(); update_('PROYECTOS', pr);
  return { ok: true };
}

function anularEjecucion_(b) {
  const pr = findById_('PROYECTOS', b.id);
  if (!pr) throw new Error('No encontré ese proyecto.');
  if (!pr.ejecutado_fecha) return { ok: true };
  anularMovsDeRef_(pr.id);
  pr.ejecutado_fecha = ''; pr.alumnos_reales = ''; pr.costo_mat_real = '';
  pr.estado = 'adjudicado'; pr.actualizado = now_(); update_('PROYECTOS', pr);
  return { ok: true };
}

/** Crea la orden de venta del proyecto (sin productos): queda lista para folio SII y pagos. */
function facturarProyecto_(b) {
  const pr = findById_('PROYECTOS', b.id);
  if (!pr) throw new Error('No encontré ese proyecto.');
  if (pr.venta_id) { const v0 = findById_('VENTAS', pr.venta_id); if (v0 && v0.estado !== 'anulada') throw new Error('Este proyecto ya tiene la orden ' + v0.id + '.'); }
  const neto = Math.round(num_(b.neto) || pr.precio_ofertado);
  if (!(neto > 0)) throw new Error('Indica el monto a facturar (precio ofertado).');
  const iva = pr.afecto_iva === 'no' ? 0 : Math.round(neto * IVA);
  // Documento: factura (queda por facturar hasta anotar el folio), boleta (número opcional) o sin documento.
  const doc = ['factura', 'boleta', 'ninguno'].indexOf(b.documento) >= 0 ? b.documento : 'factura';
  const v = { id: nextSeq_('VENTAS', 'OV'), fecha: validDate_(b.fecha), canal: 'formacion', rut: pr.rut, local_id: '', estado: 'entregada', neto: neto, iva: iva, total: neto + iva,
    documento: doc, folio: doc === 'boleta' ? String(b.numero || '').trim() : '', fecha_folio: doc === 'boleta' && b.numero ? validDate_(b.fecha) : '', medio_pago: '', lugar: pr.institucion || pr.nombre, origen: pr.id, notas: pr.nombre + (pr.id_licitacion ? ' · ' + pr.id_licitacion : ''), creado: now_(), actualizado: now_() };
  append_('VENTAS', [v]);
  pr.venta_id = v.id; pr.actualizado = now_(); update_('PROYECTOS', pr);
  return { ok: true, venta: v };
}

function deleteProyecto_(b) {
  const pr = findById_('PROYECTOS', b.id);
  if (!pr) throw new Error('No encontré ese proyecto.');
  const v = pr.venta_id ? findById_('VENTAS', pr.venta_id) : null;
  if (pr.ejecutado_fecha || (v && v.estado !== 'anulada')) {
    if (pr.ejecutado_fecha) throw new Error('El proyecto tiene ejecución registrada. Anúlala primero, o márcalo como cerrado.');
    throw new Error('El proyecto tiene la orden ' + v.id + '. Anúlala primero.');
  }
  deleteRows_('PROY_SESIONES', readAll_('PROY_SESIONES').filter(function (x) { return x.proyecto_id === pr.id; }));
  deleteRows_('PROY_MAT', readAll_('PROY_MAT').filter(function (m) { return m.proyecto_id === pr.id; }));
  deleteRows_('PROY_COSTOS', readAll_('PROY_COSTOS').filter(function (c) { return c.proyecto_id === pr.id; }));
  deleteRows_('PROYECTOS', [pr]);
  return { ok: true, result: 'eliminado' };
}
