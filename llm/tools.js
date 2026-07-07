"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Herramientas PORTABLES — el catálogo que ofrece el bucle a cualquier IA.  ║
// ║                                                                            ║
// ║  Antes las ejecutaba el binario `claude` (Read/Grep/Glob/Bash). Ahora son  ║
// ║  handlers TUYOS: agnósticos del proveedor y con el VETO del guardián       ║
// ║  incorporado (una tool de escritura solo puede tocar dentro de `root`).    ║
// ║  Devuelve { defs, handlers } listos para pasar a runAgent().               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// ¿`target` está dentro de `root`? (misma lógica que hooks/guard-module.js) —
// convierte la Regla de Oro en un veto duro, agnóstico de la IA.
function isInside(target, root) {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function resolveWithin(root, p) {
    const abs = path.resolve(root, p);
    if (!isInside(abs, root)) throw new Error(`ruta fuera de la carpeta permitida (${root}): ${p}`);
    return abs;
}

async function walk(root, dir, out, { limit = 5000 } = {}) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (out.length >= limit) return;
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(root, full, out, { limit });
        else out.push(path.relative(root, full));
    }
}

// Convierte un patrón glob a RegExp. '**/' casa cero o más segmentos (incluida la
// raíz), '**' suelto casa cualquier cosa, '*' no cruza '/'.
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
                else { re += '.*'; i += 1; }
            } else { re += '[^/]*'; }
        } else if (c === '?') { re += '.'; }
        else if ('.+^${}()|[]\\'.includes(c)) { re += '\\' + c; }
        else { re += c; }
    }
    return new RegExp('^' + re + '$');
}

/**
 * Construye el toolset por defecto, confinado a `root`.
 * @param {object} o
 * @param {string} o.root                 Carpeta permitida (raíz del veto).
 * @param {Function} [o.sqlRunner]        async (sql) => rows  (SOLO lectura). Sin él, sql_query se desactiva.
 * @param {boolean}  [o.readOnly=true]    Si false, añade write_file (confinado a root).
 */
function buildDefaultTools({ root, sqlRunner, readOnly = true } = {}) {
    if (!root) throw new Error('buildDefaultTools: falta root');
    const defs = [];
    const handlers = {};

    defs.push({ name: 'read_file', description: 'Lee un fichero de texto (ruta relativa a la carpeta del módulo).',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } });
    handlers.read_file = async ({ path: p }) => {
        const abs = resolveWithin(root, p);
        const buf = await fsp.readFile(abs, 'utf8');
        return buf.length > 60000 ? buf.slice(0, 60000) + '\n…(truncado)' : buf;
    };

    defs.push({ name: 'glob', description: 'Lista ficheros que casan con un patrón glob (p.ej. **/*.js).',
        parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } });
    handlers.glob = async ({ pattern }) => {
        const all = []; await walk(root, root, all);
        const re = globToRegExp(pattern);
        const hits = all.filter(f => re.test(f)).slice(0, 500);
        return hits.length ? hits.join('\n') : '(sin coincidencias)';
    };

    defs.push({ name: 'grep', description: 'Busca un texto/regex en los ficheros del módulo. Devuelve fichero:línea:texto.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, glob: { type: 'string' } }, required: ['query'] } });
    handlers.grep = async ({ query, glob }) => {
        const all = []; await walk(root, root, all);
        const gre = glob ? globToRegExp(glob) : null;
        let re; try { re = new RegExp(query); } catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
        const out = [];
        for (const f of all) {
            if (gre && !gre.test(f)) continue;
            let text; try { text = await fsp.readFile(path.join(root, f), 'utf8'); } catch { continue; }
            text.split('\n').forEach((line, i) => { if (re.test(line) && out.length < 200) out.push(`${f}:${i + 1}:${line.trim().slice(0, 200)}`); });
            if (out.length >= 200) break;
        }
        return out.length ? out.join('\n') : '(sin coincidencias)';
    };

    if (typeof sqlRunner === 'function') {
        defs.push({ name: 'sql_query', description: 'Ejecuta una consulta SQL de SOLO LECTURA (SELECT/SHOW/DESCRIBE) y devuelve las filas.',
            parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } });
        handlers.sql_query = async ({ sql }) => {
            if (!/^\s*(select|show|describe|desc|explain)\b/i.test(sql)) throw new Error('solo se permiten consultas de lectura');
            const rows = await sqlRunner(sql);
            return JSON.stringify(rows, null, 2).slice(0, 40000);
        };
    }

    if (!readOnly) {
        defs.push({ name: 'write_file', description: 'Escribe/crea un fichero (SOLO dentro de la carpeta del módulo).',
            parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } });
        handlers.write_file = async ({ path: p, content }) => {
            // Robustez: si el contenido no llegó (p.ej. tool_use truncado por max_tokens),
            // devolvemos un error legible para que el modelo REINTENTE, en vez de reventar.
            if (typeof content !== 'string') {
                throw new Error('falta el parámetro "content" (texto del fichero). Vuelve a llamar a write_file con el contenido COMPLETO; si es muy largo, escríbelo por partes.');
            }
            const abs = resolveWithin(root, p);       // ← veto del guardián, agnóstico de la IA
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, content, 'utf8');
            return `escrito ${path.relative(root, abs)} (${content.length} bytes)`;
        };
    }

    return { defs, handlers };
}

module.exports = { buildDefaultTools, isInside, resolveWithin, globToRegExp, _walk: walk };
