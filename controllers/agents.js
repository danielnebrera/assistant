"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Agentes de MÓDULO — la "realización" de una tarea.                        ║
// ║                                                                            ║
// ║  Cuando la definición está lista, el Estratega PLANIFICA: decide qué       ║
// ║  módulos hay que tocar y redacta un encargo concreto para cada uno. Por    ║
// ║  cada módulo se lanza un agente `claude` en su propia sesión tmux          ║
// ║  (ag_<id>), con el encargo sembrado como primer turno. Cada agente         ║
// ║  documenta primero el SPEC.md de su módulo y luego implementa, y su log    ║
// ║  en vivo se ve en su columna del detalle de la tarea.                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const db    = require('../lib/db');
const tmux  = require('../lib/tmux');
const tasks = require('./tasks_store');
const modules = require('./modules_store');
const estratega = require('./estratega');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORK_DIR    = process.env.CLAUDE_WORK_DIR || path.join(__dirname, '..', '..');
// Layout monolito modular: el código vive en `app/`, los módulos en `app/modules/<m>/`
// (contrato `CLAUDE.md`) y los tests a nivel app en `app/test/<m>*.test.js`.
const APP_REL      = process.env.APP_DIR || 'app';
const MODULES_REL  = process.env.MODULES_DIR || 'app/modules';
const CONTRACT     = process.env.MODULE_CONTRACT_FILE || 'CLAUDE.md';
const PERM_MODE   = process.env.AGENT_PERMISSION_MODE || 'acceptEdits';
const PROMPT_DIR  = path.join(os.tmpdir(), 'assistant-agents');
try { fs.mkdirSync(PROMPT_DIR, { recursive: true }); } catch (e) {}

const PLAN_SYSTEM = `Eres el ESTRATEGA. Tienes una tarea YA DEFINIDA y debes PLANIFICAR su
realización: decidir qué módulos de la app hay que tocar y redactar, para cada uno, un
encargo técnico concreto para el agente de ese módulo.

Responde SIEMPRE y SOLO con un objeto JSON válido (sin markdown):
{
  "definition": "la definición final de la tarea en lenguaje de negocio",
  "modules": [
    { "name": "<nombre EXACTO de un módulo de la lista>", "brief": "encargo técnico concreto para el agente de ese módulo" }
  ]
}
Incluye solo los módulos realmente necesarios. Usa nombres EXACTOS de la lista de módulos.`;

function planPrompt({ task, messages, mods }) {
    const modList = mods.filter(m => m.active).map(m => '- ' + m.name).join('\n');
    const convo = messages.map(m => (m.role === 'user' ? 'USUARIO' : 'ESTRATEGA') + ': ' + m.content).join('\n\n');
    return [
        PLAN_SYSTEM,
        '\n--- MÓDULOS DISPONIBLES ---\n' + modList,
        '\n--- TÍTULO ---\n' + (task.title || ''),
        '\n--- DEFINICIÓN ACTUAL ---\n' + (task.definition || '(sin definir)'),
        '\n--- CONVERSACIÓN ---\n' + (convo || '(vacía)'),
        '\nDevuelve SOLO el JSON con el plan.',
    ].join('\n');
}

// Prompt sembrado en el agente de un módulo (primer turno, lenguaje técnico).
// Arquitectura: monolito modular. El módulo vive en `app/modules/<m>/`, su contrato
// es `CLAUDE.md`, y sus tests a nivel app en `app/test/<m>*.test.js`.
function agentPrompt(moduleName, definition, brief) {
    const modDir = `${MODULES_REL}/${moduleName}`;
    return `Eres el agente del módulo «${moduleName}» del monolito modular factory3 (${path.join(WORK_DIR, modDir)}).

OBJETIVO DE NEGOCIO DE LA TAREA:
${definition}

TU ENCARGO EN ESTE MÓDULO:
${brief}

REGLAS OBLIGATORIAS:
1. Lee primero ${modDir}/${CONTRACT} y el CLAUDE.md raíz, y respétalos.
2. DOCUMENTA el cambio en ${modDir}/${CONTRACT} ANTES de tocar el código.
3. Regla de Oro: este módulo SOLO accede a SUS tablas; para datos de otro módulo llama a su \`<otro>.service.js\`. NUNCA hagas db.query sobre tablas ajenas ni edites ficheros de otros módulos.
4. El código del módulo está en ${modDir}/ (ficheros \`*.queries.js\` / \`*.service.js\` / \`*.routes.js\`). Sus tests están en ${APP_REL}/test/${moduleName}*.test.js — añádelos o actualízalos.
5. No toques nada fuera de ${modDir}/ y de los tests del módulo en ${APP_REL}/test/.
Cuando termines, resume en 3 líneas qué has cambiado.`;
}

