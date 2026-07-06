"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Explorador de BD por módulo (solo lectura) para el tab "Módulos".         ║
// ║                                                                            ║
// ║  Cada módulo (`<servicio>/`) DECLARA sus tablas en `sql/1.install.sql`     ║
// ║  (Regla de Oro: un módulo solo toca SUS tablas). Esa lista de CREATE       ║
// ║  TABLE es la fuente de verdad de "qué tablas son de este módulo" y a la    ║
// ║  vez la LISTA BLANCA de seguridad: solo se puede navegar una tabla que el  ║
// ║  módulo declara. Las tablas reales viven en la BD de la app (`factory`,    ║
// ║  prefijo de entorno `dev_`/`pro_`), NO en la BD del assistant — se leen    ║
// ║  cualificadas vía db.appT(). El usuario de BD del assistant tiene SELECT.  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const fs      = require('fs');
const path    = require('path');
const db      = require('../lib/db');
const modules = require('./modules_store');

const CREATE_TABLE_RE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([A-Za-z0-9_]+)`?/gi;

// Tablas que un módulo DECLARA en su sql/1.install.sql (nombres SIN prefijo de
// entorno). Devuelve un Set para validar pertenencia (lista blanca de seguridad).
async function ownedTables(moduleName) {
    const mod = await modules.getByName(moduleName);
    if (!mod) return null;                              // módulo desconocido
    const installSql = path.join(mod.path, 'sql', '1.install.sql');
    let sql;
    try { sql = fs.readFileSync(installSql, 'utf8'); } catch (e) { return new Set(); }
    const names = new Set();
    let m;
    while ((m = CREATE_TABLE_RE.exec(sql)) !== null) names.add(m[1]);
    CREATE_TABLE_RE.lastIndex = 0;
    return names;
}

// Lista de tablas del módulo que EXISTEN en la BD de la app, con nº aprox. de
// filas (TABLE_ROWS de information_schema, barato). Devuelve null si el módulo
// no existe. Excluye las declaradas pero aún no migradas (no están en la BD).
async function tables(moduleName) {
    const owned = await ownedTables(moduleName);
    if (owned === null) return null;
    if (!owned.size) return [];
    const prefixed = [...owned].map(n => db.APP_PREFIX + n);
    const rows = await db.query(
        `SELECT TABLE_NAME AS tn, TABLE_ROWS AS n
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (?)`,
        [db.APP_DB, prefixed]);
    const p = db.APP_PREFIX;
    return rows
        .map(r => ({ name: r.tn.startsWith(p) ? r.tn.slice(p.length) : r.tn, rows: r.n }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Lee una página de una tabla del módulo. Valida que la tabla PERTENECE al módulo
// (lista blanca) antes de tocar la BD — evita inyección/lectura arbitraria, ya que
// el identificador no puede parametrizarse. Devuelve columnas + filas + total.
async function read(moduleName, table, offset, limit) {
    const owned = await ownedTables(moduleName);
    if (owned === null) { const e = new Error('Módulo no encontrado'); e.status = 404; throw e; }
    if (!owned.has(table)) { const e = new Error('Tabla no pertenece al módulo'); e.status = 403; throw e; }

    const off = Math.max(0, parseInt(offset, 10) || 0);
    const lim = Math.min(100, Math.max(1, parseInt(limit, 10) || 10));
    const q   = db.appT(table);                         // `factory`.`dev_<table>` (identificador seguro)

    const cols  = await db.query(`SHOW COLUMNS FROM ${q}`);
    const cnt   = await db.query(`SELECT COUNT(*) AS n FROM ${q}`);
    const rows  = await db.query(`SELECT * FROM ${q} LIMIT ${lim} OFFSET ${off}`);
    return {
        table,
        columns: cols.map(c => c.Field),
        rows,
        total: cnt[0] ? cnt[0].n : 0,
        offset: off,
        limit: lim,
    };
}

module.exports = { ownedTables, tables, read };
