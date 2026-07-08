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
{"event":"start",    "module","model","brief"}
{"event":"assistant","text"}                     # texto del modelo
{"event":"log"|"error"|"warning", "text"}        # feedback en vivo
{"event":"question", "kind":"confirm"|"prompt", "text", "default"}   # DUDA a resolver
{"event":"done",     "ok","committed","commit","files":[...]}       # fin + qué cambió
```
En la PoC las dudas se auto-responden (proceder). En producción: `confirm_ask`/
`prompt_ask` **bloquean** y enrutan la duda al usuario (respuesta por stdin).

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

Pendiente: cableado con el Estratega detrás de flag (`AGENT_RUNTIME=aider`) para que una
tarea REAL use este agente; round-trip de dudas (bloquear en `confirm_ask` y responder por
stdin desde el usuario); demo con GPT (falta `OPENAI_API_KEY`).
