"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  AnthropicProvider — adaptador a la Messages API de Anthropic.             ║
// ║                                                                            ║
// ║  Traduce el formato NORMALIZADO (tuyo) ↔ el JSON de Anthropic. Es LA parte ║
// ║  propietaria, y queda encapsulada aquí: el resto del sistema no la ve.     ║
// ║  El mapeo va en funciones PURAS (toAnthropicRequest / fromAnthropicResponse)║
// ║  para poder testearlo sin red.                                             ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { LLMProvider, normalizeRequest, makeResult } = require('../provider');
const { postJson } = require('../http');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'claude-sonnet-4-6';

function mapBlock(b) {
    if (b.type === 'text') return { type: 'text', text: b.text };
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, content: String(b.content), is_error: !!b.isError };
    throw new Error(`bloque no soportado: ${b.type}`);
}

/** NormRequest → cuerpo JSON de Anthropic (función pura). */
function toAnthropicRequest(req) {
    const n = normalizeRequest(req);
    const messages = n.messages.map(m => ({
        // Anthropic mete los tool_result en un turno de rol 'user'.
        role: m.role === 'tool' ? 'user' : m.role,
        content: m.content.map(mapBlock),
    }));
    const body = { model: n.model || DEFAULT_MODEL, max_tokens: n.maxTokens, messages };
    if (n.system) body.system = n.system;
    if (n.tools.length) body.tools = n.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (typeof n.temperature === 'number') body.temperature = n.temperature;
    return body;
}

const STOP_MAP = { end_turn: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens' };

/** Respuesta cruda de Anthropic → NormResult (función pura). */
function fromAnthropicResponse(raw) {
    const content = Array.isArray(raw.content) ? raw.content : [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} }));
    return makeResult({
        text, toolCalls,
        stopReason: STOP_MAP[raw.stop_reason] || 'other',
        usage: { inputTokens: raw.usage && raw.usage.input_tokens, outputTokens: raw.usage && raw.usage.output_tokens },
        model: raw.model, raw,
    });
}

class AnthropicProvider extends LLMProvider {
    constructor(opts = {}) {
        super(opts);
        this.name = 'anthropic';
        this.apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || process.env.LLM_ANTHROPIC_KEY;
        this.model = opts.model || DEFAULT_MODEL;
    }
    async step(req) {
        if (!this.apiKey) throw new Error('AnthropicProvider: falta ANTHROPIC_API_KEY');
        const body = toAnthropicRequest({ model: this.model, ...req });
        const raw = await postJson(API_URL, {
            headers: { 'x-api-key': this.apiKey, 'anthropic-version': API_VERSION },
            body,
        });
        return fromAnthropicResponse(raw);
    }
}

module.exports = { AnthropicProvider, toAnthropicRequest, fromAnthropicResponse };
