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

// "Empezar a desarrollar": el Estratega planifica y lanza un agente por módulo.
router.post('/tasks/:id/start', wrap(async (req, res) => {
    const task = await tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.user_id && task.user_id !== req.user.user_id)
        return res.status(403).json({ error: 'No es tu tarea' });
    if (!task.definition || !task.definition.trim())
        return res.status(400).json({ error: 'La tarea aún no tiene definición. Termina de explicarla en el chat.' });
    await agents.planAndLaunch(task.id);
    const d = await tasks.detail(task.id);
    d.statuses = tasks.STATUSES; d.statusLabel = tasks.STATUS_LABEL;
    res.json(d);
}));

// "Ejecutar tests": corre los tests de los módulos de la tarea y guarda el resultado.
router.post('/tasks/:id/test', wrap(async (req, res) => {
    const task = await tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.user_id && task.user_id !== req.user.user_id)
        return res.status(403).json({ error: 'No es tu tarea' });
    const r = await agents.runTests(task.id);
    const d = await tasks.detail(task.id);
    d.statuses = tasks.STATUSES; d.statusLabel = tasks.STATUS_LABEL; d.testRun = r;
    res.json(d);
}));

// "Aceptar y guardar": commit de los cambios de los módulos, ligado a la tarea.
router.post('/tasks/:id/accept', wrap(async (req, res) => {
    const task = await tasks.get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (task.user_id && task.user_id !== req.user.user_id)
        return res.status(403).json({ error: 'No es tu tarea' });
    await agents.commitTask(task.id);
    const d = await tasks.detail(task.id);
    d.statuses = tasks.STATUSES; d.statusLabel = tasks.STATUS_LABEL;
    res.json(d);
}));

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
    await estratega.respond(task.id);   // añade la respuesta + actualiza definición/estado
    const d = await tasks.detail(task.id);
    d.statuses = tasks.STATUSES; d.statusLabel = tasks.STATUS_LABEL;
    res.json(d);
}));

module.exports = router;
