"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const { createLimiter } = require('../llm/limit');
const { runAgent } = require('../llm/loop');
const { FakeProvider } = require('../llm/providers/fake');

test('limit — cap de concurrencia', async (t) => {
    await t.test('nunca corre más de `max` a la vez, y completa todas en orden', async () => {
        const lim = createLimiter(2);
        let cur = 0, peak = 0;
        const mk = (v) => async () => { cur++; peak = Math.max(peak, cur); await new Promise(r => setTimeout(r, 10)); cur--; return v; };
        const results = await Promise.all([1, 2, 3, 4, 5].map(v => lim.run(mk(v))));
        assert.deepStrictEqual(results, [1, 2, 3, 4, 5]);
        assert.ok(peak <= 2, `peak ${peak} > 2`);
        assert.ok(peak >= 2, 'debería alcanzar el cap');
        assert.strictEqual(lim.active(), 0);
        assert.strictEqual(lim.pending(), 0);
    });

    await t.test('un fallo no bloquea la cola', async () => {
        const lim = createLimiter(1);
        await assert.rejects(() => lim.run(async () => { throw new Error('boom'); }));
        assert.strictEqual(await lim.run(async () => 'ok'), 'ok');   // la cola sigue viva
    });
});

test('loop — cancelación cooperativa (AbortSignal)', async (t) => {
    await t.test('signal ya abortado: no llama al modelo', async () => {
        const c = new AbortController(); c.abort();
        const provider = new FakeProvider(() => ({ toolCalls: [{ id: 't', name: 'x', input: {} }] }));
        const r = await runAgent({ provider, messages: [{ role: 'user', content: 'x' }], handlers: {}, signal: c.signal });
        assert.strictEqual(r.stoppedBy, 'aborted');
        assert.strictEqual(r.steps, 0);
        assert.strictEqual(provider.calls.length, 0);
    });

    await t.test('abort en mitad: para entre pasos', async () => {
        const c = new AbortController();
        const provider = new FakeProvider(() => ({ toolCalls: [{ id: 't', name: 'boom', input: {} }] }));
        const r = await runAgent({
            provider,
            messages: [{ role: 'user', content: 'x' }],
            handlers: { boom: async () => { c.abort(); return 'x'; } },   // aborta durante la ejecución de la tool
            signal: c.signal, maxSteps: 10,
        });
        assert.strictEqual(r.stoppedBy, 'aborted');
        assert.strictEqual(r.steps, 1);   // corrió 1 paso; el 2º vio el abort y paró
    });
});
