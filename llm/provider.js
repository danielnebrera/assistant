"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  LLMProvider — la FRONTERA provider-agnóstica.                            ║
// ║                                                                            ║
// ║  Aquí vive lo ÚNICO específico de cada proveedor: "la llamada de           ║
// ║  inferencia" (dado un contexto + herramientas, devuelve el siguiente       ║
// ║  mensaje). Es una función SIN ESTADO: se le pasa el historial COMPLETO y   ║
// ║  devuelve un único paso. El bucle agéntico, las herramientas, el guardián  ║
// ║  y la comunicación entre agentes viven FUERA de esta interfaz (son tuyos   ║
// ║  y agnósticos) — ver llm/loop.js.                                          ║
// ║                                                                            ║
// ║  Cada proveedor (Anthropic, OpenAI, un modelo local, el CLI de Claude…)    ║
// ║  implementa `step()`. Cambiar de IA = cambiar de adaptador, no reescribir. ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/**
 * FORMATO NORMALIZADO (el contrato portable, TUYO — no de ningún proveedor)
 *
 * Bloque de contenido (NormBlock):
 *   { type: 'text',        text }
 *   { type: 'tool_use',    id, name, input }              // lo EMITE el assistant
 *   { type: 'tool_result', tool_use_id, content, isError? } // lo emite el rol 'tool'
 *
 * Mensaje (NormMessage):
 *   { role: 'user' | 'assistant' | 'tool', content: string | NormBlock[] }
 *   (un string es azúcar para [{ type:'text', text: <string> }])
 *
 * Herramienta (NormTool):
 *   { name, description, parameters }   // parameters = JSON Schema del input
 *
 * Petición a step() (NormRequest):
 *   { system?, messages: NormMessage[], tools?: NormTool[], model?, maxTokens?, temperature? }
 *
 * Respuesta de step() (NormResult):
 *   { text, toolCalls: [{ id, name, input }], stopReason, usage: {inputTokens, outputTokens}, model, raw }
 *   stopReason ∈ 'end' | 'tool_use' | 'max_tokens' | 'other'
 */

// ── Normalizadores (usados por los adaptadores para no repetir lógica) ──────

/** Convierte content (string | NormBlock[]) a NormBlock[] siempre. */
function toBlocks(content) {
    if (content == null) return [];
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (Array.isArray(content)) return content;
    throw new Error('content debe ser string o array de bloques');
}

/** Extrae el texto plano concatenado de una lista de bloques. */
function textOf(blocks) {
    return toBlocks(blocks).filter(b => b.type === 'text').map(b => b.text).join('');
}

/** Valida (barato) una NormRequest y devuelve una copia normalizada. */
function normalizeRequest(req) {
    if (!req || !Array.isArray(req.messages)) throw new Error('NormRequest.messages debe ser un array');
    const messages = req.messages.map((m, i) => {
        if (!m || !m.role) throw new Error(`mensaje ${i} sin role`);
        if (!['user', 'assistant', 'tool'].includes(m.role)) throw new Error(`role inválido: ${m.role}`);
        return { role: m.role, content: toBlocks(m.content) };
    });
    const tools = Array.isArray(req.tools) ? req.tools.map(t => {
        if (!t || !t.name) throw new Error('tool sin name');
        return { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } };
    }) : [];
    return {
        system: req.system || '',
        messages,
        tools,
        model: req.model || null,
        maxTokens: req.maxTokens || 4096,
        temperature: req.temperature,
    };
}

/** Construye una NormResult a partir de sus piezas (para los adaptadores). */
function makeResult({ text = '', toolCalls = [], stopReason = 'end', usage = {}, model = null, raw = null }) {
    return {
        text,
        toolCalls,
        stopReason,
        usage: { inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0 },
        model,
        raw,
    };
}

// ── Clase base (contrato) ───────────────────────────────────────────────────
class LLMProvider {
    constructor(opts = {}) { this.opts = opts; this.name = 'base'; }

    /**
     * LA LLAMADA DE INFERENCIA. Sin estado: recibe el contexto completo,
     * devuelve UN paso (texto y/o peticiones de herramienta).
     * @param {NormRequest} req
     * @returns {Promise<NormResult>}
     */
    async step(req) { // eslint-disable-line no-unused-vars
        throw new Error(`${this.name}: step() no implementado`);
    }
}

module.exports = { LLMProvider, toBlocks, textOf, normalizeRequest, makeResult };
