"use strict";
// Demo OFFLINE de la capa provider-agnóstica: sin claves, sin BD, sin red.
// Ejecuta:  node examples/demo_offline.js
//
// Muestra: (1) el bucle propio ejecutando una herramienta y terminando,
//          (2) que el MISMO bucle/tools funcionan con "otra IA" (otro provider)
//          sin cambiar nada más — que es justo lo que te preocupaba.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { runAgent } = require('../llm/loop');
const { buildDefaultTools } = require('../llm/tools');
const { FakeProvider } = require('../llm/providers/fake');

async function main() {
    // Un "módulo" de juguete con un fichero, para que las tools tengan algo real.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-mod-'));
    fs.writeFileSync(path.join(root, 'service.js'), 'function cobrar() { /* TODO */ }\n');
    const { defs, handlers } = buildDefaultTools({ root, readOnly: true });

    // Dos "IAs" distintas (aquí simuladas con FakeProvider). En producción serían
    // AnthropicProvider / OpenAIProvider / un modelo local — el bucle NO cambia.
    const guionA = (req, i) => i === 0
        ? { toolCalls: [{ id: 't1', name: 'grep', input: { query: 'TODO' } }] }
        : 'IA-A: encontré 1 TODO en service.js';
    const guionB = (req, i) => i === 0
        ? { toolCalls: [{ id: 't1', name: 'glob', input: { pattern: '**/*.js' } }] }
        : 'IA-B: el módulo tiene 1 fichero .js';

    for (const [nombre, guion] of [['Proveedor A', guionA], ['Proveedor B', guionB]]) {
        console.log(`\n=== ${nombre} (mismo bucle, misma tabla de tools) ===`);
        const provider = new FakeProvider(guion);
        const r = await runAgent({
            provider,
            messages: [{ role: 'user', content: 'Revisa el módulo.' }],
            tools: defs, handlers,
            onEvent: (e) => {
                if (e.type === 'tool_call') console.log(`  → usa ${e.name}(${JSON.stringify(e.input)})`);
                if (e.type === 'tool_result') console.log(`  ← ${e.content.split('\n')[0]}`);
                if (e.type === 'done') console.log(`  ✓ ${e.text}`);
            },
        });
        console.log(`  [pasos: ${r.steps}, fin: ${r.stoppedBy}]`);
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log('\nLa única pieza propietaria fue la implementación de step() de cada provider.');
    console.log('El bucle, las tools, el veto y (en producción) el bus de mensajes son tuyos y agnósticos.');
}

main().catch(e => { console.error(e); process.exit(1); });