// Planifica (turno del Estratega) y lanza un agente por módulo.
async function planAndLaunch(taskId) {
    const task = await tasks.get(taskId);
    if (!task) throw new Error('Tarea no encontrada');
    const [messages, mods] = await Promise.all([tasks.messages(taskId), modules.list()]);
    const validNames = new Set(mods.filter(m => m.active).map(m => m.name));

    // 1) Plan del Estratega (una sola llamada; parseamos definition + modules).
    const raw = await estratega.runClaude(planPrompt({ task, messages, mods }));
    let planned = { definition: '', modules: [] };
    try {
        let s = raw.trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) s = fence[1].trim();
        const a = s.indexOf('{'), b = s.lastIndexOf('}');
        if (a >= 0 && b > a) s = s.slice(a, b + 1);
        const o = JSON.parse(s);
        planned.definition = String(o.definition || '').trim();
        planned.modules = Array.isArray(o.modules) ? o.modules : [];
    } catch (e) { throw new Error('No pude interpretar el plan del Estratega. Reintenta.'); }
    let plan = planned.modules;
    if (planned.definition) await tasks.setDefinition(taskId, planned.definition);

    // Filtra a módulos válidos y deduplica.
    const seen = new Set();
    plan = plan.filter(p => p && validNames.has(p.name) && !seen.has(p.name) && seen.add(p.name));
    if (!plan.length) throw new Error('El Estratega no identificó módulos que tocar. Define mejor la tarea en el chat.');

    const modByName = Object.fromEntries(mods.map(m => [m.name, m]));
    const definition = (await tasks.get(taskId)).definition || task.definition || '';

    // 2) Un agente por módulo.
    const launched = [];
    let pos = 0;
    for (const p of plan) {
        const mod = modByName[p.name];
        const r = await db.query(
            `INSERT INTO ${db.t('assistant_agent')} (task_id, kind, module_id, title, status, position)
             VALUES (?, 'modulo', ?, ?, 'idle', ?)`,
            [taskId, mod.id, p.name, pos++]
        );
        const agentId = r.insertId;
        const name = 'ag_' + agentId;
        const promptFile = path.join(PROMPT_DIR, name + '.txt');
        fs.writeFileSync(promptFile, agentPrompt(p.name, definition, p.brief || ''));
        // bash -lc: claude recibe el prompt (posicional) leído del fichero.
        const command = `exec claude --permission-mode ${PERM_MODE} "$(cat ${promptFile})"`;
        const ok = await tmux.create(name, WORK_DIR, command);
        if (ok) {
            const pid = await tmux.panePid(name);
            await db.query(`UPDATE ${db.t('assistant_agent')} SET tmux_name=?, pid=?, status='running' WHERE id=?`,
                [name, pid, agentId]);
            // Hands-free: si claude muestra el aviso de "Bypass Permissions mode",
            // lo aceptamos por el agente (sin esto se queda esperando). Se hace en
            // segundo plano para no retrasar la respuesta; solo pulsa si DETECTA el
            // aviso (no manda nada si no aparece, para no escribir en el chat).
            acceptBypassIfPrompted(name).catch(() => {});
        } else {
            await db.query(`UPDATE ${db.t('assistant_agent')} SET status='exited' WHERE id=?`, [agentId]);
        }
        launched.push({ agentId, module: p.name, ok });
    }

    await tasks.setStatus(taskId, 'realizacion');
    return { launched };
}

