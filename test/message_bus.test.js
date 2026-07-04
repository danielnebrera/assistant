"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const { createMessageBus, rowToMessage } = require('../orchestrator/message_bus');

// query falso que registra las llamadas y devuelve filas programables.
function fakeQuery(responder) {
    const calls = [];
    const q = async (sql, params) => { calls.push({ sql, params }); return responder(sql, params); };
    q.calls = calls;
    return q;
}
const t = (name) => name; // BD propia: sin prefijo

test('message_bus — bus propio de comunicación entre agentes', async (tt) => {
    await tt.test('rowToMessage deserializa el payload JSON', () => {
        const m = rowToMessage({ id: 1, task_id: 9, sender: 'estratega', recipient: 'agent:admin', kind: 'instruction', payload: '{"text":"haz X"}', status: 'pending' });
        assert.deepStrictEqual(m.payload, { text: 'haz X' });
        assert.strictEqual(m.taskId, 9);
    });

    await tt.test('rowToMessage tolera payload no-JSON', () => {
        const m = rowToMessage({ id: 1, task_id: 9, sender: 'x', recipient: 'y', kind: 'note', payload: 'texto plano', status: 'pending' });
        assert.strictEqual(m.payload, 'texto plano');
    });

    await tt.test('post inserta con los parámetros correctos y devuelve id', async () => {
        const q = fakeQuery((sql) => sql.startsWith('INSERT') ? { insertId: 42 } : []);
        const bus = createMessageBus({ query: q, t });
        const r = await bus.post({ taskId: 7, sender: 'estratega', recipient: 'agent:admin', kind: 'instruction', payload: { text: 'haz X' } });
        assert.strictEqual(r.id, 42);
        assert.match(q.calls[0].sql, /INSERT INTO assistant_message/);
        assert.deepStrictEqual(q.calls[0].params, [7, 'estratega', 'agent:admin', 'instruction', '{"text":"haz X"}']);
    });

    await tt.test('post rechaza kind inválido y falta de taskId', async () => {
        const bus = createMessageBus({ query: fakeQuery(() => ({})), t });
        await assert.rejects(() => bus.post({ taskId: 1, sender: 'x', recipient: 'y', kind: 'bogus' }), /kind inválido/);
        await assert.rejects(() => bus.post({ sender: 'x', recipient: 'y', kind: 'note' }), /taskId/);
    });

    await tt.test('pending filtra por destinatario y mapea filas', async () => {
        const q = fakeQuery((sql) => sql.startsWith('SELECT')
            ? [{ id: 3, task_id: 7, sender: 'agent:admin', recipient: 'estratega', kind: 'result', payload: '{"summary":"hecho"}', status: 'pending' }]
            : {});
        const bus = createMessageBus({ query: q, t });
        const msgs = await bus.pending('estratega', 7);
        assert.strictEqual(msgs.length, 1);
        assert.deepStrictEqual(msgs[0].payload, { summary: 'hecho' });
        assert.match(q.calls[0].sql, /recipient=\? AND status='pending'/);
        assert.deepStrictEqual(q.calls[0].params, ['estratega', 7]);
    });

    await tt.test('markConsumed actualiza estado', async () => {
        const q = fakeQuery(() => ({ affectedRows: 1 }));
        const bus = createMessageBus({ query: q, t });
        await bus.markConsumed(3);
        assert.match(q.calls[0].sql, /SET status='consumed'/);
        assert.deepStrictEqual(q.calls[0].params, [3]);
    });

    await tt.test('createMessageBus exige query y t', () => {
        assert.throws(() => createMessageBus({}), /faltan/);
    });
});
