# Guía de instalación — Mis Gastos PWA

App personal de finanzas con solapas de Gastos, Salud, Gym, Comidas y Facultad.
Seguí los pasos en orden. Tardás ~30-40 minutos en tener todo andando.

---

## Lo que vas a necesitar

- Cuenta de Google
- Cuenta de GitHub (gratis)
- Editor de texto (VS Code, Notepad++, o el que uses)
- Los archivos que te mandaron: `index.html`, `Gastos-WebApp.gs`, `manifest.json`, iconos

---

## PASO 1 — Crear tu Google Sheet

1. Andá a [sheets.new](https://sheets.new) y creá una planilla nueva. Ponerle el nombre que quieras (ej: "Mis Gastos 2026").

2. De la URL, copiá el **ID de la sheet** — es la parte larga entre `/d/` y `/edit`:
   ```
   https://docs.google.com/spreadsheets/d/  ESTE-ES-EL-ID  /edit
   ```
   Guardalo, lo necesitás en el Paso 4.

3. Creá estas hojas (pestañas en la parte de abajo). Hacé click derecho en "Hoja 1" → Cambiar nombre, y agregá las demás con el botón `+`:

   **Hoja: `Respuestas de formulario 1`**
   | A | B | C | D | E | F |
   |---|---|---|---|---|---|
   | Marca temporal | Fecha | Categoría | Descripción | Monto | Cuenta |

   **Hoja: `Respuestas de formulario 2`**
   | A | B | C | D |
   |---|---|---|---|
   | Marca temporal | Fecha | Descripción | Monto |

   **Hoja: `Cuotas`**
   | A | B | C | D | E | F |
   |---|---|---|---|---|---|
   | Descripción | Monto Total | N° Cuotas | Fecha 1° Cuota (dd/mm/aaaa) | Categoría | Cuenta |

   **Hoja: `Gastos Fijos`**
   | A | B | C | D | E |
   |---|---|---|---|---|
   | Descripción | Monto | Categoría | Cuenta | Activo (SI/NO) |

   **Hoja: `Metas`**
   | A | B | C | D | E |
   |---|---|---|---|---|
   | Nombre de la meta | Monto objetivo | Monto acumulado | Fecha límite | Notas |

   **Hoja: `Ciclos TC`**
   | A | B |
   |---|---|
   | Cierre | Vencimiento |

   > ⚠️ Los nombres tienen que ser exactamente iguales (mayúsculas, espacios y todo).

---

## PASO 2 — Configurar el Apps Script

1. Desde tu sheet, andá a **Extensiones → Apps Script**.

2. Borrá todo el código que aparece por default.

3. Pegá el contenido completo del archivo `Gastos-WebApp.gs`.

4. Hacé **4 cambios** en el código:

   **Cambio 1 — Tu nombre** (la IA te va a llamar así):
   - Usá Ctrl+H (buscar y reemplazar)
   - Buscar: `Huevo`
   - Reemplazar: tu nombre o apodo
   - Reemplazar todo

   **Cambio 2 — Tu presupuesto mensual**:
   - Buscá la línea: `const PRESUPUESTO_MENSUAL`
   - Cambiá el número por tu presupuesto mensual en pesos

5. Guardá con **Ctrl+S**.

6. Configurá tus claves secretas en **⚙️ Project Settings → Script Properties → Add property**:

   | Property | Value |
   |----------|-------|
   | `GEMINI_API_KEY` | Tu clave de Gemini (gratis en [aistudio.google.com](https://aistudio.google.com) → Get API key) |
   | `API_TOKEN` | Un string random largo (ver instrucción abajo) |

   **¿Cómo generar el API_TOKEN?**
   Abrí cualquier pestaña del navegador, presioná F12, andá a "Console" y tipeá:
   ```js
   crypto.randomUUID()
   ```
   Copiá el resultado (algo como `8f3c2e4a-9b1d-4e6f-a7c8-d9e0f1a2b3c4`).
   **Guardalo en algún lugar seguro** — lo vas a necesitar en el Paso 5.

---

## PASO 3 — Deployar el Web App

1. En el editor de Apps Script, click en **Deploy → New deployment**.
2. Click en el engranaje ⚙️ al lado de "Select type" → elegí **Web app**.
3. Configurá así:
   - Description: lo que quieras (ej: "Mis Gastos")
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy** y autorizá los permisos cuando te pida.
5. **Copiá la URL** que termina en `/exec`. La necesitás en el Paso 4.

---

## PASO 4 — Modificar `index.html`

Abrí el archivo `index.html` con un editor de texto y hacé 2 cambios:

**Cambio 1 — URL de tu Apps Script:**
Buscá esta línea (tiene `APPS_SCRIPT_URL`):
```js
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
```
Reemplazá la URL entre comillas por la que copiaste en el Paso 3.

**Cambio 2 — ID de tu Google Sheet:**
Buscá esta línea (tiene `PERSONAL_SHEET_ID`):
```js
const PERSONAL_SHEET_ID = '1RY0b...';
```
Reemplazá el ID entre comillas por el de tu sheet del Paso 1.

Guardá el archivo.

---

## PASO 5 — Subir la app a GitHub Pages

1. Creá una cuenta en [github.com](https://github.com) si no tenés.
2. Creá un **repositorio nuevo** (puede ser privado).
3. Subí todos los archivos:
   - `index.html`
   - `Gastos-WebApp.gs` *(opcional, para tener backup)*
   - `manifest.json`
   - `icon-192.png`, `icon-512.png`, `icon-180.png`, `icon-maskable-512.png`
4. Andá a **Settings → Pages → Branch: main → Save**.
5. En 1-2 minutos la app queda en:
   ```
   https://[tu-usuario].github.io/[nombre-del-repo]
   ```

---

## PASO 6 — Primer arranque

1. Abrí la URL de tu app.
2. Va a aparecer un cuadro pidiéndote el **API Token**.
3. Pegá el mismo string que pusiste como `API_TOKEN` en el Paso 2.
4. La app carga y ya estás.

> Si en algún momento te pide el token de nuevo, es porque cambió o se borró del navegador. Pegá el mismo string.

---

## Agregar la app al celular (opcional pero recomendado)

**Android (Chrome):**
Abrí la URL en Chrome → menú ⋮ → "Agregar a pantalla de inicio"

**iPhone (Safari):**
Abrí la URL en Safari → botón compartir □↑ → "Agregar a pantalla de inicio"

---

## Problemas comunes

| Problema | Solución |
|----------|----------|
| La app carga pero no muestra datos | Verificá que la URL de Apps Script esté bien copiada en `index.html` |
| Error "Token inválido" | El `API_TOKEN` en la app no coincide con el de Script Properties. Volvé a ingresarlo |
| El Apps Script da error de permisos | Ejecutá la función `_autorizarPermisos` una vez desde el editor de Apps Script |
| Gemini no responde | Verificá que `GEMINI_API_KEY` esté bien en Script Properties |
| No guarda gastos | Verificá que los nombres de las hojas sean exactos (mayúsculas y espacios incluidos) |

---

*Cualquier duda, avisá.*
