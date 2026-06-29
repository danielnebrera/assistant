"use strict";
// Almacén de sesiones del asistente en un FICHERO JSON local.
//
// Decisión de diseño: NO usamos la BD ni la app para esto. La fuente de verdad de
// "¿la sesión sigue viva?" es tmux; este store solo guarda el mapeo id→usuario,
// título y estado. Guardarlo en disco local hace que el asistente no dependa de
// nada externo (solo su proceso + tmux + claude) → /claude sobrevive a caídas de
// la app y de la BD.
const fs   = require('fs');
const path = require('path');

const FILE = process.env.SESSIONS_FILE || path.join(__dirname, '..', 'sessions.json');

function read() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (e) { return { seq: 0, sessions: {} }; }
}
function write(data) {
    try { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

exports.get = (id) => { const d = read(); return d.sessions[id] || null; };

exports.listByUser = (userId, status) => {
    const d = read();
    return Object.values(d.sessions)
        .filter(s => s.user_id === userId && (!status || s.status === status))
        .sort((a, b) => b.id - a.id);
};

exports.create = (fields) => {
    const d = read();
    const id = ++d.seq;
    d.sessions[id] = Object.assign({ id, status: 'running', created_at: Date.now() }, fields, { id });
    write(d);
    return id;
};

exports.update = (id, fields) => {
    const d = read();
    if (!d.sessions[id]) return;
    Object.assign(d.sessions[id], fields);
    write(d);
};
