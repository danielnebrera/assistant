# aider_agent — runtime de agente de módulo (Aider, agnóstico de proveedor)

Runtime de los **agentes de módulo** basado en **Aider** (Apache-2.0), como
alternativa al `claude` CLI en tmux. Objetivo: **independencia de proveedor**
(cualquier modelo vía LiteLLM) + **hooks propios** para cerrar el workflow
(inicio / fin / duda / feedback), sin depender de las señales propietarias del CLI.

## Principio: dependencia, no fork
Aider es una **dependencia fijada** (`requirements.txt`, hoy `aider-chat==0.86.2`).
NO lo forkeamos. Lo único que mantenemos es la **capa fina** `runner.py`:
- Una subclase de `aider.io.InputOutput` (`EventIO`) que convierte cada I/O de Aider
  en **eventos estructurados** (NDJSON).
- Un `main()` que ejecuta un encargo (`Coder.run`) y usa el **commit de git** como
  señal determinista de "qué cambió".

Si Aider sube de versión y rompe algo, rompe solo este adaptador, no todo.

## Setup (venv aislado con uv; no requiere sudo)
La caja solo tiene Python 3.14 (sin pip/venv). Usamos `uv` (binario en `.tools/`)
para un Python 3.12 propio:
```bash
export UV_PYTHON_INSTALL_DIR="$PWD/.tools/py" UV_CACHE_DIR="$PWD/.tools/cache"
./.tools/uv venv .venv --python 3.12
./.tools/uv pip install --python .venv/bin/python aider-chat==0.86.2
```
`.venv/` y `.tools/` van gitignored (no se commitean).

## Uso
```bash
ANTHROPIC_API_KEY=... .venv/bin/python runner.py \
  --module-dir /ruta/al/modulo --model haiku \
  --brief "implementa X en app.js, nada mas" --file app.js \
  3>eventos.ndjson            # ← canal de eventos DEDICADO (fd 3)
```
Los **eventos** salen por **fd 3** (canal limpio; stdout/stderr quedan para el ruido
de Aider). Protocolo:
```
{"event":"start",    "module","model","brief","repo_prefix"}
{"event":"assistant","text"}                     # texto del modelo
{"event":"log"|"error"|"warning", "text"}        # feedback en vivo (incl. confirms auto-sí)
{"event":"question", "kind":"duda", "text","turn"}       # DUDA del modelo → espera respuesta
{"event":"violation","files":[...], "reverted"}          # tocó fuera del módulo (revertido)
{"event":"done", "ok","confined","committed","commit","files":[...]}   # fin + qué cambió
```
**Round-trip de dudas:** las confirmaciones OPERATIVAS de Aider (añadir fichero, crear,
commitear) se auto-aprueban y salen como `log`. La DUDA real la levanta el MODELO con una
línea `DUDA: ...`: el runner la detecta entre turnos, **bloquea leyendo stdin** (el usuario
responde en el chat → el bridge se lo escribe) y continúa. Timeout de seguridad → sigue con
su criterio. Config: `AIDER_DUDA_MAX_TURNS` (5), `AIDER_DUDA_TIMEOUT` (600s).

## Agnóstico de proveedor
Cambiar de IA = cambiar `--model` + la clave. **Cero cambios de código** (LiteLLM):
- Claude: `--model haiku|sonnet` + `ANTHROPIC_API_KEY`
- GPT: `--model gpt-4o` (o `openai/...`) + `OPENAI_API_KEY`
- Local: `--model ollama/...`

## Confinamiento por módulo (guardián)
El runner deriva el prefijo del módulo dentro del repo git y, tras el commit del
agente, **valida que el diff toque SOLO ese prefijo**. Si hay cambios fuera:
`git revert` de los commits del agente (preserva cambios sin commitear del árbol) +
evento `violation` + `done.confined=false`. Es el equivalente agnóstico y determinista
del hook-guardián de Claude Code. Además `dirty_commits=False` evita arrastrar cambios
ajenos al commit del agente.

## Estado
Validado con Claude (haiku), sin tocar el proceso vivo:
- ✅ Hooks/eventos por fd 3 (start/assistant/log/question/done).
- ✅ Bridge Node (`orchestrator/aider_bridge.js`) + driver de cierre
  (`orchestrator/aider_agent_driver.js`): eventos → bus `assistant_message` → aviso al
  usuario en el chat.
- ✅ Confinamiento por módulo (permite dentro, revierte fuera).
- ✅ Cableado con el Estratega tras flag `AGENT_RUNTIME=aider` (fire-and-forget; el panel
  muestra su actividad; cierre en el chat).
- ✅ Round-trip de dudas (`DUDA:` del modelo → chat → respuesta del usuario → stdin → sigue).

Pendiente: demo con GPT (falta `OPENAI_API_KEY`); robustez ante reinicio del proceso
(los agentes fire-and-forget no sobreviven a un restart); que el Estratega reaccione al
cierre (auto-tests) en vez de solo avisar al usuario.
