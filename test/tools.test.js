"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { buildDefaultTools, resolveWithin, globToRegExp } = require('../llm/tools');

async function tmpModule() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'llmtools-'));
    await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'a.js'), 'const foo = 1;\nfunction bar() {}\n');
    await fsp.writeFile(path.join(dir, 'sub', 'b.js'), 'const baz = 2; // BUSCAME\n');
    await fsp.writeFile(path.join(dir, 'readme.md'), '# hola\n');
    return dir;
}

test('tools — confinamiento y herramientas de lectura', async (t) => {
    const root = await tmpModule();

    await t.test('resolveWithin veta rutas fuera de root (guardián)', () => {
        assert.throws(() => resolveWithin(root, '../../etc/passwd'), /fuera de la carpeta/);
        assert.throws(() => resolveWithin(root, '/etc/passwd'), /fuera de la carpeta/);
        assert.ok(resolveWithin(root, 'a.js').endsWith('a.js'));
    });

    await t.test('globToRegExp', () => {
        assert.ok(globToRegExp('**/*.js').test('sub/b.js'));
        assert.ok(globToRegExp('*.js').test('a.js'));
        assert.ok(!globToRegExp('*.js').test('sub/b.js'));
    });

    await t.test('read_file / glob / grep', async () => {
        const { handlers } = buildDefaultTools({ root, readOnly: true });
        assert.match(await handlers.read_file({ path: 'a.js' }), /function bar/);
        const globbed = await handlers.glob({ pattern: '**/*.js' });
        assert.match(globbed, /a\.js/);
        assert.match(globbed, /sub\/b\.js/);
        const grepped = await handlers.grep({ query: 'BUSCAME' });
        assert.match(grepped, /sub\/b\.js:1:/);
    });

    await t.test('read_file veta rutas ajenas', async () => {
        const { handlers } = buildDefaultTools({ root, readOnly: true });
        await assert.rejects(() => handlers.read_file({ path: '../secret' }), /fuera de la carpeta/);
    });

    await t.test('sql_query solo lectura, con runner inyectado', async () => {
        const { handlers } = buildDefaultTools({ root, sqlRunner: async (sql) => [{ n: 1, sql }] });
        const out = await handlers.sql_query({ sql: 'SELECT 1' });
        assert.match(out, /"n": 1/);
        await assert.rejects(() => handlers.sql_query({ sql: 'DELETE FROM x' }), /solo se permiten/);
    });

    await t.test('write_file confinado a root (opt-in readOnly:false)', async () => {
        const { handlers, defs } = buildDefaultTools({ root, readOnly: false });
        assert.ok(defs.find(d => d.name === 'write_file'));
        await handlers.write_file({ path: 'nuevo.txt', content: 'hola' });
        assert.strictEqual(fs.readFileSync(path.join(root, 'nuevo.txt'), 'utf8'), 'hola');
        await assert.rejects(() => handlers.write_file({ path: '../fuera.txt', content: 'x' }), /fuera de la carpeta/);
    });

    await t.test('readOnly:true NO ofrece write_file', () => {
        const { defs } = buildDefaultTools({ root, readOnly: true });
        assert.ok(!defs.find(d => d.name === 'write_file'));
    });
});
