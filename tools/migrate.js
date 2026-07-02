"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Runner de migraciones incrementales (capa central: 1 BD `factory` +       ║
// ║  prefijo de entorno por tabla dev_ / test_ / pro_).                        ║
// ║                                                                            ║
// ║  Vive en /assistant (herramienta COMÚN de plataforma, evolucionable por    ║
// ║  git pull para todas las apps). Opera sobre el árbol de una app concreta   ║
// ║  (--app-dir), aplicando los .sql de <app>/<servicio>/sql/migrations/ que    ║
// ║  aún no consten en la tabla-registro `<prefijo>schema_migrations`.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Uso:
//   node tools/migrate.js status   [--env=dev|pro|test] [--app-dir=PATH] [--service=S|all]
//   node tools/migrate.js up        [--env=...] [--app-dir=...] [--service=...] [--dry-run]
//   node tools/migrate.js baseline  [--env=...] [--app-dir=...] [--service=...]
//
//   status    → lista, por servicio, las migraciones aplicadas y las pendientes.
//   up        → aplica en orden las pendientes y las registra. --dry-run: enseña
//               el SQL (ya prefijado) sin ejecutar ni registrar.
//   baseline  → marca TODAS las migraciones como aplicadas SIN ejecutarlas. Para
//               entornos cuyo esquema YA está al día (p.ej. recién instalados desde
//               1.install.sql, o parcheados a mano). Evita que un ADD COLUMN vuelva
//               a intentarse sobre una columna que ya existe.
//
// Convención de ficheros:  <app>/<servicio>/sql/migrations/NNN_slug.sql
//   - NNN numérico con ceros (001, 002, …) → orden lexicográfico = orden de aplicación.
//   - SQL SIN prefijo de entorno: se escribe `ALTER TABLE expenses …` y el runner
//     lo reescribe a `dev_expenses` / `pro_expenses` según --env (igual que
//     tools/migrate_schema.js del app). Un fichero puede tener varias sentencias.
//   - Idempotencia: MySQL no soporta ADD COLUMN IF NOT EXISTS; si una migración
//     puede encontrarse ya aplicada, escríbela defensiva (comprobar en
//     information_schema) o usa `baseline`. Un fallo detiene el runner y NO registra
//     la migración (se reintenta al siguiente `up`).
const fs   = require('fs');
const path = require('path');
const mysql = require('mysql');

// ── Args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const cmd  = argv.find(a => !a.startsWith('--')) || 'status';
const opt  = (name, def) => {
    const hit = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
    if (!hit) return def;
    const eq = hit.indexOf('=');
    return eq === -1 ? true : hit.slice(eq + 1);
};

const APP_DIR = path.resolve(opt('app-dir', process.env.CLAUDE_WORK_DIR || '/home/factory/app/dev'));
const ENV     = String(opt('env', process.env.ENV || 'dev')).toLowerCase();
const SERVICE = opt('service', 'all');
const DRY_RUN = !!opt('dry-run', false);
const PREFIX  = ENV === 'test' ? '' : ENV + '_';  // tests: sin prefijo (BD aislada)
const LEDGER  = PREFIX + 'schema_migrations';

if (!['status', 'up', 'baseline'].includes(cmd)) {
    console.error('comando desconocido: ' + cmd + ' (status|up|baseline)');
    process.exit(1);
}

// ── Credenciales de BD: del .env central de la app (no del entorno del proceso) ──
function loadDbEnv(appDir) {
    const envFile = path.join(appDir, '.env');
    let parsed = {};
    try { parsed = require('dotenv').parse(fs.readFileSync(envFile)); } catch (_) {}
    return {
        host:     parsed.DB_HOST     || process.env.DB_HOST     || '127.0.0.1',
        user:     parsed.DB_USER     || process.env.DB_USER     || 'factory',
        password: parsed.DB_PASSWORD || process.env.DB_PASSWORD,
        database: parsed.DB_DATABASE || process.env.DB_DATABASE || 'factory',
    };
}

// ── Descubrir servicios (carpetas con sql/) y su lista global de tablas ──────────
function listServices(appDir) {
    return fs.readdirSync(appDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map(d => d.name)
        .filter(s => fs.existsSync(path.join(appDir, s, 'sql')))
        .sort();
}

function tablesFromSql(sql) {
    return [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+`?([A-Za-z0-9_]+)`?/gi)]
        .map(m => m[1]).filter(t => t !== 'schema_migrations');
}

// Lista GLOBAL de tablas de la app (todas sus 1.install.sql + CREATE TABLE en
// migraciones). Prefijar con la lista global evita fallos con FKs entre servicios:
// el prefijo solo actúa en posición de tabla y es idempotente.
function globalTables(appDir, services) {
    const set = new Set();
    for (const s of services) {
        const install = path.join(appDir, s, 'sql', '1.install.sql');
        if (fs.existsSync(install)) tablesFromSql(fs.readFileSync(install, 'utf8')).forEach(t => set.add(t));
        for (const f of migrationFiles(appDir, s)) {
            tablesFromSql(fs.readFileSync(f.abs, 'utf8')).forEach(t => set.add(t));
        }
    }
    return [...set];
}

function migrationFiles(appDir, service) {
    const dir = path.join(appDir, service, 'sql', 'migrations');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => /\.sql$/i.test(f))
        .sort()
        .map(f => ({ name: f, abs: path.join(dir, f) }));
}

