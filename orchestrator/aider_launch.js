"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Lanzador de agentes de módulo con el runtime Aider (AGENT_RUNTIME=aider). ║
// ║                                                                            ║
// ║  Adapta la firma de agents.launchModule(taskId, moduleName, brief) al      ║
// ║  driver de cierre. Es FIRE-AND-FORGET: no bloquea la petición del Estratega║
// ║  (una tarea puede durar minutos); el cierre llega al chat cuando termina.  ║
// ║                                                                            ║
// ║  Clave AISLADA: usa AIDER_ANTHROPIC_KEY (no la global) y solo se la pasa   ║
// ║  al hijo Aider — así el `claude` del terminal humano NO factura por API.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const path = require('path');
const db = require('../lib/db');
const { runModuleTaskWithAider } = require('./aider_agent_driver');

const WORK_DIR = process.env.CLAUDE_WORK_DIR || path.join(__dirname, '..', '..');
const MODULES_REL = process.env.MODULES_DIR || '.';
const MODEL = process.env.AIDER_AGENT_MODEL || 'sonnet';

// Buffer de últimas líneas por agente (para el panel; el runtime no tiene pane tmux).
const buffers = new Map();
const running = new Set();   // dedupe: `${taskId}:${module}`
function push(id, line) {
    const b = buffers.get(id) || [];
    b.push(line);
    while (b.length > 80) b.shift();
    buffers.set(id, b);
}
function tailFor(id, n = 30) { return (buffers.get(id) || []).slice(-n).join('\n'); }

// Traduce un evento del runner a una línea legible para el panel.
function fmt(ev) {
    switch (ev.event) {
        case 'start': return `▶ aider (${ev.model}) · ${ev.repo_prefix || ''}`;
        case 'assistant': return ev.text ? `« ${String(ev.text).slice(0, 140)}` : null;
        case 'log': return ev.text ? `· ${String(ev.text).slice(0, 140)}` : null;
        case 'error': return `✗ ${String(ev.text).slice(0, 140)}`;
        case 'question': return `? ${String(ev.text).slice(0, 140)}`;
        case 'violation': return `⛔ fuera del módulo: ${(ev.files || []).join(', ')}`;
        case 'done': return ev.ok ? `✓ ${(ev.files || []).join(', ') || 'sin cambios'}` : `✗ ${ev.error || 'error'}`;
        default: return null;
    }
}

async function launch(taskId, moduleName, brief) {
    const key = `${taskId}:${moduleName}`;
    if (running.has(key)) return { module: moduleName, ok: true, skipped: 'ya trabajando' };
    running.add(key);

    const moduleDir = path.join(WORK_DIR, MODULES_REL, moduleName);
    const apiKey = process.env.AIDER_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
    const env = apiKey ? { ANTHROPIC_API_KEY: apiKey } : {};

    // Fila de agente (si el módulo está registrado) para que el panel lo muestre.
    let agentId = null;
    try {
        const mrow = await db.query(`SELECT id FROM ${db.t('assistant_module')} WHERE name=? AND active=1 LIMIT 1`, [moduleName]);
        if (mrow.length) {
            const pos = await db.query(`SELECT COALESCE(MAX(position)+1,0) p FROM ${db.t('assistant_agent')} WHERE task_id=? AND kind='modulo'`, [taskId]);
            const ins = await db.query(
                `INSERT INTO ${db.t('assistant_agent')} (task_id,kind,module_id,title,status,position) VALUES (?,'modulo',?,?,'running',?)`,
                [taskId, mrow[0].id, moduleName, pos[0].p]);
            agentId = ins.insertId;
            await db.query(`UPDATE ${db.t('assistant_agent')} SET tmux_name=? WHERE id=?`, [`aider:${agentId}`, agentId]);
        }
    } catch (e) { /* sin fila; el cierre por chat sigue funcionando */ }

    push(agentId, `▶ aider (${MODEL}) · ${moduleName}`);

    async function finish() {
        if (agentId != null) await db.query(`UPDATE ${db.t('assistant_agent')} SET status='exited' WHERE id=?`, [agentId]).catch(() => {});
        running.delete(key);
    }
    // Fire-and-forget: arranca el agente y devuelve YA. El cierre (chat + estado) llega al terminar.
    runModuleTaskWithAider({
        taskId, moduleName, moduleDir, model: MODEL, brief, files: [], env,
        onEvent: (ev) => { const l = fmt(ev); if (l) push(agentId, l); },
    }).then(finish, finish);

    return { agentId, module: moduleName, ok: true, runtime: 'aider' };
}

// Detener no es limpio en fire-and-forget (corre hasta terminar); resultado benigno.
function stop(/* agentId */) { return { ok: true, note: 'aider: corre hasta terminar' }; }
function isAider(name) { return typeof name === 'string' && name.startsWith('aider:'); }

module.exports = { launch, tailFor, stop, isAider };
