# Plan: Feature de Tarjeta de Crédito (sistema de Gastos)

> Documento de diseño acordado. **No hay código escrito todavía** — esto es solo el plan para retomar en sesiones futuras.
> Última actualización del contexto: 2026-05-29.

## Objetivo

Registrar gastos de tarjeta de crédito **desde la PWA** (no desde el Google Sheet), imputándolos al **mes en que se pagan** según el ciclo de la tarjeta, con **proyección del resumen a pagar**.

La diferencia clave con el flujo actual: un gasto con tarjeta no impacta el mes en que se compra, sino el mes del **vencimiento** del ciclo al que pertenece.

---

## Reglas de negocio acordadas

1. **Una sola tarjeta** por ahora. (El diseño puede dejar lugar a más en el futuro, pero el alcance inicial es una.)

2. **Medio de pago por gasto.** Cada gasto tiene un medio de pago:
   - **Débito / efectivo** → cuenta en el **mes actual** (comportamiento de hoy, sin cambios).
   - **Tarjeta de crédito** → se imputa al **mes del vencimiento** del ciclo correspondiente.

3. **Ciclo de la tarjeta = fecha de cierre + fecha de vencimiento.** Estas fechas **NO son fijas** mes a mes:
   - Se cargan **manualmente** desde la PWA.
   - Cuando se **acerca o pasa** el cierre cargado, un **recordatorio por Telegram** avisa de cargar el próximo cierre/vencimiento.

4. **Imputación de compras según el cierre:**
   - Una compra **hasta la fecha de cierre** se paga en el **vencimiento (mes siguiente)** → cuenta como gasto de **ese mes de vencimiento**.
   - Lo gastado **después del cierre** va al **ciclo siguiente** (un vencimiento más adelante).

5. **Cuotas:**
   - Monto total **÷ N cuotas**.
   - Cada cuota se imputa a **su mes correspondiente** (la **1ª cuota** al **vencimiento siguiente**, las demás a los vencimientos sucesivos).
   - Mostrar **cuántas cuotas quedan** por pagar.

6. **Gastos fijos en tarjeta** (suscripciones ya domiciliadas en la tarjeta): se cargan **automáticamente cada ciclo**.

7. **Vistas requeridas:**
   - **Consumo del ciclo en curso.**
   - **Proyección del resumen a pagar** = consumos del ciclo + cuotas que caen en ese vencimiento + gastos fijos.

8. **Toda la carga de datos se hace desde la PWA**, bien hecho — **no desde el Google Sheet**.

---

## Dato del ciclo actual (al 2026-05-29)

| Campo | Valor |
|-------|-------|
| Cierre | **28/05** |
| Vencimiento | **08/06** |

Interpretación con las reglas:
- Compras con tarjeta **hasta el 28/05** → se pagan el **08/06** → cuentan como gasto de **junio 2026**.
- Compras con tarjeta **desde el 29/05** → van al **ciclo siguiente** (próximo vencimiento, a cargar manualmente).

---

## Notas técnicas relevadas (RELEVAMIENTO COMPLETO)

> Backend completo relevado el 2026-05-29 (el usuario pasó ambos scripts). Verificar líneas exactas de `index.html` antes de tocar, pueden moverse.

### Backend = DOS Apps Scripts en el proyecto del Sheet de Gastos
1. **Script del Sheet** (menú/dashboard/emails): `actualizarResumen`, `_leerCuotas`, `_getCuotasMes`, `_leerGastosFijos`, `_getGastosFijosMes`, `_ajustarPagosTarjeta`, `crearDashboard`. Crea las hojas auxiliares **Cuotas**, **Gastos Fijos**, **Metas**.
2. **Web-API** (`doGet`) — es la que habla con la PWA (`APPS_SCRIPT_URL` en `index.html` ~1572):
   - `_agregarGasto` / `_agregarIngreso`: hacen `appendRow` en "Respuestas de formulario 1" / "2".
   - `getDashboardData`: lee todo y arma el JSON (`{meses, metas, cuotas, presupuesto, categorias}`). Tiene caché por cantidad de filas.
   - Asistente Gemini (`askGemini`) + hoja oculta "Rechazos".
- Ambos scripts NO estaban versionados en el repo (solo `Personal-AppsScript.gs`). Conviene versionarlos (`Gastos-Sheet.gs` y `Gastos-WebApp.gs`) — OJO repo público: contienen el email del usuario; la API key de Gemini sí está en Script Properties (no hardcodeada).