// ── Prefijar el SQL de una migración (misma lógica que tools/migrate_schema.js) ──
function prefixSql(sql, tables) {
    if (!tables.length) return sql;
    // Quitar CREATE DATABASE / USE: se ejecuta sobre la BD ya seleccionada.
    sql = sql.replace(/^\s*CREATE DATABASE\b[\s\S]*?;\s*$/gim, '');
    sql = sql.replace(/^\s*USE\b.*?;\s*$/gim, '');
    // Nombres de constraint FK son globales por BD → quitarlos (MySQL autogenera únicos).
    sql = sql.replace(/CONSTRAINT\s+`[^`]+`\s+FOREIGN KEY/gi, 'FOREIGN KEY');
    const alt = tables.slice().sort((a, b) => b.length - a.length).join('|');
    const re = new RegExp(
        '((?:CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+|DROP TABLE(?:\\s+IF EXISTS)?\\s+|' +
        'INSERT INTO\\s+|REFERENCES\\s+|LOCK TABLES\\s+|ALTER TABLE\\s+|TRUNCATE(?:\\s+TABLE)?\\s+|' +
        'UPDATE\\s+|DELETE FROM\\s+|FROM\\s+|JOIN\\s+|INTO\\s+)`?)(' + alt + ')(`?)\\b',
        'gi');
    // Cualificador de columna `tabla`.col / tabla.col (necesario si se renombró la tabla en el FROM).
    const reQual = new RegExp('(`?)\\b(' + alt + ')(`?)(\\s*\\.)', 'gi');
    return sql
        .replace(re, (m, pre, name, tick) => pre + PREFIX + name + tick)
        .replace(reQual, (m, t1, name, t2, dot) => t1 + PREFIX + name + t2 + dot);
}

// ── Helpers de conexión ─────────────────────────────────────────────────────────
function connect(dbEnv) {
    return mysql.createConnection({ ...dbEnv, charset: 'utf8mb4', multipleStatements: true });
}
const q = (conn, sql, params) => new Promise((res, rej) =>
    conn.query(sql, params, (e, r) => e ? rej(e) : res(r)));

async function ensureLedger(conn) {
    await q(conn,
        'CREATE TABLE IF NOT EXISTS `' + LEDGER + '` (' +
        '  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY,' +
        '  `service` VARCHAR(64) NOT NULL,' +
        '  `filename` VARCHAR(255) NOT NULL,' +
        '  `checksum` CHAR(64) NOT NULL,' +
        '  `applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
        '  UNIQUE KEY `uq_service_file` (`service`,`filename`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
}
async function appliedSet(conn, service) {
    const rows = await q(conn, 'SELECT filename FROM `' + LEDGER + '` WHERE service=?', [service]);
    return new Set(rows.map(r => r.filename));
}
const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    const dbEnv    = loadDbEnv(APP_DIR);
    const services = (SERVICE === 'all' ? listServices(APP_DIR) : [SERVICE])
        .filter(s => fs.existsSync(path.join(APP_DIR, s)));
    const tables   = globalTables(APP_DIR, listServices(APP_DIR));

    console.log(`# migrate ${cmd} · app=${APP_DIR} · env=${ENV} · prefijo='${PREFIX}' · ledger=${LEDGER}`);
    if (DRY_RUN) console.log('# (dry-run: no ejecuta ni registra)');

    const conn = connect(dbEnv);
    await new Promise((res, rej) => conn.connect(e => e ? rej(e) : res()));
    let hadError = false;
    try {
        await ensureLedger(conn);
        let totalPending = 0, totalApplied = 0;

        for (const service of services) {
            const files = migrationFiles(APP_DIR, service);
            if (!files.length) continue;
            const done = await appliedSet(conn, service);
            const pending = files.filter(f => !done.has(f.name));

            if (cmd === 'status') {
                console.log(`\n[${service}] ${files.length} migración(es): ${files.length - pending.length} aplicada(s), ${pending.length} pendiente(s)`);
                for (const f of files) console.log(`   ${done.has(f.name) ? '✓' : '·'} ${f.name}`);
                totalPending += pending.length;
                continue;
            }

            for (const f of files) {
                const raw = fs.readFileSync(f.abs);
                if (done.has(f.name)) continue;

                if (cmd === 'baseline') {
                    if (!DRY_RUN) await q(conn,
                        'INSERT INTO `' + LEDGER + '` (service, filename, checksum) VALUES (?,?,?)',
                        [service, f.name, sha256(raw)]);
                    console.log(`  [${service}] baseline ${f.name} (marcada sin ejecutar)`);
                    totalApplied++;
                    continue;
                }

                // cmd === 'up'
                const sql = prefixSql(raw.toString('utf8'), tables);
                if (DRY_RUN) {
                    console.log(`\n----- [${service}] ${f.name} (dry-run, SQL prefijado) -----\n${sql}\n`);
                    totalApplied++;
                    continue;
                }
                process.stdout.write(`  [${service}] aplicando ${f.name} … `);
                try {
                    await q(conn, sql);
                    await q(conn,
                        'INSERT INTO `' + LEDGER + '` (service, filename, checksum) VALUES (?,?,?)',
                        [service, f.name, sha256(raw)]);
                    console.log('OK');
                    totalApplied++;
                } catch (e) {
                    console.log('FALLO');
                    console.error(`     ${e.code || ''} ${e.message}`);
                    console.error('     → detenido; corrige la migración (o usa baseline si ya estaba aplicada).');
                    hadError = true;
                    break;
                }
            }
            if (hadError) break;
        }

        if (cmd === 'status') console.log(`\n# total pendientes: ${totalPending}`);
        else console.log(`\n# ${DRY_RUN ? '(dry-run) ' : ''}${cmd}: ${totalApplied} migración(es) ${cmd === 'baseline' ? 'marcadas' : 'aplicadas'}.`);
    } finally {
        conn.end();
    }
    process.exit(hadError ? 1 : 0);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