// Acepta el aviso "Bypass Permissions mode" de claude si aparece (hands-free).
// Solo pulsa cuando detecta el texto del aviso, para no escribir en el prompt.
async function acceptBypassIfPrompted(name) {
    for (let i = 0; i < 8; i++) {
        await sleep(1500);
        const pane = await tmux.capture(name);
        if (/Bypass Permissions mode|accept all responsibility|Yes, I accept/i.test(pane)) {
            await tmux.sendKeys(name, '2'); await sleep(300); await tmux.sendEnter(name);
            return true;
        }
        if (/bypass permissions on|⏵⏵|esc to interrupt/i.test(pane)) return false; // ya trabajando
    }
    return false;
}

// Comprueba qué agentes de la tarea siguen vivos (sincroniza estado).
async function syncStatuses(taskId) {
    const rows = await db.query(
        `SELECT id, tmux_name, status FROM ${db.t('assistant_agent')} WHERE task_id=? AND kind='modulo'`, [taskId]);
    for (const a of rows) {
        if (!a.tmux_name) continue;
        const alive = await tmux.exists(a.tmux_name);
        const st = alive ? 'running' : 'exited';
        if (st !== a.status) await db.query(`UPDATE ${db.t('assistant_agent')} SET status=? WHERE id=?`, [st, a.id]);
    }
}

/* ── git (en el repo de la app, WORK_DIR) ─────────────────────────────────── */
const { execFile } = require('child_process');
function git(args) {
    return new Promise(resolve => {
        execFile('git', ['-C', WORK_DIR, ...args], { env: { ...process.env, HOME: process.env.CLAUDE_HOME || '/home/ubuntu' }, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: (stdout || '').trim(), err: (stderr || '').trim() }));
    });
}

// Aceptar la tarea = COMMIT de los cambios de los módulos tocados, ligado a la tarea.
// Commitea SOLO las carpetas de los módulos del plan (no barre cambios ajenos).
async function commitTask(taskId) {
    const task = await tasks.get(taskId);
    if (!task) throw new Error('Tarea no encontrada');
    const ags = await db.query(
        `SELECT DISTINCT m.name FROM ${db.t('assistant_agent')} a
           JOIN ${db.t('assistant_module')} m ON m.id = a.module_id
          WHERE a.task_id=? AND a.kind='modulo' AND m.name IS NOT NULL`, [taskId]);
    const names = ags.map(a => a.name).filter(Boolean);
    if (!names.length) throw new Error('La tarea no tiene módulos con cambios que guardar.');
    // Pathspecs acotados: la carpeta del módulo + sus ficheros de test del monolito.
    const pathspecs = [];
    for (const n of names) {
        pathspecs.push(`${MODULES_REL}/${n}`);
        for (const f of moduleTestFiles(n)) pathspecs.push(`${APP_REL}/test/${f}`);
    }
    const dirs = names;   // para el mensaje de commit

    await tasks.setStatus(taskId, 'commit');
    const add = await git(['add', '--', ...pathspecs]);
    if (add.code !== 0) throw new Error('git add falló: ' + add.err);
    // ¿hay algo preparado para commitear?
    const staged = await git(['diff', '--cached', '--quiet']);   // code 1 = hay cambios
    if (staged.code === 0) {
        await tasks.setStatus(taskId, 'aceptacion');
        throw new Error('No hay cambios en los módulos de la tarea (los agentes quizá no guardaron nada todavía).');
    }
    const msg = `${task.title} (tarea #${taskId})\n\n${(task.definition || '').trim()}\n\nMódulos: ${dirs.join(', ')}`;
    const co = await git(['commit', '-m', msg]);
    if (co.code !== 0) throw new Error('git commit falló: ' + (co.err || co.out));
    const sha = (await git(['rev-parse', 'HEAD'])).out;

    await db.query(`INSERT INTO ${db.t('assistant_commit')} (task_id, sha, message) VALUES (?,?,?)`,
        [taskId, sha, `${task.title} — ${dirs.join(', ')}`]);
    await tasks.setStatus(taskId, 'hecho');
    // cerramos las sesiones de los agentes (trabajo terminado)
    const live = await db.query(`SELECT tmux_name FROM ${db.t('assistant_agent')} WHERE task_id=? AND tmux_name IS NOT NULL`, [taskId]);
    for (const a of live) { await tmux.kill(a.tmux_name); }
    await db.query(`UPDATE ${db.t('assistant_agent')} SET status='exited' WHERE task_id=?`, [taskId]);
    return { sha };
}

