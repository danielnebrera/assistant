"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Registro de proveedores — elige la IA por CONFIGURACIÓN, no por código.   ║
// ║                                                                            ║
// ║  `LLM_PROVIDER` en el .env decide qué adaptador se usa. Cambiar de IA en   ║
// ║  el futuro = cambiar esa variable (y poner la clave), sin tocar el bucle,  ║
// ║  las tools, el guardián ni la comunicación entre agentes.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { AnthropicProvider } = require('./providers/anthropic');
const { OpenAIProvider } = require('./providers/openai');
const { ClaudeCliProvider } = require('./providers/claude_cli');
const { FakeProvider } = require('./providers/fake');

const FACTORIES = {
    anthropic: (o) => new AnthropicProvider(o),
    openai: (o) => new OpenAIProvider(o),
    claude_cli: (o) => new ClaudeCliProvider(o),   // transicional (usa el binario `claude`)
    fake: (o) => new FakeProvider(o.script || []),
};

/**
 * Devuelve un LLMProvider por nombre (o `LLM_PROVIDER` del entorno).
 * Por defecto `claude_cli`: arranca hoy sin claves, con la auth del `claude` local.
 */
function getProvider(nameOrOpts = {}) {
    const opts = typeof nameOrOpts === 'string' ? { provider: nameOrOpts } : nameOrOpts;
    const name = (opts.provider || process.env.LLM_PROVIDER || 'claude_cli').toLowerCase();
    const factory = FACTORIES[name];
    if (!factory) throw new Error(`LLM_PROVIDER desconocido: "${name}". Válidos: ${Object.keys(FACTORIES).join(', ')}`);
    return factory(opts);
}

module.exports = { getProvider, FACTORIES };
