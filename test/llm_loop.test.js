"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const { runAgent } = require('../llm/loop');
const { FakeProvider } = require('../llm/providers/fake');

test('loop — bucle agéntico (agnóstico del proveedor)', async (t) => {
    await t.test('ejecuta una tool y termina; el resultado vuelve al modelo', async () => {
        const provider = new FakeProvider((req, i) =>
            i === 0 ? { toolCalls: [{ id: 't1', name: 'echo', input: { v: 'hola' } }] } : 'terminado');
        const events = [];
        let received;
        const r = await runAgent({
            provider,
            messages: [{ role: 'user', content: 'usa echo' }],
            tools: [{ name: 'echo', description: 'x', parameters: {} }],
            handlers: { echo: async ({ v }) => { received = v; return `ECO:${v}`; } },
            onEvent: (e) => events.push(e.type),
        });
        assert.strictEqual(r.text, 'terminado');
        assert.strictEqual(r.steps, 2);
        assert.strictEqual(r.stoppedBy, 'end');
        assert.strictEqual(received, 'hola');
        // En la 2ª llamada, el modelo recibió el tool_result agrupado en un turno 'tool'.
        const toolMsg = provider.calls[1].messages.find(m => m.role === 'tool');
        assert.ok(toolMsg, 'debe haber un mensaje de rol tool');
        assert.strictEqual(toolMsg.content[0].type, 'tool_result');
        assert.strictEqual(toolMsg.content[0].content, 'ECO:hola');
        assert.deepStrictEqual([...new Set(events)].sort(), ['assistant_message', 'done', 'step_start', 'tool_call', 'tool_result'].sort());
    });

    await t.test('herramienta desconocida → tool_result con error, el bucle sigue', async () => {
        const provider = new FakeProvider((req, i) =>
            i === 0 ? { toolCalls: [{ id: 't1', name: 'no_existe', input: {} }] } : 'ok');
        const r = await runAgent({ provider, messages: [{ role: 'user', content: 'x' }], handlers: {} });
        const toolMsg = provider.calls[1].messages.find(m => m.role === 'tool');
        assert.ok(toolMsg.content[0].isError);
        assert.match(toolMsg.content[0].content, /desconocida/);
        assert.strictEqual(r.text, 'ok');
    });

    await t.test('respeta maxSteps (evita bucle infinito)', async () => {
        const provider = new FakeProvider(() => ({ toolCalls: [{ id: 't', name: 'echo', input: {} }] }));
        const r = await runAgent({ provider, messages: [{ role: 'user', content: 'x' }], handlers: { echo: async () => 'x' }, maxSteps: 3 });
        assert.strictEqual(r.stoppedBy, 'max_steps');
        assert.strictEqual(r.steps, 3);
    });

    await t.test('acumula usage', async () => {
        const provider = new FakeProvider([{ text: 'fin', usage: { inputTokens: 10, outputTokens: 4 } }]);
        const r = await runAgent({ provider, messages: [{ role: 'user', content: 'x' }] });
        assert.deepStrictEqual(r.usage, { inputTokens: 10, outputTokens: 4 });
    });
});
