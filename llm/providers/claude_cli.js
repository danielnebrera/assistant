"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ClaudeCliProvider — SHIM TRANSICIONAL sobre el binario `claude -p`.        ║
// ║                                                                            ║
// ║  ⚠️ Dependencia GRUESA (no fina): el CLI hace su PROPIO bucle agéntico y    ║
// ║  sus propias herramientas por dentro, así que este provider NO expone      ║
// ║  tool_calls al bucle propio (llm/loop.js) — cada step() devuelve texto y   ║
// ║  termina. Sirve para (a) arrancar HOY sin claves de API (usa la auth que   ║
// ║  ya tiene el `claude` instalado) y (b) comparar el camino nuevo contra el  ║
// ║  viejo. El objetivo final es sustituirlo por AnthropicProvider (llamada    ║
// ║  fina) + llm/loop.js (bucle propio). Úsalo con maxSteps=1.                 ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { execFile } = require('child_process');
const { LLMProvider, normalizeRequest, makeResult, textOf } = require('../provider');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const HOME_DIR = process.env.CLAUDE_HOME || '/home/ubuntu';
const WORK_DIR = process.env.CLAUDE_WORK_DIR || process.cwd();

/** Aplana el historial normalizado a un único prompt de texto para `claude -p`. */
function flatten(system, messages) {
    const parts = [];
    if (system) parts.push(system);
    for (const m of messages) {
        const label = m.role === 'assistant' ? 'ASISTENTE' : m.role === 'tool' ? 'RESULTADO_HERRAMIENTA' : 'USUARIO';
        const txt = m.content.map(b => {
            if (b.type === 'text') return b.text;
            if (b.type === 'tool_use') return `[usa ${b.name}(${JSON.stringify(b.input)})]`;
            if (b.type === 'tool_result') return String(b.content);
            return '';
        }).filter(Boolean).join('\n');
        if (txt) parts.push(`${label}: ${txt}`);
    }
    return parts.join('\n\n');
}

class ClaudeCliProvider extends LLMProvider {
    constructor(opts = {}) {
        super(opts);
        this.name = 'claude_cli';
        this.model = opts.model || process.env.ESTRATEGA_MODEL || 'sonnet';
        this.allowedTools = opts.allowedTools || ['Read', 'Grep', 'Glob'];
        this.timeoutMs = opts.timeoutMs || Number(process.env.ESTRATEGA_TIMEOUT_MS) || 300000;
        this.cwd = opts.cwd || WORK_DIR;
    }
    async step(req) {
        const n = normalizeRequest(req);
        const prompt = flatten(n.system, n.messages);
        const args = ['-p', '--output-format', 'json', '--model', this.model];
        if (this.allowedTools.length) args.push('--allowed-tools', ...this.allowedTools);
        const out = await new Promise((resolve, reject) => {
            const child = execFile(CLAUDE_BIN, args, {
                cwd: this.cwd, env: { ...process.env, HOME: HOME_DIR },
                timeout: this.timeoutMs, maxBuffer: 16 * 1024 * 1024,
            }, (err, stdout, stderr) => {
                if (err && !stdout) return reject(new Error(err.killed ? 'claude: timeout' : `claude: ${stderr || err.message}`));
                try {
                    const env = JSON.parse(stdout);
                    if (env.is_error) return reject(new Error(env.result || 'error del modelo'));
                    resolve(String(env.result || ''));
                } catch (e) { reject(new Error('claude: respuesta no parseable: ' + e.message)); }
            });
            child.stdin.write(prompt); child.stdin.end();
        });
        return makeResult({ text: out, toolCalls: [], stopReason: 'end', model: `claude_cli:${this.model}` });
    }
}

module.exports = { ClaudeCliProvider, flatten };
