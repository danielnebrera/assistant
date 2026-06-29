# The Seed — plataforma para crear tu aplicación sin saber programar

> **Qué es esto.** The Seed es una plataforma web donde cualquier empresa, **sin saber nada
> de software**, crea y despliega su propia aplicación de gestión (un ERP a su medida). El
> usuario habla en lenguaje de negocio; una **IA (el asistente «Estratega»)** construye y
> mantiene la aplicación por él, dentro de una **arquitectura rígida y cerrada** que
> garantiza que todo proyecto —por distinto que sea su negocio— se estructure igual.

Este repositorio (`assistant/`) es el **núcleo común** de la plataforma: el asistente y los
contratos de arquitectura que comparten **todos** los proyectos. Es el mismo en cada
proyecto y se actualiza por `git pull`. Nada específico de un cliente vive aquí.

---

## La idea en una frase

> **Libertad total en el QUÉ (tu negocio), estructura cerrada en el CÓMO (la arquitectura).**

El cliente decide *qué* hace su aplicación (facturación, taller, inventario, lo que sea). La
plataforma impone *cómo* se construye. Esa rigidez no es una limitación: es lo que permite
que la IA construya con fiabilidad, que todo sea mantenible y que la app **escale sola**.

---

## Las dos mitades de The Seed

### 1. La plataforma multi-tenant (la puerta de entrada)

Es la web pública (`theseed.cypress-electronics.com`) donde un cliente se registra. Al
hacerlo se crea un **tenant** y se **aprovisiona automáticamente** su entorno aislado.

**Un tenant = una empresa cliente con su propia «casa»**: su base de datos, su subdominio y
su usuario de sistema, completamente separados de los demás. Una sola plataforma sirve a
muchos clientes sin que sus datos se mezclen.

| Concepto | Qué es |
|---|---|
| **Tenant** (tabla `tenants`) | La **empresa/cuenta**: slug, razón social, dominios, BD, estado de provisioning. Una fila por cliente. |
| **User** (tabla `users`) | Las **personas que hacen login** dentro de una empresa. Cada usuario pertenece a un tenant (`tenant_id` → FK). Relación 1 empresa : N usuarios. |
| **Provisioning** | Al registrarse, un script crea para el tenant: usuario Linux, BDs `<slug>_dev/test/pro`, subdominio y configuración nginx. |

Modelo de aislamiento elegido: **base de datos por tenant**. Es el más aislado (ideal para
un ERP) y, a la vez, el que escala de forma más natural: para crecer, se reparten los
tenants entre más servidores de BD. Las consultas de un cliente nunca salen de sus propias
BDs, así que nunca hay que partir una tabla gigante.

### 2. El runtime por proyecto (lo que vive en la casa de cada tenant)

Dentro del entorno de cada tenant corre **su aplicación**, con esta estructura fija:

```
<proyecto>/
├── app/          # El código del CLIENTE (versionable). Lo edita el asistente.
│   └── modules/
│       ├── main/         # UI web responsive — único punto front↔back, sin BD
│       ├── <modulo_a>/   # un dominio de negocio (sus tablas + su lógica)
│       └── <modulo_b>/
├── assistant/    # ESTE repo (común, solo-lectura para el asistente). Llega por git pull.
└── shared/       # capa de BD común (pool + prefijo de entorno dev_/test_/pro_)
```

El asistente edita **solo `app/`**; nunca se toca a sí mismo ni a los contratos comunes.

---

## La arquitectura rígida (el CÓMO)

Toda aplicación de The Seed se construye con el mismo modelo de **monolito modular**: un
solo proceso, varios módulos, cada uno dueño de su dominio.

**Regla de Oro:** un módulo **solo consulta SUS tablas**; para datos de otro módulo, llama a
su API pública (`<otro>.service.js`). Nunca `db.query()` sobre tablas ajenas.

Estructura obligatoria de cada módulo (`app/<modulo>/`):

| Fichero | Rol |
|---|---|
| `<m>.queries.js` | SQL privado del módulo. |
| `<m>.service.js` | API pública: lo único que el resto del sistema puede llamar. |
| `<m>.routes.js`  | Rutas HTTP del módulo. |
| `SPEC.md`        | Contrato del módulo: tablas que posee + API pública + reglas. |
| `test/`          | Tests del módulo (todo cambio lleva su test). |

El módulo `main` es especial: es la **UI responsive** y el único que habla con el front; no
tiene tablas ni accede a la BD, solo orquesta llamando a los `service.js` de los módulos.

### Factory es el proyecto de referencia

[Factory](https://github.com/danielnebrera/factory) es una aplicación **real e
independiente** (en producción) construida con esta arquitectura. The Seed la usa como
**ejemplo canónico**: la plantilla de la que salen estos contratos. Factory corre por su
cuenta y no depende de The Seed; la relación es solo que The Seed replica su forma.

---

## El asistente «Estratega»

La IA que construye la app del cliente. Es **común y cerrada**: idéntica en todos los
proyectos, se actualiza por `git pull` de este repo, y opera bajo una frontera dura:

- **Edita solo `app/`** (el código del cliente).
- **Nunca escribe en `assistant/`** (ni su propio código ni estos specs: son solo-lectura).
- Habla con el usuario en **lenguaje de negocio**; lo técnico lo resuelve él.
- Cada cambio se **acompaña de tests**; nada se da por hecho sin verificar.
- Nada irreversible o sensible sin confirmación del usuario.

---

## Mapa de documentos

| Documento | Define |
|---|---|
| **`README.md`** (este) | El QUÉ: finalidad de The Seed y cómo encajan las piezas. |
| `ASSISTANT_SPEC.md` | Cómo trabaja el asistente (su rol, su frontera, sus reglas). |
| `COMMON_MODULE_SPEC_GENERAL.md` | Metodología de un módulo genérico (estructura + Regla de Oro). |
| `COMMON_MODULE_SPEC_MAIN.md` | Metodología del módulo `main` (la UI, sin BD). |
| `app/<modulo>/SPEC.md` | (En cada proyecto) el contrato concreto de cada módulo del cliente. |

Los tres `*_SPEC.md` son **PROMPT inmutable**: se inyectan en el asistente en cada cambio y
el proyecto cliente no los edita. Este README es la portada que les da sentido.
