"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Driver de cierre de workflow para agentes Aider.                          ║
// ║                                                                            ║
// ║  Orquesta un agente de módulo (vía aider_bridge) y CIERRA EL BUCLE:        ║
// ║   - vuelca sus eventos (start/question/error/done) al bus assistant_message║
// ║   - al terminar, AVISA AL USUARIO en el chat (rol 'assistant') — resuelve  ║
// ║     el problema original: "el usuario no se enteró de que terminó".        ║
// ║   - (dudas: hoy el runner auto-responde; el round-trip con el usuario por  ║
// ║     stdin es el siguiente incremento).                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const db = require('../lib/db');
const { createMessageBus, ensureMessageSchema } = require('./message_bus');
const tasks = require('../controllers/tasks_store');
const { launchAiderAgent } = require('./aider_bridge');

let _bus;
function bus() { if (!_bus) _bus = createMessageBus({ query: db.query, t: db.t }); return _bus; }

// Eventos que merecen fila en el bus (los verbosos log/assistant no).
const BUS_EVENTS = { start: 'status', question: 'question', error: 'note' };

/**
 * Ejecuta un agente Aider para una tarea/módulo y cierra el workflow.
 * @returns {Promise<{done, userMessage, events, stderr}>}
 */
async function runModuleTaskWithAider({ taskId, moduleName, moduleDir, model = 'haiku', brief, files = [], env = {}, onEvent }) {
    await ensureMessageSchema(db.query, db.t).catch(() => {});
    await bus().post({ taskId, sender: 'estratega', recipient: `agent:${moduleName}`, kind: 'instruction', payload: { brief } }).catch(() => {});

    const r = await launchAiderAgent({
        moduleDir, model, brief, files, env,
        onEvent: (ev, child) => {
            const kind = BUS_EVENTS[ev.event];
            if (kind) bus().post({ taskId, sender: `agent:${moduleName}`, recipient: 'estratega', kind, payload: ev }).catch(() => {});
            if (onEvent) { try { onEvent(ev, child); } catch (e) { /* no tumbar el bridge */ } }
        },
    });

    const done = r.done || { ok: false, error: r.stderr ? r.stderr.slice(-300) : 'sin evento done' };

    // Resultado estructurado al bus (para el Estratega/supervisión).
    await bus().post({ taskId, sender: `agent:${moduleName}`, recipient: 'estratega', kind: 'result', payload: done }).catch(() => {});

    // CIERRE hacia el USUARIO: mensaje en el chat (rol 'assistant').
    const userMessage = done.ok
        ? `He terminado en «${moduleName}». ${done.committed
            ? `Cambios (commit ${done.commit}): ${(done.files || []).join(', ') || '—'}.`
            : 'Sin cambios que aplicar.'} ¿Lo reviso o lo guardo?`
        : `El agente de «${moduleName}» no pudo completar: ${done.error || 'error desconocido'}.`;
    await tasks.addMessage(taskId, 'assistant', userMessage).catch(() => {});

    return { done, userMessage, events: r.events, stderr: r.stderr };
}

module.exports = { runModuleTaskWithAider };
