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
    # Prefijo del módulo dentro del repo git (p.ej. "main/"). Si el módulo ES la raíz
    # del repo (repo suelto), prefix="" → sin confinamiento (todo es "dentro").
    repo_root = git(["rev-parse", "--show-toplevel"], mod).stdout.strip() or mod
    rel = os.path.relpath(mod, repo_root).replace(os.sep, "/")
    prefix = "" if rel == "." else rel + "/"
    os.chdir(mod)
    emit("start", module=os.path.basename(mod), model=a.model, brief=a.brief, repo_prefix=prefix)

    head_before = git(["rev-parse", "HEAD"], repo_root).stdout.strip()

    try:
        io = EventIO()
        model = Model(a.model)
        fnames = [os.path.join(mod, f) for f in a.file]
        # auto_commits: para poder verificar el diff del agente.
        # dirty_commits=False: NO arrastrar cambios ajenos preexistentes al commit.
        coder = Coder.create(main_model=model, io=io, fnames=fnames,
                             auto_commits=True, dirty_commits=False)
        coder.run(a.brief)          # ejecuta el encargo y retorna al terminar
        ok, err = True, None
    except Exception as e:
        ok, err = False, f"{type(e).__name__}: {e}"
        log_stderr("RUNNER ERROR:", err)

    head_after = git(["rev-parse", "HEAD"], repo_root).stdout.strip()
    committed = bool(head_before) and bool(head_after) and head_before != head_after
    changed = git(["diff", "--name-only", head_before, head_after], repo_root).stdout.strip().splitlines() if committed else []

    # ── GUARDIÁN DURO: el commit del agente NO puede tocar fuera del módulo ──────
    violations = [f for f in changed if prefix and not f.startswith(prefix)] if prefix else []
    confined = not violations
    reverted = False
    if violations:
        # Revertir SOLO los commits del agente con `git revert` (preserva cambios sin
        # commitear del árbol; no usamos reset --hard para no pisar trabajo ajeno).
        rv = git(["revert", "--no-edit", f"{head_before}..HEAD"], repo_root)
        if rv.returncode != 0:
            git(["revert", "--abort"], repo_root)
        else:
            reverted = True
        emit("violation", files=violations, reverted=reverted,
             message="cambios fuera del módulo" + (" (revertidos)" if reverted else " (NO se pudo revertir automáticamente)"))

    emit("done",
         ok=(ok and confined),
         error=(err or (("cambios fuera del módulo: " + ", ".join(violations)) if violations else None)),
         confined=confined,
         committed=(committed and confined),
         commit=(head_after[:12] if (confined and committed) else head_before[:12]),
         files=[f for f in changed if (not prefix or f.startswith(prefix))] if confined else [],
         violations=violations)


if __name__ == "__main__":
    main()
