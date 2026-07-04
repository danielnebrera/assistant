"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Turno del ESTRATEGA — versión provider-agnóstica de estratega.js.         ║
// ║                                                                            ║
// ║  Mapea 1:1 con estratega.respond(): mismo contrato de salida              ║
// ║  { reply, definition, ready, actions }. La diferencia: en vez de           ║
// ║  `execFile('claude', ['-p', ...])` (runtime propietario), usa un           ║
// ║  LLMProvider + el bucle propio (llm/loop.js) con herramientas de SOLO      ║
// ║  LECTURA. Cambiar de IA = cambiar el provider.                            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { runAgent } = require('../llm/loop');
const { buildDefaultTools } = require('../llm/tools');

// Extrae el primer objeto JSON del texto (el modelo a veces lo envuelve).
// Portado de estratega.js → parseReply, con el mismo contrato.
function parseStrategistJson(text) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try {
        const o = JSON.parse(s);
        return {
            reply: String(o.reply || '').trim(),
            definition: String(o.definition || '').trim(),
            ready: !!o.ready,
            actions: Array.isArray(o.actions) ? o.actions : [],
        };
    } catch (e) {
        return { reply: String(text || '').trim(), definition: '', ready: false, actions: [] };
    }
}

/**
 * Ejecuta un turno del Estratega con un LLMProvider.
 * @param {object} o
 * @param {LLMProvider} o.provider
 * @param {string}   o.system                 System prompt del Estratega (el de estratega.js).
 * @param {NormMessage[]} o.messages           Conversación + estado (como buildPrompt).
 * @param {string}   [o.workDir]               Raíz para las tools de lectura del proyecto.
 * @param {Function} [o.sqlRunner]             Runner SQL de solo lectura (opcional).
 * @param {number}   [o.maxSteps=6]
 * @param {Function} [o.onEvent]
 * @returns {Promise<{reply, definition, ready, actions, raw, usage, steps}>}
 */
async function runStrategistTurn(o) {
    const { provider, system, messages, workDir, sqlRunner, maxSteps = 6, onEvent } = o;
    // SOLO LECTURA: el Estratega consulta código/BD para fundamentar, no escribe.
    const { defs, handlers } = workDir
        ? buildDefaultTools({ root: workDir, sqlRunner, readOnly: true })
        : { defs: [], handlers: {} };
    const r = await runAgent({ provider, system, messages, tools: defs, handlers, maxSteps, onEvent });
    return { ...parseStrategistJson(r.text), raw: r.text, usage: r.usage, steps: r.steps };
}

module.exports = { runStrategistTurn, parseStrategistJson };
