"use strict";
// Entorno saneado para invocar tmux. Lo comparten el bridge del terminal
// (claude_terminal.js) y los agentes de módulo (lib/tmux.js).
//
// Resuelve dos problemas que dejaban el terminal /claude sin arrancar:
//
//  1. `TMUX`/`TMUX_PANE` HEREDADOS. Si el assistant se reinicia desde DENTRO de
//     una sesión tmux (un `pm2 restart` tecleado en el propio terminal), pm2 le
//     graba al proceso ese `TMUX=<socket>,<pid>,<pane>`. tmux da PRIORIDAD a la
//     ruta de socket que lleva `TMUX` e IGNORA `TMUX_TMPDIR`, así que las
//     sesiones nuevas van al socket de OTRO servidor: el de antes del reinicio
//     (muerto) o el de otro usuario, y ahí salta
//     `error connecting to ... (Permission denied)`.
//
//  2. El socket en /tmp. `/tmp/tmux-<uid>` vive en un directorio compartido por
//     todos los usuarios de la máquina; basta con que un proceso ajeno (root,
//     otro tenant) toque ese socket para que el usuario del servicio se quede
//     fuera. Lo movemos a un directorio propio suyo, donde siempre tiene
//     permisos.
//
// Configurable con TMUX_TMPDIR en el .env; por defecto `<CLAUDE_HOME>/tmp`.
//
//  3. (tarea #211) El SERVIDOR tmux no debe vivir en el cgroup de
//     pm2-factory.service: needrestart reinicia ese servicio tras
//     unattended-upgrades y, con KillMode=control-group, el kill se lleva al
//     servidor tmux con TODAS las sesiones de Claude dentro (06:17 2026-11-10).
//     Antes de crear una sesión, si no hay servidor, ensureServer() lo arranca
//     como unidad transitoria del gestor de usuario (`systemd-run --user`), es
//     decir, dentro de user@<uid>.service — needrestart no toca user@*.service
//     (needrestart.conf: `qr(^user@\d+\.service) => 0`). Hace falta linger
//     (`sudo loginctl enable-linger factory`, una vez); sin él se avisa por log
//     y todo sigue funcionando como antes (servidor dentro del cgroup de pm2).
const fs = require('fs');
const { execFile } = require('child_process');

const HOME_DIR   = process.env.CLAUDE_HOME || '/home/ubuntu';
const TMUX_TMPDIR = process.env.TMUX_TMPDIR || (HOME_DIR + '/tmp');

// Autocurativo: cada proyecto/tenant arranca sin este directorio.
try { fs.mkdirSync(TMUX_TMPDIR, { recursive: true, mode: 0o700 }); }
catch (e) { console.error('[assistant] no se pudo crear TMUX_TMPDIR ' + TMUX_TMPDIR + ': ' + e.message); }

// `extra` sobrescribe (p.ej. TERM/FORCE_COLOR para el pty del bridge).
function tmuxEnv(extra) {
    const env = { ...process.env, HOME: HOME_DIR, TMUX_TMPDIR, ...extra };
    delete env.TMUX;        // ver (1): no heredar el socket de la sesión padre
    delete env.TMUX_PANE;
    return env;
}

/* ── servidor tmux fuera del cgroup de pm2 (ver (3) arriba) ──────────────────── */
const RUN_DIR = '/run/user/' + process.getuid();

function run(file, args, env) {
    return new Promise(resolve => execFile(file, args, { env }, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() })));
}

// ¿Hay bus del gestor de usuario? Solo existe con linger (o una sesión logind viva).
function userBusReady() {
    try { fs.accessSync(RUN_DIR + '/bus'); return true; } catch { return false; }
}

// ¿Responde ya un servidor tmux en nuestro socket? `list-sessions` distingue el
// servidor caído («no server running», o en tmux ≥3.6 «error connecting to …
// (No such file or directory)») del vivo sin sesiones («no sessions»).
async function serverUp(env) {
    const r = await run('tmux', ['list-sessions'], env);
    return r.ok || !/no server running|error connecting/i.test(r.stderr);
}

let warnedNoLinger = false;
async function ensureServer(env) {
    if (await serverUp(env)) return;
    if (!userBusReady()) {
        if (!warnedNoLinger) {
            warnedNoLinger = true;
            console.warn('[assistant] el servidor tmux arrancará DENTRO del cgroup de pm2 y morirá con sus reinicios ' +
                '(needrestart/unattended-upgrades). Para evitarlo hace falta, una sola vez: sudo loginctl enable-linger ' + process.env.USER);
        }
        return; // new-session arrancará el servidor a pelo, como siempre
    }
    // No vale `systemd-run --scope`: migrar un PID desde system.slice al árbol
    // delegado del gestor de usuario viola las reglas de delegación de cgroup v2.
    // En su lugar, el gestor de usuario ARRANCA él mismo el servidor (modo
    // servicio, Type=forking: el cliente `start-server` se va y queda el
    // servidor como proceso principal). `exit-empty off` evita que el servidor
    // se muera entre este arranque y la new-session que viene detrás (y de paso
    // sobrevive sin sesiones). El entorno no se hereda del caller, así que se
    // pasa entero con --setenv (PATH, claves, TMUX_TMPDIR…): las sesiones ven
    // lo mismo que si el servidor lo hubiera arrancado el assistant.
    const sysArgs = ['--user', '--collect', '--quiet', '--unit=assistant-tmux', '-p', 'Type=forking'];
    for (const [k, v] of Object.entries(env))
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') sysArgs.push('--setenv=' + k + '=' + v);
    sysArgs.push('--', 'tmux', 'start-server', ';', 'set', '-s', 'exit-empty', 'off');
    const sysEnv = { ...env, XDG_RUNTIME_DIR: RUN_DIR, DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + RUN_DIR + '/bus' };
    const r = await run('systemd-run', sysArgs, sysEnv);
    // «already exists»: otro create concurrente va por delante; solo hay que esperar al socket.
    if (!r.ok && !/already (exists|loaded)/i.test(r.stderr)) {
        console.warn('[assistant] systemd-run no pudo arrancar el servidor tmux (' + (r.stderr || '¿?') +
            '); arrancará dentro del cgroup de pm2');
        return;
    }
    for (let i = 0; i < 20 && !(await serverUp(env)); i++) await new Promise(s => setTimeout(s, 100));
}

// Única puerta de entrada para ÓRDENES tmux (no para el attach del pty, que es
// solo un cliente). Antes de crear una sesión garantiza el servidor protegido.
async function tmuxExec(args, extra) {
    const env = tmuxEnv(extra);
    if (args[0] === 'new-session') await ensureServer(env).catch(e => console.warn('[assistant] ensureServer:', e.message));
    return run('tmux', args, env);
}

module.exports = { tmuxEnv, tmuxExec, ensureServer, TMUX_TMPDIR, HOME_DIR };
