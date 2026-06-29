# COMMON_MODULE_SPEC_MAIN.md — Metodología del módulo `main`

> **PROMPT inmutable.** Toda app tiene un módulo `main`. Estas reglas son obligatorias y
> el asistente NO puede cambiarlas (viven en `assistant/`, repo común).

## Qué es `main`

La **interfaz gráfica web responsive** y el **único punto de comunicación entre front y
back**. Es la cara de la aplicación.

## Reglas duras

1. **`main` NO tiene tablas propias ni accede a ninguna BD.** Cero SQL en `main`.
2. **Todo dato se obtiene llamando al `*.service.js` del módulo dueño.** `main` orquesta y
   presenta; no posee datos.
3. **Es el único que habla con el front**: expone las rutas/endpoints que consume la UI y
   reparte el trabajo a los módulos por sus servicios públicos.
4. **Responsive**: la UI debe funcionar en móvil y escritorio.
5. **Autenticación/sesión**: `main` es el punto de entrada de login y de la sesión; propaga
   la identidad a los módulos, no la reimplementa cada uno.

## Qué SÍ contiene `main`

- Vistas/plantillas de la UI (responsive) y los assets estáticos.
- Rutas de presentación y orquestación (llaman a `<m>.service.js`).
- El layout común y la navegación.

## Qué NUNCA hace `main`

- Consultar tablas (`db.query(...)`) — prohibido.
- Implementar lógica de negocio de un módulo (eso vive en el `*.service.js` del módulo).
- Poseer estado de datos persistente.
