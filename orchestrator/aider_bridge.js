"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Bridge Node ↔ aider_agent/runner.py                                      ║
// ║                                                                            ║
// ║  Lanza el runner de Aider (Python) como subproceso y lee sus EVENTOS por   ║
// ║  un canal DEDICADO (fd 3, NDJSON) — no por stdout, así el ruido de Aider   ║
// ║  no contamina. stdin queda abierto para RESPONDER dudas al agente.         ║
// ║  Mismo patrón con el que el assistant ya lanza `claude`/`git`/`mysql`.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const AGENT_DIR = path.join(__dirname, '..', 'aider_agent');
const VENV_PY = process.env.AIDER_PYTHON || path.join(AGENT_DIR, '.venv', 'bin', 'python');
const RUNNER = path.join(AGENT_DIR, 'runner.py');

/**
 * Lanza un agente Aider sobre un módulo. Devuelve {code, events, done, stderr}.
 * @param {object} o
 * @param {string}   o.moduleDir   Carpeta del módulo (repo git).
 * @param {string}   [o.model]     Modelo LiteLLM (haiku|sonnet|gpt-4o|ollama/...).
 * @param {string}   o.brief       Encargo.
 * @param {string[]} [o.files]     Ficheros editables (relativos al módulo).
 * @param {object}   [o.env]       Env extra para el hijo (p.ej. ANTHROPIC_API_KEY).
 * @param {Function} [o.onEvent]   (event, child) => void — child para responder dudas por stdin.
 */
function launchAiderAgent({ moduleDir, model = 'haiku', brief, files = [], env = {}, onEvent }) {
    return new Promise((resolve, reject) => {
        const args = [RUNNER, '--module-dir', moduleDir, '--model', model, '--brief', brief];
        for (const f of files) args.push('--file', f);
        // stdio: [stdin(pipe, para responder dudas), stdout(ignore=ruido Aider),
        //         stderr(pipe, para errores), fd3(pipe, EVENTOS)]
        const child = spawn(VENV_PY, args, {
            stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
            env: { ...process.env, AIDER_ANALYTICS: 'false', ...env },
        });
        const events = [];
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        const rl = readline.createInterface({ input: child.stdio[3] });
        rl.on('line', (line) => {
            line = line.trim();
            if (!line) return;
            let ev;
            try { ev = JSON.parse(line); } catch { return; }   // ignora ruido no-JSON
            events.push(ev);
            if (onEvent) { try { onEvent(ev, child); } catch (e) { /* no tumbar el bridge */ } }
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code, events, done: events.find((e) => e.event === 'done') || null, stderr });
        });
    });
}

// Responde una duda del agente escribiendo por su stdin (una línea).
function answer(child, text) {
    try { child.stdin.write(String(text).replace(/[\r\n]+/g, ' ') + '\n'); } catch (e) { /* */ }
}

module.exports = { launchAiderAgent, answer };
