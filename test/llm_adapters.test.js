"use strict";
const { test } = require('node:test');
const assert = require('node:assert');
const A = require('../llm/providers/anthropic');
const O = require('../llm/providers/openai');

// Petición normalizada con los tres tipos de mensaje + una tool.
const NORM = {
    system: 'eres útil',
    tools: [{ name: 'get', description: 'trae algo', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } }],
    messages: [
        { role: 'user', content: 'busca X' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'get', input: { q: 'X' } }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'RES', isError: false }] },
    ],
};

test('adaptador Anthropic — mapeo puro', async (t) => {
    await t.test('toAnthropicRequest', () => {
        const b = A.toAnthropicRequest(NORM);
        assert.strictEqual(b.system, 'eres útil');
        assert.strictEqual(b.messages.length, 3);
        assert.strictEqual(b.messages[0].role, 'user');
        assert.strictEqual(b.messages[1].content[1].type, 'tool_use');
        // El rol 'tool' se convierte en un turno 'user' con tool_result.
        assert.strictEqual(b.messages[2].role, 'user');
        assert.strictEqual(b.messages[2].content[0].type, 'tool_result');
        assert.strictEqual(b.messages[2].content[0].tool_use_id, 't1');
        // tools → input_schema
        assert.strictEqual(b.tools[0].input_schema.required[0], 'q');
    });

    await t.test('fromAnthropicResponse', () => {
        const r = A.fromAnthropicResponse({
            model: 'claude-x',
            content: [{ type: 'text', text: 'hola' }, { type: 'tool_use', id: 'u1', name: 'get', input: { q: 'Y' } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 7, output_tokens: 3 },
        });
        assert.strictEqual(r.text, 'hola');
        assert.strictEqual(r.toolCalls[0].name, 'get');
        assert.deepStrictEqual(r.toolCalls[0].input, { q: 'Y' });
        assert.strictEqual(r.stopReason, 'tool_use');
        assert.deepStrictEqual(r.usage, { inputTokens: 7, outputTokens: 3 });
    });
});

test('adaptador OpenAI — mapeo puro (absorbe las diferencias de formato)', async (t) => {
    await t.test('toOpenAIRequest: system prepend, tool_calls, y FAN-OUT de resultados', () => {
        // Un turno 'tool' con DOS resultados → DOS mensajes 'tool' en OpenAI.
        const norm = { ...NORM, messages: [
            NORM.messages[0], NORM.messages[1],
            { role: 'tool', content: [
                { type: 'tool_result', tool_use_id: 't1', content: 'A' },
                { type: 'tool_result', tool_use_id: 't2', content: 'B' },
            ] },
        ] };
        const b = O.toOpenAIRequest(norm);
        assert.strictEqual(b.messages[0].role, 'system');
        const assistant = b.messages.find(m => m.role === 'assistant');
        assert.strictEqual(assistant.tool_calls[0].function.name, 'get');
        assert.strictEqual(JSON.parse(assistant.tool_calls[0].function.arguments).q, 'X');
        const toolMsgs = b.messages.filter(m => m.role === 'tool');
        assert.strictEqual(toolMsgs.length, 2, 'fan-out: 2 resultados → 2 mensajes tool');
        assert.strictEqual(toolMsgs[0].tool_call_id, 't1');
        assert.strictEqual(b.tools[0].type, 'function');
    });

    await t.test('fromOpenAIResponse', () => {
        const r = O.fromOpenAIResponse({
            model: 'gpt-x',
            choices: [{ message: { content: 'hey', tool_calls: [{ id: 'c1', function: { name: 'get', arguments: '{"q":"Z"}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 9, completion_tokens: 2 },
        });
        assert.strictEqual(r.text, 'hey');
        assert.deepStrictEqual(r.toolCalls[0].input, { q: 'Z' });
        assert.strictEqual(r.stopReason, 'tool_use');
        assert.deepStrictEqual(r.usage, { inputTokens: 9, outputTokens: 2 });
    });
});

test('los dos adaptadores producen el MISMO resultado normalizado ante respuestas equivalentes', () => {
    const anth = A.fromAnthropicResponse({ content: [{ type: 'text', text: 'igual' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    const oai = O.fromOpenAIResponse({ choices: [{ message: { content: 'igual' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    assert.strictEqual(anth.text, oai.text);
    assert.strictEqual(anth.stopReason, oai.stopReason); // ambos → 'end'
});
