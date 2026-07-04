"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const { runStrategistTurn, parseStrategistJson } = require('../orchestrator/strategist');
const { FakeProvider } = require('../llm/providers/fake');

test('estratega — parseo y turno provider-agnóstico', async (t) => {
    await t.test('parseStrategistJson: JSON limpio', () => {
        const o = parseStrategistJson('{"reply":"hola","definition":"def","ready":true,"actions":[{"op":"lanzar"}]}');
        assert.strictEqual(o.reply, 'hola');
        assert.strictEqual(o.ready, true);
        assert.strictEqual(o.actions[0].op, 'lanzar');
    });

    await t.test('parseStrategistJson: envuelto en ```json', () => {
        const o = parseStrategistJson('claro:\n```json\n{"reply":"x","ready":false}\n```\n');
        assert.strictEqual(o.reply, 'x');
        assert.strictEqual(o.ready, false);
    });

    await t.test('parseStrategistJson: texto no-JSON → todo va a reply', () => {
        const o = parseStrategistJson('no es json');
        assert.strictEqual(o.reply, 'no es json');
        assert.deepStrictEqual(o.actions, []);
    });

    await t.test('runStrategistTurn con FakeProvider devuelve el contrato', async () => {
        const provider = new FakeProvider(['{"reply":"¿a qué módulo?","definition":"","ready":false,"actions":[]}']);
        const r = await runStrategistTurn({
            provider,
            system: 'Eres el Estratega.',
            messages: [{ role: 'user', content: 'quiero cuentas bancarias' }],
        });
        assert.strictEqual(r.reply, '¿a qué módulo?');
        assert.strictEqual(r.ready, false);
        assert.deepStrictEqual(r.actions, []);
        // El mismo turno funcionaría con AnthropicProvider u OpenAIProvider sin tocar esto.
    });

    await t.test('runStrategistTurn emite acción lanzar cuando el modelo lo decide', async () => {
        const provider = new FakeProvider(['{"reply":"","definition":"cuentas bancarias en contabilidad","ready":true,"actions":[{"op":"lanzar"}]}']);
        const r = await runStrategistTurn({ provider, system: 's', messages: [{ role: 'user', content: 'empieza' }] });
        assert.strictEqual(r.ready, true);
        assert.strictEqual(r.actions[0].op, 'lanzar');
    });
});
