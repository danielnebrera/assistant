# COMMON_MODULE_SPEC_GENERAL.md — Metodología de un módulo genérico

> **PROMPT inmutable.** Aplica a TODO módulo que no sea `main` (los que tienen tablas y
> lógica propias). El asistente debe cumplirlo al crear o modificar un módulo. Vive en
> `assistant/` (repo común) y no se puede cambiar.

## Qué es un módulo genérico

Un **microservicio lógico** dentro del monolito modular: posee SUS tablas y SU lógica de
negocio, con un contexto acotado. Encapsula su dominio (p. ej. `accounting`, `clients`…).

## Regla de Oro (en código, no en red)

- **Un módulo SOLO consulta SUS propias tablas.**
- Para datos de otro módulo, **se llama a su API pública** (`<otro>.service.js`).
  **NUNCA** se hace `db.query(...)` sobre tablas de otro módulo.

```js
const clients = require('../clients/clients.service');
const c = await clients.getById(id);          // ✅ correcto
// ❌ PROHIBIDO:  db.query('SELECT ... FROM clients ...')
```

## Estructura obligatoria del módulo  `app/<MODULO>/`

| Fichero | Rol |
|---|---|
| `<m>.queries.js` | SQL **privado** del módulo. Solo lo importa `<m>.service.js`. |
| `<m>.service.js` | **API pública** del módulo. Lo que pueden llamar otros módulos, `main` y las rutas. Aquí vive la lógica de negocio. |
| `<m>.routes.js`  | Rutas HTTP del módulo. |
| `SPEC.md`        | **Contrato del módulo**: tablas que posee, API pública y reglas de negocio. Es adaptable por el cliente, pero siempre refleja la realidad del módulo. |
| `test/`          | Tests del módulo. |

## Reglas duras

1. **Propiedad de tablas**: las tablas del módulo se nombran con un prefijo lógico del
   módulo y solo este módulo las lee/escribe.
2. **Frontera por el `service`**: lo único que el resto del sistema puede usar de un módulo
   es lo que exporta su `<m>.service.js`. `queries.js` es privado.
3. **Sin acceso cruzado a BD**: prohibido tocar tablas ajenas (Regla de Oro).
4. **Contrato al día**: cualquier cambio en tablas o API pública se refleja en el `SPEC.md`
   del módulo en el mismo cambio.
5. **Tests**: todo cambio de comportamiento lleva su test.
6. **Registro del módulo**: un módulo nuevo se da de alta en el cargador de módulos de la app.

## Crear un módulo nuevo (resumen)

1. Crear `app/<MODULO>/` con los ficheros de la tabla anterior.
2. Definir sus tablas (con prefijo del módulo) y su migración.
3. Escribir su `SPEC.md` (tablas + API pública + reglas).
4. Exponer su `<m>.service.js` y sus `<m>.routes.js`.
5. Registrarlo en el cargador de módulos.
6. Tests.
