"use strict";
// API JSON del assistant para los tabs "Tareas" y "Módulos".
// Se monta bajo /api en app.js, DETRÁS del mismo gate que /claude (JWT +
// permiso CLAUDE_CODE_VIEW). `req.user` ya viene poblado por el gate.
const express = require('express');
const router  = express.Router();
const modules   = require('./modules_store');
const tasks     = require('./tasks_store');
const estratega = require('./estratega');
const agents    = require('./agents');

const wrap = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch(err => {
        console.error('[assistant/api]', err.message);
        res.status(500).json({ error: err.message });
    });

// Carga la tarea de :id y verifica que es del usuario. Si no, responde el error
// y devuelve null (el handler debe `if (!task) return;`).
async function ownTask(req, res) {
    const task = await tasks.get(req.params.id);
    if (!task) { res.status(404).json({ error: 'Tarea no encontrada' }); return null; }
    if (task.user_id && task.user_id !== req.user.user_id) { res.status(403).json({ error: 'No es tu tarea' }); return null; }
    return task;
}

// Resumen legible de las acciones ejecutadas que llevan resultado (tests, commit,
// lanzamiento o errores), para dejar feedback en el chat. '' si no hay nada notable.
function summarizeActions(executed) {
    const parts = [];
    for (const e of executed || []) {
        if (e.error) parts.push(`no pude «${e.op}»${e.module ? ' (' + e.module + ')' : ''}: ${e.error}`);
        else if (e.op === 'probar') parts.push(e.allPass ? 'tests en verde ✅' : 'hay tests en rojo ❌');
        else if (e.op === 'guardar') parts.push('cambios guardados' + (e.sha ? ' (' + e.sha + ')' : ''));
        else if (e.op === 'lanzar' && e.launched) parts.push('desarrollo iniciado: ' + e.launched + ' agente(s)');
    }
    return parts.join('; ');
}

/* ── Módulos ─────────────────────────────────────────────────────────────── */
router.get('/modules', wrap(async (req, res) => {
    res.json({ modules: await modules.list() });
}));

/* ── Tareas ──────────────────────────────────────────────────────────────── */
router.get('/tasks', wrap(async (req, res) => {
    res.json({
        tasks:    await tasks.list(req.user.user_id),
        statuses: tasks.STATUSES,
    });
}));

router.post('/tasks', wrap(async (req, res) => {
    const title = (req.body && req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Falta el título de la tarea' });
    const id = await tasks.create({ user_id: req.user.user_id, title });
    res.json({ id });
}));

router.get('/tasks/:id', wrap(async (req, res) => {
    const t0 = await tasks.get(req.params.id);
    if (!t0) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (t0.user_id && t0.user_id !== req.user.user_id)
        return res.status(403).json({ error: 'No es tu tarea' });
    await agents.syncStatuses(req.params.id);   // marca running/exited según tmux
    const d = await tasks.detail(req.params.id);
    d.statuses    = tasks.STATUSES;
    d.statusLabel = tasks.STATUS_LABEL;
    res.json(d);
}));

// NOTA: 'Ejecutar tests' y 'Aceptar y guardar' ya NO son endpoints propios: el usuario
// los pide por el chat y el Estratega los ejecuta como acciones (probar / guardar).

// El usuario escribe en el chat no-técnico. Se guarda su mensaje y el ESTRATEGA
// responde (turno no interactivo del CLI claude): contesta y mantiene al día la
// definición de la tarea. Devolvemos el detalle completo ya actualizado.
router.post('/tasks/:id/messages', wrap(async (req, res) => {
    const content = (req.body && req.body.content || '').trim();
    if (!content) return res.status(400).json({ error: 'Mensaje vacío' });
    const task = await tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.user_id && task.user_id !== req.user.user_id)
        return res.status(403).json({ error: 'No es tu tarea' });
    await tasks.addMessage(task.id, 'user', content);
    // Si hay agentes vivos, el Estratega puede además decidir acciones sobre ellos
    // (parar / corregir / parar todos). Le pasamos su estado y ejecutamos lo que decida.
    await agents.syncStatuses(task.id);
    const states = await agents.agentStates(task.id);
    const out = await estratega.respond(task.id, states);   // añade la respuesta + (def/estado)
    const executed = (out && out.actions && out.actions.length) ? await agents.executeActions(task.id, out.actions) : [];
    const note = summarizeActions(executed);   // feedback de tests/commit/lanzar/errores
    if (note) await tasks.addMessage(task.id, 'assistant', '🤖 ' + note);
    const d = await tasks.detail(task.id);
    d.statuses = tasks.STATUSES; d.statusLabel = tasks.STATUS_LABEL;
    res.json(d);
}));

// NOTA: el usuario NO controla a los agentes directamente (no hay endpoints de
// parar/matar/enviar manuales). Solo habla con el chat; el Estratega gestiona a los
// agentes automáticamente vía `actions` (executeActions) en /messages y /supervise.

// Tick de SUPERVISIÓN (Fase 2): el Estratega revisa a los agentes vivos y decide
// acciones (parar/corregir/parar todos). Lo dispara el cliente cada N s mientras
// haya agentes en marcha y la supervisión esté activa. Devuelve el detalle + nota.
router.post('/tasks/:id/supervise', wrap(async (req, res) => {
    const task = await ownTask(req, res); if (!task) return;
    await agents.syncStatuses(task.id);
    const states = await agents.agentStates(task.id);
    const live = states.filter(s => s.status === 'running');
    if (!live.length) {
        const d0 = await tasks.detail(task.id);
        d0.statuses = tasks.STATUSES; d0.statusLabel = tasks.STATUS_LABEL;
        d0.supervision = { active: false };
        return res.json(d0);
    }
    const r = await estratega.supervise(task.id, states);
    const executed = (r.actions && r.actions.length) ? await agents.executeActions(task.id, r.actions) : [];
    // Solo dejamos rastro en el chat si el Estratega tiene algo que decir/hizo algo.
    if (r.note || executed.length) {
        const tail = executed.length ? '  ·  acciones: ' + executed.map(e => e.op + (e.module ? '(' + e.module + ')' : '')).join(', ') : '';
        await tasks.addMessage(task.id, 'assistant', '🤖 ' + (r.note || 'Intervención del supervisor.') + tail);
    }
    const d = await tasks.detail(task.id);
    d.statuses = tasks.STATUSES; d.statusLabel = tasks.STATUS_LABEL;
    d.supervision = { active: true, note: r.note || '', actions: executed };
    res.json(d);
}));

module.exports = router;
