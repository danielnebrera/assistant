"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const { toBlocks, textOf, normalizeRequest, makeResult } = require('../llm/provider');
const { FakeProvider } = require('../llm/providers/fake');

test('provider — normalizadores y fake', async (t) => {
    await t.test('toBlocks: string → bloque de texto', () => {
        assert.deepStrictEqual(toBlocks('hola'), [{ type: 'text', text: 'hola' }]);
        assert.deepStrictEqual(toBlocks(''), []);
        assert.deepStrictEqual(toBlocks([{ type: 'text', text: 'x' }]), [{ type: 'text', text: 'x' }]);
    });

    await t.test('textOf concatena solo texto', () => {
        assert.strictEqual(textOf([{ type: 'text', text: 'a' }, { type: 'tool_use', id: '1', name: 'f', input: {} }, { type: 'text', text: 'b' }]), 'ab');
    });

    await t.test('normalizeRequest valida roles y normaliza content', () => {
        const n = normalizeRequest({ messages: [{ role: 'user', content: 'hola' }], tools: [{ name: 'f' }] });
        assert.deepStrictEqual(n.messages[0].content, [{ type: 'text', text: 'hola' }]);
        assert.strictEqual(n.tools[0].name, 'f');
        assert.ok(n.tools[0].parameters);
        assert.strictEqual(n.maxTokens, 4096);
    });

    await t.test('normalizeRequest rechaza role inválido y falta de messages', () => {
        assert.throws(() => normalizeRequest({ messages: [{ role: 'robot', content: 'x' }] }), /role inválido/);
        assert.throws(() => normalizeRequest({}), /messages/);
    });

    await t.test('makeResult rellena usage', () => {
        const r = makeResult({ text: 'x' });
        assert.deepStrictEqual(r.usage, { inputTokens: 0, outputTokens: 0 });
        assert.strictEqual(r.stopReason, 'end');
    });

    await t.test('FakeProvider: script de strings y registro de llamadas', async () => {
        const p = new FakeProvider(['uno', 'dos']);
        const r1 = await p.step({ messages: [{ role: 'user', content: 'a' }] });
        const r2 = await p.step({ messages: [{ role: 'user', content: 'b' }] });
        assert.strictEqual(r1.text, 'uno');
        assert.strictEqual(r2.text, 'dos');
        assert.strictEqual(p.calls.length, 2);
        assert.strictEqual(p.calls[0].messages[0].content[0].text, 'a');
    });

    await t.test('FakeProvider: función y toolCalls', async () => {
        const p = new FakeProvider((req, i) => i === 0 ? { toolCalls: [{ id: 't1', name: 'f', input: { x: 1 } }] } : 'fin');
        const r1 = await p.step({ messages: [{ role: 'user', content: 'go' }] });
        assert.strictEqual(r1.stopReason, 'tool_use');
        assert.strictEqual(r1.toolCalls[0].name, 'f');
        const r2 = await p.step({ messages: [{ role: 'user', content: 'go' }] });
        assert.strictEqual(r2.text, 'fin');
    });
});
