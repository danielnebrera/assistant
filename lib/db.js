"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Capa de BD del `assistant`.                                               ║
// ║                                                                            ║
// ║  El assistant tiene su PROPIA BD aislada (p.ej. `factory_assistant`), NO   ║
// ║  la BD de la app: es el componente común/canónico y sus datos no se        ║
// ║  mezclan con los del proyecto. Posee sus tablas `assistant_*` SIN prefijo. ║
// ║                                                                            ║
// ║  Config 100% por entorno (.env del assistant): DB_HOST/DB_USER/            ║
// ║  DB_PASSWORD/DB_DATABASE. Cada despliegue apunta a su propia BD.           ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const mysql = require('mysql');

const ENV    = (process.env.ENV || 'dev').toLowerCase();   // dev | test | pro (informativo)
const PREFIX = '';   // BD propia (factory_assistant): tablas assistant_* SIN prefijo de entorno

const pool = mysql.createPool({
    connectionLimit: 10,
    host:     process.env.DB_HOST     || '127.0.0.1',
    user:     process.env.DB_USER     || 'factory',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE || 'factory',
    charset:  'utf8mb4',
});

// t('assistant_task') -> 'assistant_task' (sin prefijo; BD propia del assistant)
function t(name) { return PREFIX + name; }

// Tablas de AUTH de la app (users/roles/activities) para el login propio. NO viven
// en la BD del assistant: se leen de la BD de la app, cualificadas (`factory`.`dev_*`).
// El usuario de BD del assistant debe tener SELECT sobre ellas. APP_ENV permite
// forzar el prefijo (dev_/pro_) si difiere del ENV del assistant.
const APP_DB     = process.env.APP_DB_DATABASE || 'factory';
const APP_PREFIX = (process.env.APP_ENV || ENV) + '_';
function appT(name) { return '`' + APP_DB + '`.`' + APP_PREFIX + name + '`'; }

function query(sql, params) {
    return new Promise((resolve, reject) =>
        pool.query(sql, params, (e, r) => e ? reject(e) : resolve(r)));
}

// Crea las tablas del assistant si no existen (idempotente). Se llama al arrancar.
// Tablas (prefijadas por entorno):
//   assistant_module          — los módulos/secciones (microservicios) de la app
//   assistant_task            — las tareas (1 tarea = 1 sesión de trabajo)
//   assistant_task_message    — el chat no-técnico usuario ↔ Estratega de la tarea
//   assistant_agent           — las columnas del detalle (Estratega + 1 por módulo)
//   assistant_commit          — los commits ligados a la tarea
async function ensureSchema() {
    await query(`CREATE TABLE IF NOT EXISTS ${t('assistant_module')} (
        id           INT NOT NULL AUTO_INCREMENT,
        name         VARCHAR(64)  NOT NULL,
        label        VARCHAR(128) DEFAULT NULL,
        path         VARCHAR(255) NOT NULL,
        spec_path    VARCHAR(255) DEFAULT NULL,
        has_spec     TINYINT(1)   NOT NULL DEFAULT 0,
        description  TEXT,
        active       TINYINT(1)   NOT NULL DEFAULT 1,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_module_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await query(`CREATE TABLE IF NOT EXISTS ${t('assistant_task')} (
        id           INT NOT NULL AUTO_INCREMENT,
        title        VARCHAR(255) NOT NULL,
        definition   MEDIUMTEXT,
        status       VARCHAR(32)  NOT NULL DEFAULT 'pendiente',
        user_id      INT          DEFAULT NULL,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_task_user (user_id),
        KEY idx_task_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await query(`CREATE TABLE IF NOT EXISTS ${t('assistant_task_message')} (
        id           INT NOT NULL AUTO_INCREMENT,
        task_id      INT          NOT NULL,
        role         ENUM('user','assistant') NOT NULL,
        content      MEDIUMTEXT   NOT NULL,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_msg_task (task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    await query(`CREATE TABLE IF NOT EXISTS ${t('assistant_agent')} (
        id           INT NOT NULL AUTO_INCREMENT,
        task_id      INT          NOT NULL,
        kind         ENUM('estrategia','modulo') NOT NULL,
        module_id    INT          DEFAULT NULL,
        title        VARCHAR(128) NOT NULL,
        tmux_name    VARCHAR(64)  DEFAULT NULL,
        pid          INT          DEFAULT NULL,
        status       ENUM('idle','running','exited') NOT NULL DEFAULT 'idle',
        position     INT          NOT NULL DEFAULT 0,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_agent_tmux (tmux_name),
        KEY idx_agent_task (task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    // Columnas de resultado de tests por agente (añadidas idempotentemente; MySQL
    // no soporta ADD COLUMN IF NOT EXISTS, así que comprobamos information_schema).
    await ensureColumn('assistant_agent', 'test_status', `ALTER TABLE ${t('assistant_agent')} ADD COLUMN test_status ENUM('none','running','passed','failed') NOT NULL DEFAULT 'none'`);
    await ensureColumn('assistant_agent', 'test_output', `ALTER TABLE ${t('assistant_agent')} ADD COLUMN test_output MEDIUMTEXT`);

    await query(`CREATE TABLE IF NOT EXISTS ${t('assistant_commit')} (
        id           INT NOT NULL AUTO_INCREMENT,
        task_id      INT          NOT NULL,
        sha          VARCHAR(64)  NOT NULL,
        message      TEXT,
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_commit_task (task_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// Añade una columna solo si no existe (MySQL no tiene ADD COLUMN IF NOT EXISTS).
async function ensureColumn(table, column, alterSql) {
    const rows = await query(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
        [t(table), column]);
    if (!rows.length) await query(alterSql);
}

module.exports = { pool, query, t, appT, ensureSchema, ensureColumn, ENV, PREFIX };
