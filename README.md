# Magia Verde · App de gestión — versión 2.0.2

Incluye:
- **Ventas**: clientes (empresas por RUT con sus locales y precios negociados), venta rápida para ferias,
  órdenes de venta con PDF y WhatsApp, folio SII (también factura múltiple), pagos y cobranza,
  consignaciones con liquidación, historial de ventas con margen.
- **Producción y stock**: insumos (con varios formatos de compra e insumos elaborados), compras con historial,
  productos y recetas (costeo, márgenes e historial de costo), producción, inventario en bodega y en locales.
- **Configuración**: datos de la empresa, listas editables, método de costo, versión.
El menú ya muestra las secciones de la fase 2 (ventas, órdenes, consignaciones, clientes, talleres) como «pronto».

```
README.md            → este manual
index.html           → la app
sw.js                → permite instalarla como app
manifest.json
logo.png
icons/…
apps-script/         → respaldo del backend (NO lo usa la web: se copia y pega en Apps Script)
  Code.gs
  appsscript.json
```

Todo el contenido de esta carpeta va a la raíz del repositorio de GitHub.
Nunca subas al repositorio la URL /exec ni la clave: van solo en Configuración dentro de la app.

## 1. Planilla y Apps Script (cuenta MVH)

1. Crea una planilla vacía en el Drive de MVH, por ejemplo «Magia Verde · Base de datos».
2. En la planilla: **Extensiones → Apps Script**.
3. Borra lo que trae `Código.gs` y pega todo el contenido de `apps-script/Code.gs`. Guarda.
4. Zona horaria: en **Configuración del proyecto** (engranaje) marca «Mostrar el archivo de manifiesto appsscript.json»,
   abre `appsscript.json` y reemplázalo por el de esta carpeta. Guarda.
5. Arriba, elige la función **setup** y presiona **Ejecutar**. Acepta los permisos (con la cuenta MVH).
   Crea las hojas y muestra en el registro: `Clave de la app: xxxxxxxxxxxxxxxx`. **Copia esa clave.**
   (Si la pierdes, ejecuta `verClave`.)
6. **Implementar → Nueva implementación → Tipo: Aplicación web**
   - Ejecutar como: **Yo** (cuenta MVH)
   - Quién tiene acceso: **Cualquier usuario**
   - Implementar y **copia la URL** que termina en `/exec`.

> La clave protege la planilla: sin ella, la URL no responde datos.

## 2. GitHub Pages

1. En el repositorio de la cuenta de Magia Verde, sube **todo el contenido de esta carpeta** a la raíz.
2. **Settings → Pages → Branch: main / root → Save**. En un par de minutos queda en
   `https://<usuario>.github.io/<repositorio>/`.

## 3. Primer uso

1. Abre la app → **Configuración** → pega la URL `/exec` y la clave → **Guardar y conectar**.
2. Orden recomendado para cargar datos:
   1. **Insumos**: crea cada materia prima y envase con su unidad (g, ml, u) y stock mínimo.
   2. **Registrar compra** de cada insumo (así queda su costo), o ingresa el costo a mano al crearlo.
   3. **Inventario → Ajustar**: carga el stock real que tienes hoy (motivo «Carga inicial»).
   4. **Productos**: crea cada producto con su receta por lote y precios.
   5. Desde ahí, cada **producción** descuenta insumos y suma producto sola.
   6. **Configuración → Datos de la empresa**: razón social, RUT y contacto (salen en el PDF de las órdenes).
   7. **Clientes**: cada empresa con su RUT, sus locales y, si hay, sus precios negociados.
   8. Si hay productos que ya están en consignación en algún local, regístralos con **Entregar en consignación**
      (fecha real de entrega) para que la primera liquidación cuadre.
3. En el celular: abrir el enlace en Chrome → menú ⋮ → **Instalar app**.

## Cuando actualices la app

- Cambios en `Code.gs`: **Implementar → Administrar implementaciones → editar (lápiz) → Versión: Nueva versión → Implementar**.
  Así la URL no cambia. (Si creas una implementación nueva, cambia la URL y hay que pegarla otra vez en Configuración.)
- Cambios en `index.html`: sube el archivo y cambia `VERSION` en `sw.js` (ej. `mv-v8`) para que los celulares tomen la versión nueva.
- Para comprobar: **Configuración → Versión** muestra la versión de la app y la de Apps Script. Los dos primeros
  números deben coincidir (ej. 2.0.x); si no, la app muestra un aviso arriba. El último número puede diferir cuando
  un arreglo toca solo una de las partes.
- Las actualizaciones crean solas las hojas y columnas nuevas. No hace falta volver a ejecutar `setup`.

## Reglas del sistema

