"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Agentes de módulo IN-PROCESS (tmux-free) — detrás del flag AGENT_RUNTIME. ║
// ║                                                                            ║
// ║  Alternativa a agents.js/launchModule (tmux): corre el agente con MI bucle ║
// ║  (llm/loop) + herramientas confinadas + provider intercambiable, y publica ║
// ║  el resultado en el bus de mensajes propio (orchestrator/message_bus).     ║
// ║                                                                            ║
// ║  Se activa con AGENT_RUNTIME=inproc. Por defecto (sin flag) NO se usa:      ║
// ║  el sistema sigue con tmux exactamente igual que hoy.                      ║
// ║                                                                            ║
// ║  Nota: modelo run-to-completion (cada brief se ejecuta hasta terminar);    ║
// ║  no hay "enviar" mid-run como en tmux. Con LLM_PROVIDER=claude_cli el bucle ║
// ║  degrada a una respuesta de texto (el CLI hace su propio bucle) → para el  ║
// ║  trabajo real de módulo hace falta un provider fino (anthropic/openai).    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const path = require('path');
const db = require('../lib/db');
const { getProvider } = require('../llm/registry');
const { runModuleAgent } = require('./agent_runtime');
const { createMessageBus, ensureMessageSchema } = require('./message_bus');

const WORK_DIR = process.env.CLAUDE_WORK_DIR || path.join(__dirname, '..', '..');
const MODULES_REL = process.env.MODULES_DIR || '.';   // .env: MODULES_DIR=. (módulos cuelgan de WORK_DIR)

// Buffer de actividad en vivo por agente (sustituye al capture-pane de tmux).
const buffers = new Map();
function pushLine(agentId, line) {
    const b = buffers.get(agentId) || [];
    b.push(line);
    while (b.length > 80) b.shift();
    buffers.set(agentId, b);
}
/** Cola del log en vivo de un agente in-process (lo lee agents.agentStates). */
function tailFor(agentId, n = 30) { return (buffers.get(agentId) || []).slice(-n).join('\n'); }
function isInproc(tmuxName) { return typeof tmuxName === 'string' && tmuxName.startsWith('inproc:'); }

// Evento del bucle → línea legible para el panel del agente.
function formatEvent(e) {
    switch (e.type) {
        case 'agent_start': return `▶ agente ${e.module}`;
        case 'step_start': return `· paso ${e.step}`;
        case 'tool_call': return `→ ${e.name}(${JSON.stringify(e.input).slice(0, 100)})`;
        case 'tool_result': return `← ${String(e.content).split('\n')[0].slice(0, 120)}${e.isError ? ' [error]' : ''}`;
        case 'assistant_message': return e.text ? `« ${e.text.slice(0, 120)}` : null;
        case 'done': return `✓ ${String(e.text).slice(0, 160)}`;
        case 'max_steps': return '⚠ tope de pasos alcanzado';
        default: return null;
    }
}

let _bus;
function bus() { if (!_bus) _bus = createMessageBus({ query: db.query, t: db.t }); return _bus; }

/**
 * Lanza un agente de módulo IN-PROCESS. Misma firma y contrato de retorno que
 * agents.launchModule, para poder sustituirlo tras el flag. Idempotente.
 */
async function launch(taskId, moduleName, brief) {
    const running = await db.query(
        `SELECT a.id FROM ${db.t('assistant_agent')} a LEFT JOIN ${db.t('assistant_module')} m ON m.id=a.module_id
          WHERE a.task_id=? AND a.kind='modulo' AND m.name=? AND a.status='running'`, [taskId, moduleName]);
    if (running.length) return { module: moduleName, ok: true, skipped: 'ya trabajando' };
    const mrow = await db.query(`SELECT id FROM ${db.t('assistant_module')} WHERE name=? AND active=1 LIMIT 1`, [moduleName]);
    if (!mrow.length) return { module: moduleName, ok: false, error: 'módulo desconocido o inactivo' };

    const taskRow = await db.query(`SELECT definition FROM ${db.t('assistant_task')} WHERE id=?`, [taskId]);
    const definition = (taskRow[0] && taskRow[0].definition) || '';
    const posRow = await db.query(`SELECT COALESCE(MAX(position)+1,0) AS p FROM ${db.t('assistant_agent')} WHERE task_id=? AND kind='modulo'`, [taskId]);
    const r = await db.query(
        `INSERT INTO ${db.t('assistant_agent')} (task_id, kind, module_id, title, status, position)
         VALUES (?, 'modulo', ?, ?, 'running', ?)`, [taskId, mrow[0].id, moduleName, posRow[0].p]);
    const agentId = r.insertId;
    await db.query(`UPDATE ${db.t('assistant_agent')} SET tmux_name=? WHERE id=?`, [`inproc:${agentId}`, agentId]);
    await ensureMessageSchema(db.query, db.t).catch(() => {});

    const moduleDir = path.join(WORK_DIR, MODULES_REL, moduleName);
    pushLine(agentId, `▶ agente ${moduleName} (in-process)`);

    // Fire-and-forget (como el arranque de tmux): la petición del Estratega no se bloquea.
    runModuleAgent({
        provider: getProvider(), moduleName, moduleDir, brief, definition, readOnly: false,
        bus: bus(), taskId,
        onEvent: (e) => { const l = formatEvent(e); if (l) pushLine(agentId, l); },
    }).then(async (res) => {
        pushLine(agentId, `✓ ${String(res.summary).slice(0, 160)}`);
        await db.query(`UPDATE ${db.t('assistant_agent')} SET status='exited' WHERE id=?`, [agentId]).catch(() => {});
    }).catch(async (e) => {
        pushLine(agentId, `ERROR: ${e.message}`);
        await db.query(`UPDATE ${db.t('assistant_agent')} SET status='exited' WHERE id=?`, [agentId]).catch(() => {});
    });

    return { agentId, module: moduleName, ok: true };
}

module.exports = { launch, tailFor, isInproc, formatEvent, _buffers: buffers };
