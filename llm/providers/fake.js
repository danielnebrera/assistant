"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  FakeProvider — doble de test determinista (sin red, sin claves).          ║
// ║                                                                            ║
// ║  Le programas qué "contesta el modelo" en cada llamada (texto o peticiones ║
// ║  de herramienta) y registra las peticiones exactas que recibió, para poder ║
// ║  verificar el bucle, las tools y el intercambio de proveedor en tests.     ║
// ║  Mismo patrón que rocket/test/helpers/anthropic_stub.js.                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { LLMProvider, normalizeRequest, makeResult } = require('../provider');

class FakeProvider extends LLMProvider {
    /**
     * @param {Array|Function} script  Lista de "respuestas" consumidas en orden,
     *   o una función (req, callIndex) => respuesta. Cada respuesta es:
     *     - un string            → texto, stopReason 'end'
     *     - { text?, toolCalls?, stopReason?, usage? }
     */
    constructor(script = []) {
        super();
        this.name = 'fake';
        this.script = script;
        this.calls = [];        // peticiones recibidas (para inspección en tests)
        this._i = 0;
    }

    async step(req) {
        const norm = normalizeRequest(req);
        this.calls.push(norm);
        let r;
        if (typeof this.script === 'function') r = this.script(norm, this._i);
        else r = this.script[this._i];
        this._i++;
        if (r == null) r = { text: '', stopReason: 'end' };
        if (typeof r === 'string') r = { text: r, stopReason: 'end' };
        const toolCalls = r.toolCalls || [];
        const stopReason = r.stopReason || (toolCalls.length ? 'tool_use' : 'end');
        return makeResult({ text: r.text || '', toolCalls, stopReason, usage: r.usage || {}, model: 'fake', raw: r });
    }
}

module.exports = { FakeProvider };
