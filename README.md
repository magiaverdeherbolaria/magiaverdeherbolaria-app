# Magia Verde · App de gestión — Fase 1

Incluye: insumos y compras (con costo por última compra), productos y recetas (costeo y márgenes en vivo),
producción (descuenta insumos y suma producto), inventario con ajustes y movimientos.
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
3. En el celular: abrir el enlace en Chrome → menú ⋮ → **Instalar app**.

## Cuando actualices la app

- Cambios en `Code.gs`: **Implementar → Administrar implementaciones → editar (lápiz) → Versión: Nueva versión → Implementar**.
  Así la URL no cambia. (Si creas una implementación nueva, cambia la URL y hay que pegarla otra vez en Configuración.)
- Cambios en `index.html`: sube el archivo y cambia `VERSION` en `sw.js` (ej. `mv-v2`) para que los celulares tomen la versión nueva.

## Reglas del sistema

- Nada con historia se borra: insumos y productos usados se **archivan**; compras y lotes se **anulan** (y devuelven el stock).
- El stock siempre es la suma de movimientos; los ajustes quedan registrados con su motivo.
- El costo de cada insumo es el de su **última compra** activa; si anulas esa compra, vuelve al de la anterior.
- Compras con boleta: elige «Con IVA» y la app guarda el costo neto.
