"use strict";
// Tabla de MÓDULOS (secciones / microservicios) de la app que el assistant gestiona.
//
// La fuente de verdad es el código: cada subcarpeta de CLAUDE_WORK_DIR que sea un
// módulo (tiene `SPEC.md` y/o `app.js`) es una sección. Al arrancar sembramos/
// sincronizamos la tabla `assistant_module` con lo que hay en disco (upsert), de
// modo que el tab "Módulos" siempre refleja la realidad sin mantenimiento manual.
const fs   = require('fs');
const path = require('path');
const db   = require('../lib/db');

const WORK_DIR = process.env.CLAUDE_WORK_DIR || path.join(__dirname, '..', '..');
// Monolito modular: los módulos viven bajo `app/modules/<m>/` y su contrato es
// `CLAUDE.md` (configurable por si cambia el layout en otro proyecto).
const MODULES_REL  = process.env.MODULES_DIR || 'app/modules';
const CONTRACT     = process.env.MODULE_CONTRACT_FILE || 'CLAUDE.md';
const MODULES_ABS  = path.join(WORK_DIR, MODULES_REL);

// Carpetas que NO son módulos de negocio.
const SKIP = new Set(['node_modules', 'shared', 'tools', '.git', '.claude', 'uploads', 'public', 'test']);

// Descubre los módulos: cada subcarpeta de `app/modules/`. Su contrato es CLAUDE.md.
function discover() {
    let entries = [];
    try { entries = fs.readdirSync(MODULES_ABS, { withFileTypes: true }); } catch (e) { return []; }
    const mods = [];
    for (const e of entries) {
        if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const dir      = path.join(MODULES_ABS, e.name);
        const specPath = path.join(dir, CONTRACT);
        const hasSpec  = fs.existsSync(specPath);
        mods.push({ name: e.name, path: dir, spec_path: hasSpec ? specPath : null, has_spec: hasSpec ? 1 : 0 });
    }
    return mods;
}

// Upsert de cada módulo descubierto. No borra los que ya no estén (se marcan
// inactivos) para no perder histórico de tareas que los referencian.
async function sync() {
    const found = discover();
    const names = found.map(m => m.name);
    for (const m of found) {
        await db.query(
            `INSERT INTO ${db.t('assistant_module')} (name, label, path, spec_path, has_spec, active)
             VALUES (?,?,?,?,?,1)
             ON DUPLICATE KEY UPDATE path=VALUES(path), spec_path=VALUES(spec_path),
                                     has_spec=VALUES(has_spec), active=1`,
            [m.name, m.name, m.path, m.spec_path, m.has_spec]
        );
    }
    if (names.length) {
        await db.query(
            `UPDATE ${db.t('assistant_module')} SET active=0 WHERE name NOT IN (?)`, [names]
        );
    }
    return found.length;
}

async function list() {
    return db.query(
        `SELECT id, name, label, path, spec_path, has_spec, description, active
           FROM ${db.t('assistant_module')} ORDER BY active DESC, name ASC`
    );
}

async function getById(id) {
    const rows = await db.query(`SELECT * FROM ${db.t('assistant_module')} WHERE id=?`, [id]);
    return rows[0] || null;
}

module.exports = { discover, sync, list, getById, WORK_DIR };
