"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  runAgent — EL BUCLE AGÉNTICO (tuyo y agnóstico).                          ║
// ║                                                                            ║
// ║  Una llamada de inferencia sola no HACE nada: solo emite texto o PIDE usar ║
// ║  una herramienta. El "agente" es este bucle alrededor de la llamada:       ║
// ║                                                                            ║
// ║     provider.step() → ¿tool_use? → ejecutar tool (tu código) → repetir     ║
// ║                                                                            ║
// ║  El bucle, las herramientas y el veto (guardián) NO dependen de ningún     ║
// ║  proveedor. Antes esto lo hacía el binario `claude` por dentro; ahora es   ║
// ║  tuyo, así que puedes enchufar cualquier LLMProvider.                      ║
// ║                                                                            ║
// ║  Emite EVENTOS (onEvent) para supervisión/streaming DIRIGIDOS POR EVENTOS  ║
// ║  — no por sondeo. Ese es el punto de enganche del Estratega supervisor.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { toBlocks, textOf } = require('./provider');

const noop = () => {};

/**
 * Ejecuta el bucle agéntico contra un LLMProvider.
 *
 * @param {object}   o
 * @param {LLMProvider} o.provider
 * @param {string}   [o.system]
 * @param {NormMessage[]} o.messages     Historial inicial (se muta una copia).
 * @param {NormTool[]}    [o.tools]      Definiciones de herramientas ofrecidas.
 * @param {Object<string,Function>} [o.handlers]  name → async (input, ctx) => string
 * @param {number}   [o.maxSteps=12]     Tope de vueltas (evita bucles infinitos).
 * @param {string}   [o.model]
 * @param {number}   [o.maxTokens]
 * @param {Function} [o.onEvent]         (evento) => void  — dirigido por eventos.
 * @param {object}   [o.ctx]             Contexto opaco que se pasa a los handlers.
 * @returns {Promise<{messages, text, steps, stoppedBy, usage}>}
 */
async function runAgent(o) {
    const {
        provider, system = '', tools = [], handlers = {},
        maxSteps = 12, model, maxTokens, onEvent = noop, ctx = {}, signal,
    } = o;
    const messages = (o.messages || []).map(m => ({ role: m.role, content: toBlocks(m.content) }));
    const usage = { inputTokens: 0, outputTokens: 0 };
    let steps = 0;

    while (steps < maxSteps) {
        // Cancelación cooperativa: entre pasos comprobamos el AbortSignal. Es lo que
        // permite parar/matar un agente in-process sin tmux (parar entre llamadas).
        if (signal && signal.aborted) {
            onEvent({ type: 'aborted', step: steps });
            const lastA = [...messages].reverse().find(m => m.role === 'assistant');
            return { messages, text: lastA ? textOf(lastA.content) : '', steps, stoppedBy: 'aborted', usage };
        }
        steps++;
        onEvent({ type: 'step_start', step: steps });

        const res = await provider.step({ system, messages, tools, model, maxTokens });
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;

        // Reconstruye el mensaje del assistant en formato normalizado y apílalo.
        const assistantBlocks = [];
        if (res.text) assistantBlocks.push({ type: 'text', text: res.text });
        for (const tc of res.toolCalls) assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        messages.push({ role: 'assistant', content: assistantBlocks });
        onEvent({ type: 'assistant_message', step: steps, text: res.text, toolCalls: res.toolCalls, stopReason: res.stopReason });

        if (!res.toolCalls.length) {
            onEvent({ type: 'done', step: steps, text: res.text });
            return { messages, text: res.text, steps, stoppedBy: 'end', usage };
        }

        // Ejecuta TODAS las tools de este turno y agrupa los resultados en UN
        // mensaje de rol 'tool' (el adaptador de cada proveedor lo mapea a lo suyo:
        // Anthropic = un user con N tool_result; OpenAI = N mensajes 'tool').
        const resultBlocks = [];
        for (const tc of res.toolCalls) {
            onEvent({ type: 'tool_call', step: steps, name: tc.name, input: tc.input, id: tc.id });
            let content, isError = false;
            try {
                const handler = handlers[tc.name];
                if (!handler) throw new Error(`herramienta desconocida: ${tc.name}`);
                content = String(await handler(tc.input || {}, ctx));
            } catch (e) {
                content = `ERROR: ${e.message}`;
                isError = true;
            }
            onEvent({ type: 'tool_result', step: steps, name: tc.name, id: tc.id, content, isError });
            resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content, isError });
        }
        messages.push({ role: 'tool', content: resultBlocks });
    }

    onEvent({ type: 'max_steps', step: steps });
    // Texto del último assistant, por si el llamante quiere algo aunque se agotara.
    const last = [...messages].reverse().find(m => m.role === 'assistant');
    return { messages, text: last ? textOf(last.content) : '', steps, stoppedBy: 'max_steps', usage };
}

module.exports = { runAgent };
