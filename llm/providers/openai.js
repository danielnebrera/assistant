"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  OpenAIProvider — adaptador a la Chat Completions API de OpenAI.           ║
// ║                                                                            ║
// ║  Demuestra que el resto del sistema NO cambia al cambiar de IA: solo se    ║
// ║  reescribe este mapeo. Las diferencias de formato (p.ej. Anthropic agrupa  ║
// ║  los tool_result en un turno; OpenAI los quiere como N mensajes 'tool')    ║
// ║  se absorben AQUÍ, no se filtran al bucle. Mapeo en funciones puras.       ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { LLMProvider, normalizeRequest, makeResult, textOf } = require('../provider');
const { postJson } = require('../http');

const API_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = process.env.LLM_OPENAI_MODEL || 'gpt-4o';

/** NormRequest → cuerpo JSON de OpenAI (función pura). */
function toOpenAIRequest(req) {
    const n = normalizeRequest(req);
    const messages = [];
    if (n.system) messages.push({ role: 'system', content: n.system });
    for (const m of n.messages) {
        if (m.role === 'tool') {
            // FAN-OUT: un mensaje normalizado 'tool' con N resultados → N mensajes 'tool'.
            for (const b of m.content) {
                if (b.type !== 'tool_result') continue;
                messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
            }
            continue;
        }
        if (m.role === 'assistant') {
            const toolUses = m.content.filter(b => b.type === 'tool_use');
            const msg = { role: 'assistant', content: textOf(m.content) || null };
            if (toolUses.length) {
                msg.tool_calls = toolUses.map(b => ({
                    id: b.id, type: 'function',
                    function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
                }));
            }
            messages.push(msg);
            continue;
        }
        messages.push({ role: 'user', content: textOf(m.content) });
    }
    const body = { model: n.model || DEFAULT_MODEL, messages, max_tokens: n.maxTokens };
    if (n.tools.length) body.tools = n.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (typeof n.temperature === 'number') body.temperature = n.temperature;
    return body;
}

const FINISH_MAP = { stop: 'end', tool_calls: 'tool_use', length: 'max_tokens', function_call: 'tool_use' };

/** Respuesta cruda de OpenAI → NormResult (función pura). */
function fromOpenAIResponse(raw) {
    const choice = (raw.choices && raw.choices[0]) || {};
    const msg = choice.message || {};
    const toolCalls = (msg.tool_calls || []).map(tc => {
        let input = {};
        try { input = tc.function && tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch (e) { input = { _raw: tc.function.arguments }; }
        return { id: tc.id, name: tc.function && tc.function.name, input };
    });
    return makeResult({
        text: msg.content || '',
        toolCalls,
        stopReason: FINISH_MAP[choice.finish_reason] || 'other',
        usage: { inputTokens: raw.usage && raw.usage.prompt_tokens, outputTokens: raw.usage && raw.usage.completion_tokens },
        model: raw.model, raw,
    });
}

class OpenAIProvider extends LLMProvider {
    constructor(opts = {}) {
        super(opts);
        this.name = 'openai';
        this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || process.env.LLM_OPENAI_KEY;
        this.model = opts.model || DEFAULT_MODEL;
        this.baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || API_URL;
    }
    async step(req) {
        if (!this.apiKey) throw new Error('OpenAIProvider: falta OPENAI_API_KEY');
        const body = toOpenAIRequest({ model: this.model, ...req });
        const raw = await postJson(this.baseUrl, {
            headers: { authorization: `Bearer ${this.apiKey}` },
            body,
        });
        return fromOpenAIResponse(raw);
    }
}

module.exports = { OpenAIProvider, toOpenAIRequest, fromOpenAIResponse };
