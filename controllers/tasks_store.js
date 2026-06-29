"use strict";
// Tabla de TAREAS del assistant. Una tarea = una sesión de trabajo sobre la app.
//
// El usuario (no técnico) ve y escribe, pero no "toca" nada más: crea tareas y
// conversa con el Estratega en el chat. El Estratega resume esa charla en la
// DEFINICIÓN de la tarea y, más adelante (fases 2-3), abre agentes por módulo.
const db = require('../lib/db');

// Ciclo de vida de una tarea. Clave técnica → etiqueta para no-técnicos.
// El orden es el del flujo: definición → realización → tests → ejecución →
// aceptación → commit.
const STATUSES = [
    { key: 'pendiente',       label: 'Pendiente',                step: 0 },
    { key: 'definicion',      label: 'Definiendo',               step: 1 },
    { key: 'realizacion',     label: 'Desarrollando',            step: 2 },
    { key: 'tests_auto',      label: 'Escribiendo pruebas',      step: 3 },
    { key: 'ejecucion_tests', label: 'Probando',                 step: 4 },
    { key: 'aceptacion',      label: 'Esperando tu visto bueno', step: 5 },
    { key: 'commit',          label: 'Guardando cambios',        step: 6 },
    { key: 'hecho',           label: 'Terminada',                step: 7 },
];
const STATUS_KEYS  = STATUSES.map(s => s.key);
const STATUS_LABEL = Object.fromEntries(STATUSES.map(s => [s.key, s.label]));

/* ── Tareas ──────────────────────────────────────────────────────────────── */
async function create({ user_id, title }) {
    const r = await db.query(
        `INSERT INTO ${db.t('assistant_task')} (title, status, user_id) VALUES (?, 'pendiente', ?)`,
        [String(title || 'Tarea sin título').slice(0, 255), user_id || null]
    );
    return r.insertId;
}

async function list(user_id) {
    return db.query(
        `SELECT t.id, t.title, t.status, t.created_at, t.updated_at,
                (SELECT COUNT(*) FROM ${db.t('assistant_commit')} c WHERE c.task_id = t.id) AS commit_count
           FROM ${db.t('assistant_task')} t
          ${user_id ? 'WHERE t.user_id = ?' : ''}
          ORDER BY t.updated_at DESC`,
        user_id ? [user_id] : []
    );
}

async function get(id) {
    const rows = await db.query(`SELECT * FROM ${db.t('assistant_task')} WHERE id=?`, [id]);
    return rows[0] || null;
}

async function setStatus(id, status) {
    if (!STATUS_KEYS.includes(status)) throw new Error('Estado no válido: ' + status);
    await db.query(`UPDATE ${db.t('assistant_task')} SET status=? WHERE id=?`, [status, id]);
}

async function setDefinition(id, definition) {
    await db.query(`UPDATE ${db.t('assistant_task')} SET definition=? WHERE id=?`, [definition, id]);
}

/* ── Chat (usuario ↔ Estratega) ──────────────────────────────────────────── */
async function addMessage(task_id, role, content) {
    const r = await db.query(
        `INSERT INTO ${db.t('assistant_task_message')} (task_id, role, content) VALUES (?,?,?)`,
        [task_id, role, content]
    );
    await db.query(`UPDATE ${db.t('assistant_task')} SET updated_at=CURRENT_TIMESTAMP WHERE id=?`, [task_id]);
    return r.insertId;
}

async function messages(task_id) {
    return db.query(
        `SELECT id, role, content, created_at FROM ${db.t('assistant_task_message')}
          WHERE task_id=? ORDER BY id ASC`, [task_id]
    );
}

/* ── Agentes (columnas: Estratega + 1 por módulo) ────────────────────────── */
async function agents(task_id) {
    return db.query(
        `SELECT a.id, a.task_id, a.kind, a.module_id, a.title, a.tmux_name, a.status, a.position,
                a.test_status, m.name AS module_name
           FROM ${db.t('assistant_agent')} a
           LEFT JOIN ${db.t('assistant_module')} m ON m.id = a.module_id
          WHERE a.task_id=? ORDER BY a.position ASC, a.id ASC`, [task_id]
    );
}

async function commits(task_id) {
    return db.query(
        `SELECT id, sha, message, created_at FROM ${db.t('assistant_commit')}
          WHERE task_id=? ORDER BY id DESC`, [task_id]
    );
}

// Vista completa para el detalle de la tarea.
async function detail(id) {
    const task = await get(id);
    if (!task) return null;
    const [msgs, ags, cms] = await Promise.all([messages(id), agents(id), commits(id)]);
    return { task, messages: msgs, agents: ags, commits: cms };
}

module.exports = {
    STATUSES, STATUS_KEYS, STATUS_LABEL,
    create, list, get, setStatus, setDefinition,
    addMessage, messages, agents, commits, detail,
};