### Flujo real
- **Alta**: PWA → `doGet?action=add_gasto&...` → `_agregarGasto(p)` → `appendRow` a "Respuestas de formulario 1" con `[timestamp, fecha, cat, desc, monto, cuenta]` → `_regenerarResumenSilencioso()`.
- **Lectura**: `getDashboardData()` agrupa gastos por **mes de la FECHA DE COMPRA** (`k = año-mes`), suma cuotas (ubicadas al día 15) y fijos, aplica el ajuste TC, y devuelve `meses[]` (más reciente primero).

### Estructura de datos
- Fila de gasto ("Respuestas de formulario 1"): **A**=timestamp, **B**=fecha, **C**=categoría, **D**=desc, **E**=monto, **F**=cuenta.
- `data.meses[]`: cada mes con `key, año, mesNum, ingreso, ingresos[], totalGastos, totalAhorro, saldo, cats{}, cuentas{}, gastos[], diasConGasto, ajusteTC, tcOriginal`.
- Cada gasto en el JSON: `{fecha(ms), desc, cat, monto, cuenta, esCuota?, esFijo?}`.

### Lo que YA existe (reusar, no reinventar)
- **Cuotas**: hoja "Cuotas" `[Descripción, Monto Total, N° Cuotas, Fecha 1° Cuota, Categoría, Cuenta]`. `_getCuotasMes` reparte `montoTotal/nCuotas`; **la cuota 1 cae en el mes de "Fecha 1° Cuota"** (hay que correrla al vencimiento siguiente para el nuevo modelo).
- **Gastos Fijos**: hoja "Gastos Fijos" `[Descripción, Monto, Categoría, Cuenta, Activo SI/NO]` → se suman cada mes los activos.
- **Ajuste TC** (`_ajustarPagosTarjeta` / inline en `getDashboardData`): hoy se carga el **resumen cerrado como gasto de categoría "Tarjeta de crédito"** y se le resta la suma de cuotas distribuidas del mes anterior (de ahí `ajusteTC`/`tcOriginal`). **Este es el modelo "dump" que vamos a reemplazar.**
- Campo "cuenta" ya incluye **"Tarjeta de crédito"**; categoría "Tarjeta de crédito" en `CATS`. Presupuesto `PRESUPUESTO_MENSUAL = 1.600.000`.

---

## Cambios concretos a implementar (build-ready)

### El cambio central
En **`getDashboardData`**, los gastos con `cuenta === "Tarjeta de crédito"` deben imputarse al **mes del vencimiento del ciclo**, no al mes de la fecha de compra. Lógica: para una compra con fecha X, buscar el ciclo cuyo **cierre ≥ X** y usar el **mes del vencimiento** de ese ciclo como `k`. Esto **reemplaza** el modelo "dump del resumen" + `_ajustarPagosTarjeta`.

### Lista de cambios
1. **Nueva hoja "Ciclos TC"** `[Cierre (fecha), Vencimiento (fecha)]` (cierres variables) + endpoint `add_ciclo` para cargarla desde la PWA.
2. **`getDashboardData`**: reasignar mes de gastos de tarjeta según ciclo; quitar/retirar el ajuste `_ajustarPagosTarjeta`.
3. **Cuotas**: correr la cuota 1 al vencimiento siguiente; endpoint `add_cuota` para cargarlas desde la PWA (hoy se editan en la hoja).
4. **Gastos Fijos**: endpoint para gestionarlos desde la PWA; los de tarjeta siguen la lógica de ciclo.
5. **PWA**: extender `#form-gasto` (medio de pago + opción cuotas), modales para ciclos y fijos, y vistas de **consumo del ciclo en curso** + **proyección del resumen a pagar** (consumos del ciclo + cuotas que caen + fijos de tarjeta).
6. **Recordatorio de cierre**: reusar el sistema de **Telegram** que ya armamos (en `Personal-AppsScript.gs`) o un trigger análogo en el script de Gastos.

---

## Alcance explícito

- **SÍ:** registrar gastos de tarjeta desde la PWA, imputarlos al mes de vencimiento, manejar cuotas y fijos, proyectar el resumen, recordatorio de cierre por Telegram.
- **NO (por ahora):** múltiples tarjetas; carga de datos desde el Sheet; fechas de ciclo fijas/automáticas.