// Ficheros de test del monolito que corresponden a un módulo: `app/test/<m>.test.js`
// y `app/test/<m>_*.test.js` (p.ej. engineering_components.test.js).
function moduleTestFiles(name) {
    const testDir = path.join(WORK_DIR, APP_REL, 'test');
    try {
        return fs.readdirSync(testDir).filter(f =>
            f.endsWith('.test.js') && f.startsWith(name) && (f[name.length] === '.' || f[name.length] === '_'));
    } catch (e) { return []; }
}

// Corre UN fichero de test en su propio proceso node (cwd=app/).
function runOneTestFile(file) {
    return new Promise(resolve => {
        execFile('node', ['--test', path.join('test', file)], {
            cwd: path.join(WORK_DIR, APP_REL),
            env: { ...process.env, NODE_ENV: 'test', HOME: process.env.CLAUDE_HOME || '/home/ubuntu' },
            timeout: 120000, maxBuffer: 8 * 1024 * 1024,
        }, (err, stdout, stderr) => resolve({
            code: err ? (err.code || 1) : 0,
            output: ((stdout || '') + '\n' + (stderr || '')).trim(),
        }));
    });
}

// Ejecuta los tests del módulo. IMPORTANTE: cada fichero en SU PROPIO proceso
// (como app/test/run.sh): node --test corre los ficheros en paralelo dentro de un
// mismo proceso y, al compartir el pool MySQL singleton, se cuelgan. Aislando por
// proceso, cada uno abre/cierra su pool sin interferir. Devuelve {code, output}.
async function runModuleTests(name) {
    const files = moduleTestFiles(name);
    if (!files.length) return { code: 0, output: '(el módulo ' + name + ' no tiene tests)', skipped: true };
    let code = 0; const parts = [];
    for (const f of files) {
        const r = await runOneTestFile(f);
        const pass = (r.output.match(/^# pass (\d+)/m) || [])[1];
        const fail = (r.output.match(/^# fail (\d+)/m) || [])[1];
        parts.push(`=== ${f} === ${r.code === 0 ? '✓' : '✗'} (pass=${pass || '?'} fail=${fail || '?'})\n` + r.output);
        if (r.code !== 0) code = 1;
    }
    return { code, output: parts.join('\n\n').slice(-8000) };
}

// Ejecuta los tests de TODOS los módulos de la tarea y guarda el resultado por agente.
async function runTests(taskId) {
    const ags = await db.query(
        `SELECT a.id, m.name FROM ${db.t('assistant_agent')} a
           JOIN ${db.t('assistant_module')} m ON m.id = a.module_id
          WHERE a.task_id=? AND a.kind='modulo' AND m.name IS NOT NULL`, [taskId]);
    if (!ags.length) throw new Error('La tarea no tiene módulos con tests que ejecutar.');
    await tasks.setStatus(taskId, 'ejecucion_tests');
    const results = [];
    for (const a of ags) {
        await db.query(`UPDATE ${db.t('assistant_agent')} SET test_status='running' WHERE id=?`, [a.id]);
        const r = await runModuleTests(a.name);
        const status = r.code === 0 ? 'passed' : 'failed';
        await db.query(`UPDATE ${db.t('assistant_agent')} SET test_status=?, test_output=? WHERE id=?`,
            [status, (r.output || '').slice(-8000), a.id]);
        results.push({ module: a.name, status, skipped: !!r.skipped });
    }
    await tasks.setStatus(taskId, 'aceptacion');   // tras probar, queda a la espera de tu visto bueno
    return { results, allPass: results.every(x => x.status === 'passed') };
}

// Ownership: ¿este agente pertenece a una tarea del usuario? (para el WS)
async function ownedAgent(userId, agentId) {
    const rows = await db.query(
        `SELECT a.id, a.tmux_name FROM ${db.t('assistant_agent')} a
           JOIN ${db.t('assistant_task')} t ON t.id = a.task_id
          WHERE a.id=? AND (t.user_id IS NULL OR t.user_id=?)`, [agentId, userId]);
    return rows[0] || null;
}

module.exports = { planAndLaunch, syncStatuses, ownedAgent, commitTask, runTests, agentPrompt, WORK_DIR, PERM_MODE };