- Nada con historia se borra: insumos y productos usados se **archivan**; compras y lotes se **anulan** (y devuelven el stock).
- El stock siempre es la suma de movimientos; los ajustes quedan registrados con su motivo.
- El costo de cada insumo sale de sus entradas (compras, o lotes si es elaborado) según el **método de costo** de Configuración:
  **última entrada** (por defecto) o **costo promedio**. Si anulas una compra, el costo se recalcula sin ella.
- Listas (tipos, unidades, categorías, motivos): renombrar actualiza los registros; eliminar un valor en uso solo lo oculta.
- Precios: cada producto tiene dos precios, **B2C** (público, con IVA) y **B2B** (negocios, neto), más un
  **precio especial** opcional por empresa (en su ficha de Clientes) que vale para venta directa y consignación.
- Ventas: la venta rápida usa el precio B2C y queda pagada al momento. Las órdenes a negocios usan precios netos + IVA:
  el precio especial de la empresa si existe, si no el B2B del producto.
- Una orden en **borrador** no mueve stock; al **confirmar la entrega** sale de bodega. La factura se emite en el SII
  y aquí solo se anota el **folio**. Los pagos pueden ser parciales.
- **Consignación**: el producto pasa de bodega al local del cliente (sigue siendo de Magia Verde). Al **liquidar** se
  cuenta lo que queda: vendido = en el local − contado. Lo retirado vuelve a bodega y el resto sigue en consignación.
  La liquidación genera la orden de venta por lo vendido, lista para folio y cobro.
- Anular: una orden entregada devuelve el stock y anula sus pagos (si tenía folio, en el SII corresponde nota de crédito).
  La orden de una liquidación se anula anulando la liquidación (solo la más reciente de cada local).
- Compras: se ingresa siempre el **total pagado**. Con **factura** el costo se calcula sin IVA (se recupera como crédito fiscal);
  con **boleta o sin documento** el costo es todo lo pagado.
- **Formación**: cada taller o curso es un **proyecto** (origen: Licitación, Compra Ágil, Trato directo o Privado) que
  pasa por costeo → postulado → adjudicado → ejecutado → cerrado. Los materiales se indican **por alumno**; al
  **registrar la ejecución** se descuentan del stock según los alumnos reales. **Generar venta** crea la orden por el
  precio ofertado (afecto o exento de IVA) para anotar folio y pagos en Ventas y cobranza.
- **Servicios o cursos** (ej. el curso online): son productos de tipo servicio, sin receta ni stock. Se venden en
  venta rápida (lugar «Online» y, opcional, el nombre del comprador) y quedan en el historial de ventas.

## Versiones

- **2.1** — Nueva sección **Formación** (talleres y cursos: costeo con materiales por alumno y otros costos, precio
  sugerido según margen, control del presupuesto máximo con IVA, estados, ejecución que descuenta stock, venta y
  resultado final). Productos de tipo **servicio o curso** (sin stock ni receta) y campo **comprador** en venta rápida.
  Cambian las dos partes: subir `index.html` y `sw.js`, y en Apps Script pegar `Code.gs` y crear **Nueva versión**.
- **2.0.2** (solo app) — Botones de acción con fondo propio (WhatsApp, PDF, Anular…); «WhatsApp con PDF»: en el celular
  abre el menú de compartir con el PDF y el mensaje, en el computador descarga el PDF y abre el chat del cliente;
  casilla «Cant.» rotulada al entregar u ordenar. Apps Script sigue en 2.0.1.
- **2.0.1** — Un solo precio B2B por producto (antes había dos: directa y consignación) más el precio especial por
  empresa. Los precios ya cargados se conservan. Círculo oliva en el ícono de la sección activa (celular y computador).
- **2.0** — Fase de ventas: clientes con locales y precios negociados, venta rápida, órdenes de venta (PDF, WhatsApp,
  folio, pagos), consignaciones y liquidaciones, ventas y cobranza (historial con margen, por cobrar, por facturar,
  factura múltiple, CSV), datos de la empresa, inicio con ventas del mes, por cobrar y pendientes.
- **1.2** — Botón de sincronizar en el computador y sincronización automática al volver a la app; versión visible en
  Configuración con aviso si no coinciden; listas editables; varios formatos de compra por insumo (botones al comprar);
  stock y mínimo expresados en formatos («quedan 2 frascos»); insumos elaborados con receta propia (oleatos, tinturas,
  serigrafía) que se producen desde Producción; historial de compras con filtros, totales, IVA crédito fiscal y CSV;
  historial de precios por insumo y proveedor; historial de costo por producto; método de costo (última entrada o promedio).
- **1.1** — Compra por formato (ej. 2 bolsas × 250 g), selector Factura / Boleta con el costo correcto en cada caso,
  costo de referencia por kg o litro, notas explicativas (botón ⓘ) en los campos clave.
  Al actualizar, la planilla agrega sola las columnas nuevas; los datos existentes no se tocan.
- **1.0** — Insumos y compras, productos y recetas, producción, inventario.
