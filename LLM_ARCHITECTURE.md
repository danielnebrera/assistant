# Capa de inferencia provider-agnóstica

> Objetivo: que el assistant **no dependa de Claude** y pueda enchufar distintas IAs
> en el futuro, aislando lo propietario tras una interfaz. La comunicación entre
> agentes deja de ser scraping de terminal y pasa a ser un **bus de mensajes propio**.
> Construido en la rama `feat/provider-agnostic-inference`. **Aditivo**: no toca el
> runtime que corre hoy (`app.js`/`api.js`/`estratega.js`/`agents.js`).

## La idea en una frase

Separar **dos capas** que hoy están mezcladas en `execFile('claude', …)`:

| Capa | ¿Propietaria? | Dónde vive ahora |
|---|---|---|
| **La llamada de inferencia** (`messages → siguiente mensaje`) | Sí, por proveedor | `llm/providers/*` (aislada tras `LLMProvider`) |
| **El bucle, las herramientas, el veto, la comunicación** | **No — es tuyo** | `llm/loop.js`, `llm/tools.js`, `orchestrator/*` |

Hoy el binario `claude` hace **todo** (bucle + tools + contrato). Eso es lock-in del
*runtime*, no solo del *modelo*. Esta capa baja la dependencia a la llamada fina.

## Qué se ha construido

```
assistant/
├── llm/
│   ├── provider.js            # Interfaz LLMProvider + tipos NORMALIZADOS (contrato tuyo)
│   ├── loop.js                # runAgent(): EL bucle agéntico (tuyo, agnóstico, dirigido por eventos)
│   ├── tools.js               # herramientas portables (read/glob/grep/sql/write) + VETO del guardián
│   ├── http.js                # POST JSON sin dependencias (fetch nativo)
│   ├── registry.js            # getProvider() — elige IA por LLM_PROVIDER (config, no código)
│   └── providers/
│       ├── fake.js            # doble de test determinista (sin red)
│       ├── anthropic.js       # adaptador Messages API  (mapeo puro testeable)
│       ├── openai.js          # adaptador Chat Completions (mapeo puro testeable)
│       └── claude_cli.js      # SHIM transicional sobre `claude -p` (arranca hoy sin claves)
├── orchestrator/
│   ├── message_bus.js         # bus de mensajes propio (tabla assistant_message) — reemplaza sendKeys/scraping
│   ├── schema.sql             # DDL del bus
│   ├── strategist.js          # turno del Estratega (mapea estratega.js) — mismo contrato {reply,definition,ready,actions}
│   └── agent_runtime.js       # agente de módulo SIN tmux (mapea agents.js launchModule)
├── examples/demo_offline.js   # demo ejecutable sin infra: `npm run demo`
└── test/                       # 42 tests (node:test), verdes sin red/BD/claves: `npm test`
```

## El contrato normalizado (portable, tuyo)

`LLMProvider.step(req) → result`, sin estado (le pasas el historial completo):

- **req**: `{ system?, messages[], tools?[], model?, maxTokens?, temperature? }`
- **message**: `{ role: 'user'|'assistant'|'tool', content: string | Block[] }`
- **block**: `{type:'text'}` · `{type:'tool_use', id, name, input}` · `{type:'tool_result', tool_use_id, content, isError?}`
- **tool**: `{ name, description, parameters /* JSON Schema */ }`
- **result**: `{ text, toolCalls[], stopReason, usage, model, raw }`

Cada adaptador traduce ese formato ↔ el JSON de su proveedor. Las diferencias de
formato se absorben ahí (p.ej. Anthropic agrupa los `tool_result` en un turno; OpenAI
los quiere como N mensajes `tool` — el adaptador OpenAI hace el *fan-out*). El resto
del sistema no ve nada de eso.

## Mapeo viejo → nuevo

