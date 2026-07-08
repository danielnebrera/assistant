"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Feed en vivo de la actividad del Estratega, por tarea (SSE).              ║
// ║                                                                            ║
// ║  El Estratega corre EN-PROCESO un bucle agéntico que emite eventos         ║
// ║  (leer fichero, grep, pensar…). Aquí los traducimos a líneas legibles y    ║
// ║  las empujamos por Server-Sent Events a la columna «Estratega» del panel,  ║
// ║  para que el usuario VEA que está trabajando y qué hace.                   ║
// ║                                                                            ║
// ║  SSE (no WebSocket) a propósito: es unidireccional server→cliente (justo   ║
// ║  lo que necesitamos), va por HTTP tras el mismo gate JWT y NO toca el       ║
// ║  bridge WS↔tmux del terminal (delicado).                                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const subscribers = new Map();   // taskId -> Set<res>
const history = new Map();       // taskId -> [rec]  (últimas líneas, para reconexión)
const active = new Map();        // taskId -> bool   (turno en curso)
const MAX = 60;

const key = (t) => String(t);
function subs(t) { let s = subscribers.get(key(t)); if (!s) { s = new Set(); subscribers.set(key(t), s); } return s; }
function sendTo(res, obj) { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (e) { /* cliente caído */ } }

// Alta de un cliente SSE: le mandamos el estado actual + el historial reciente.
function subscribe(taskId, res) {
    const s = subs(taskId);
    s.add(res);
    sendTo(res, { kind: 'state', working: !!active.get(key(taskId)) });
    for (const h of (history.get(key(taskId)) || [])) sendTo(res, h);
    res.on('close', () => { s.delete(res); });
}

function publish(taskId, rec) {
    const buf = history.get(key(taskId)) || [];
    buf.push(rec); while (buf.length > MAX) buf.shift();
    history.set(key(taskId), buf);
    for (const res of subs(taskId)) sendTo(res, rec);
}

function startTurn(taskId) { active.set(key(taskId), true); history.set(key(taskId), []); publish(taskId, { kind: 'turn', working: true }); }
function endTurn(taskId) { active.set(key(taskId), false); publish(taskId, { kind: 'turn', working: false }); }

// Traduce un evento del bucle (llm/loop) a una línea legible; null = ruido a ignorar.
function short(v) { if (v == null) return ''; v = typeof v === 'string' ? v : JSON.stringify(v); return v.length > 90 ? v.slice(0, 90) + '…' : v; }
function describe(ev) {
    switch (ev.type) {
        case 'tool_call': {
            const i = ev.input || {};
            const n = ev.name;
            if (n === 'read_file' || n === 'Read') return `📖 leyendo ${short(i.path || i.file || '')}`;
            if (n === 'grep' || n === 'Grep') return `🔍 buscando "${short(i.pattern || i.query || i.q || '')}"`;
            if (n === 'glob' || n === 'Glob') return `📂 listando ${short(i.pattern || i.glob || '')}`;
            if (n === 'sql_query') return `🗄️ consultando la BD`;
            return `🔧 ${n} ${short(i)}`;
        }
        case 'assistant_message': {
            const tx = (ev.text || '').trim();
            if (!tx || tx[0] === '{') return null;   // el JSON final (la respuesta) va al chat, no al feed
            return `💭 ${short(tx)}`;
        }
        case 'done': return '✓ listo';
        case 'max_steps': return '⚠️ límite de pasos alcanzado';
        case 'aborted': return '⏱️ tiempo agotado';
        default: return null;   // step_start / tool_result: ruido
    }
}
function fromLoopEvent(taskId, ev) {
    const line = describe(ev);
    if (line) publish(taskId, { kind: 'act', line });
}

module.exports = { subscribe, publish, startTurn, endTurn, fromLoopEvent, describe };
