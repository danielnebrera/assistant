"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { runModuleAgent, buildAgentSystem } = require('../orchestrator/agent_runtime');
const { formatEvent } = require('../orchestrator/inproc_agents');
const { FakeProvider } = require('../llm/providers/fake');

test('agent_runtime — agente de módulo in-process (mi bucle + tools + escritura)', async (t) => {
    await t.test('escribe un fichero DE VERDAD vía el bucle, y publica el resultado en el bus', async () => {
        const moduleDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inproc-mod-'));
        await fsp.writeFile(path.join(moduleDir, 'existente.js'), '// hola\n');

        // "Modelo" (fake): 1º pide write_file, 2º resume. Ejercita el bucle completo.
        const provider = new FakeProvider((req, i) => i === 0
            ? { toolCalls: [{ id: 'w1', name: 'write_file', input: { path: 'nuevo.js', content: 'module.exports = 42;\n' } }] }
            : 'Resumen: creé nuevo.js con la constante 42.');

        const posted = [];
        const fakeBus = { post: async (m) => { posted.push(m); return { id: 1 }; } };

        const r = await runModuleAgent({
            provider, moduleName: 'demo', moduleDir, brief: 'crea nuevo.js',
            definition: 'módulo demo', readOnly: false, bus: fakeBus, taskId: 77,
        });

        // El fichero se escribió realmente dentro del módulo (por mi tool write_file).
        assert.strictEqual(fs.readFileSync(path.join(moduleDir, 'nuevo.js'), 'utf8'), 'module.exports = 42;\n');
        assert.match(r.summary, /Resumen: creé nuevo\.js/);
        assert.strictEqual(r.stoppedBy, 'end');
        // Resultado publicado en el bus (comunicación propia, no tmux/scraping).
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(posted[0].sender, 'agent:demo');
        assert.strictEqual(posted[0].recipient, 'estratega');
        assert.strictEqual(posted[0].kind, 'result');
        assert.match(posted[0].payload.summary, /nuevo\.js/);

        await fsp.rm(moduleDir, { recursive: true, force: true });
    });

    await t.test('el veto confina la escritura al módulo (no puede salir)', async () => {
        const moduleDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'inproc-mod-'));
        const provider = new FakeProvider((req, i) => i === 0
            ? { toolCalls: [{ id: 'w1', name: 'write_file', input: { path: '../fuera.js', content: 'x' } }] }
            : 'no pude escribir fuera');
        const r = await runModuleAgent({ provider, moduleName: 'demo', moduleDir, brief: 'x', readOnly: false });
        // El intento de salir devolvió un tool_result de error al modelo; el fichero NO existe.
        assert.ok(!fs.existsSync(path.join(path.dirname(moduleDir), 'fuera.js')));
        assert.strictEqual(r.stoppedBy, 'end');
        await fsp.rm(moduleDir, { recursive: true, force: true });
    });

    await t.test('buildAgentSystem incluye módulo, encargo y reglas', () => {
        const s = buildAgentSystem('admin', '/x/admin', 'objetivo', 'encargo', 'META');
        assert.match(s, /módulo «admin»/);
        assert.match(s, /encargo/);
        assert.match(s, /METODOLOGÍA COMÚN/);
        assert.match(s, /DENTRO de la carpeta del módulo/);
    });

    await t.test('formatEvent resume eventos del bucle en líneas legibles', () => {
        assert.match(formatEvent({ type: 'tool_call', name: 'grep', input: { q: 'x' } }), /→ grep/);
        assert.match(formatEvent({ type: 'done', text: 'listo' }), /✓ listo/);
        assert.strictEqual(formatEvent({ type: 'assistant_message', text: '' }), null);
    });
});