| Hoy (propietario / frágil) | Nuevo (agnóstico) |
|---|---|
| `estratega.js` → `execFile('claude','-p')` | `orchestrator/strategist.js` → `runStrategistTurn(provider, …)` |
| `agents.js` → `launchModule` + tmux + `sendKeys` + `capture-pane` | `orchestrator/agent_runtime.js` → `runModuleAgent(provider, …)` |
| `acceptBypassIfPrompted` (scraping del aviso) | innecesario (no hay TUI que sondear) |
| bucle + tools dentro del binario `claude` | `llm/loop.js` + `llm/tools.js` (tuyos) |
| `hooks/guard-module.js` (veto por hook del CLI) | `llm/tools.js` `resolveWithin()` (veto en la propia tool, agnóstico) |
| control de agentes por teclear en el pane | `orchestrator/message_bus.js` (tabla `assistant_message`) |
| supervisión por sondeo (`/supervise` cada N s) | `onEvent` del bucle (dirigido por eventos) |

## Cómo cambiar de IA

En el `.env` del assistant:

```
LLM_PROVIDER=anthropic          # anthropic | openai | claude_cli | fake
LLM_MODEL=claude-sonnet-4-6     # modelo por defecto del adaptador
ANTHROPIC_API_KEY=...           # o OPENAI_API_KEY para LLM_PROVIDER=openai
```

En código no cambia nada: `const provider = getProvider();` y se lo pasas a
`runAgent` / `runStrategistTurn` / `runModuleAgent`. Por defecto (`claude_cli`)
arranca **hoy** sin claves usando la auth del `claude` instalado.

## Estado del cutover

**Hecho y EN VIVO:**
- ✅ **Inferencia del Estratega** por `LLMProvider` (`estratega.js` → `runClaude` usa
  `getProvider()`). Por defecto `claude_cli` = byte-idéntico. Validado end-to-end con
  un turno real (`"OK"` en ~3s). Cubre `respond`/`supervise`/`planAndLaunch`.
- ✅ **Tabla del bus** `assistant_message` creada en `factory_assistant`.

**Construido, detrás de flag (listo para activar):**
- ✅ **Agentes de módulo IN-PROCESS** (`orchestrator/inproc_agents.js`), tmux-free,
  con el bucle propio + tools confinadas + bus. Se activa con `AGENT_RUNTIME=inproc`
  (por defecto = tmux, sin cambios). Validado con el `fake` (escribe ficheros reales
  por el bucle, veto de confinamiento, publica en el bus). **Para trabajo real de
  módulo necesita un provider fino** (`LLM_PROVIDER=anthropic`/`openai` + clave):
  con `claude_cli` el bucle degrada a una respuesta de texto.

**Activar el runtime in-process (cuando pongas clave):**
```
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
AGENT_RUNTIME=inproc
```
y `pm2 restart Factory-assistant`. Para volver a tmux: quita `AGENT_RUNTIME` y reinicia.

**Pendiente:**
1. **Activación real** del runtime in-process con un provider fino (clave de API).
2. **Eventos → UI**: `agentStates` ya sirve el tail in-process; falta un feed
   estructurado en `claude_code.ejs` (en vez del pane de terminal).
3. **Semántica de `enviar`/`parar`/`hard_kill`** para agentes in-process (hoy run-to-
   completion; esas acciones degradan con gracia). Cancelación cooperativa en el bucle.
4. **Cap de concurrencia + backpressure** para las sesiones de agente (hoy no hay).
5. **Supervisión por eventos** (enganchar `onEvent` en vez del `POST /supervise` por timer).
6. **Retirar tmux para los agentes orquestados** (mantenerlo solo para el terminal humano).
7. **Tests de integración con BD** para `message_bus` (los actuales cubren la lógica pura).

## Verificación

```bash
cd /home/factory/assistant
npm test          # 42/42 en verde, sin red/BD/claves
npm run demo      # muestra el mismo bucle con dos "IAs" distintas
```
