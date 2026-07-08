#!/usr/bin/env python
"""
Runner de agente de módulo sobre Aider — con HOOKS de desarrollo PROPIO.

Aider es una dependencia (fijada); NO lo forkeamos. Aquí vive nuestra capa fina:
una subclase de `aider.io.InputOutput` (EventIO) que convierte cada I/O de Aider en
EVENTOS ESTRUCTURADOS (NDJSON por stdout) — el equivalente a los "hooks" del CLI de
Claude, pero nuestro y agnóstico de proveedor (Aider habla con cualquier modelo via
LiteLLM). El Estratega (Node) lanza este runner por módulo y escucha los eventos:

  {"event":"start", ...}       inicio de tarea
  {"event":"log"|"assistant"|"error"|"warning", "text":...}   feedback en vivo
  {"event":"question", "kind":"confirm"|"prompt", "text":...} DUDA a resolver
  {"event":"done", "committed":bool, "commit":..., "files":[...]}  fin + qué cambió

Las respuestas a las dudas llegarían por stdin (una línea JSON). En esta PoC las
preguntas se auto-responden (proceder) para no bloquear, pero SE EMITEN para probar
que el hook captura la duda.
"""
import sys, os, json, argparse, subprocess

# Canal de eventos DEDICADO (fd 3): el bridge de Node lo lee. Así los eventos no se
# mezclan con lo que Aider imprima en stdout/stderr (su stream en vivo, banners…).
# Si no hay fd 3 (ejecución suelta a mano), cae a stdout.
try:
    _EVENTS = os.fdopen(3, "w")
except OSError:
    _EVENTS = sys.stdout

def emit(ev, **kw):
    _EVENTS.write(json.dumps({"event": ev, **kw}, ensure_ascii=False) + "\n")
    _EVENTS.flush()

def log_stderr(*a):
    print(*a, file=sys.stderr, flush=True)

from aider.io import InputOutput
from aider.models import Model
from aider.coders import Coder


class EventIO(InputOutput):
    """Hooks propios: I/O de Aider -> eventos NDJSON. Sin TUI, sin prompts bloqueantes."""
    def __init__(self, **kw):
        # output=stderr: toda la salida renderizada de Aider (stream en vivo, banners)
        # va a stderr; stdout queda EXCLUSIVO para nuestros eventos NDJSON (emit()).
        super().__init__(pretty=False, yes=True, fancy_input=False, output=sys.stderr, **kw)

    # --- feedback / logs ---
    def tool_output(self, *messages, log_only=False, bold=False):
        if messages and not log_only:
            emit("log", text=" ".join(str(m) for m in messages))
    def tool_error(self, message="", strip=True):
        emit("error", text=str(message))
    def tool_warning(self, message="", strip=True):
        emit("warning", text=str(message))
    def ai_output(self, content):
        emit("assistant", text=str(content))

    # --- HOOK de "duda": confirmaciones y preguntas del agente ---
    def confirm_ask(self, question, default="y", subject=None, explicit_yes_required=False, group=None, allow_never=False):
        emit("question", kind="confirm", text=str(question),
             subject=(str(subject) if subject else None), default=default)
        return True   # PoC: proceder. Producción: bloquear y enrutar la duda al usuario.
    def prompt_ask(self, question, default="", subject=None):
        emit("question", kind="prompt", text=str(question), default=default)
        return default


def git(args, cwd):
    return subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--module-dir", required=True)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--brief", required=True)
    ap.add_argument("--file", action="append", default=[], help="ficheros editables (relativos al módulo)")
    a = ap.parse_args()

    mod = os.path.abspath(a.module_dir)
    os.chdir(mod)
    emit("start", module=os.path.basename(mod), model=a.model, brief=a.brief)

    head_before = git(["rev-parse", "HEAD"], mod).stdout.strip()

    try:
        io = EventIO()
        model = Model(a.model)
        fnames = [os.path.join(mod, f) for f in a.file]
        coder = Coder.create(main_model=model, io=io, fnames=fnames)
        coder.run(a.brief)          # ejecuta el encargo y retorna al terminar
        ok, err = True, None
    except Exception as e:
        ok, err = False, f"{type(e).__name__}: {e}"
        log_stderr("RUNNER ERROR:", err)

    head_after = git(["rev-parse", "HEAD"], mod).stdout.strip()
    committed = bool(head_before) and bool(head_after) and head_before != head_after
    if committed:
        files = git(["diff", "--name-only", head_before, head_after], mod).stdout.strip().splitlines()
    else:
        files = [l[3:] for l in git(["status", "--porcelain"], mod).stdout.strip().splitlines()]
    emit("done", ok=ok, error=err, committed=committed, commit=head_after[:12], files=files)


if __name__ == "__main__":
    main()
