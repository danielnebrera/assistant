"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Agente de MÓDULO — versión provider-agnóstica de agents.js (sin tmux).    ║
// ║                                                                            ║
// ║  Reemplaza launchModule()+tmux+acceptBypassIfPrompted()+capture-pane por   ║
// ║  el bucle propio (llm/loop.js) con herramientas confinadas a la carpeta    ║
// ║  del módulo (el VETO del guardián va en tools.js, agnóstico de la IA).     ║
// ║  El resultado se publica en el bus de mensajes (comunicación propia).      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const path = require('path');
const { runAgent } = require('../llm/loop');
const { buildDefaultTools } = require('../llm/tools');

// Prompt-semilla del agente (lenguaje técnico). Equivalente portable de
// agents.js → agentPrompt, sin la dependencia del CLI ni de tmux.
function buildAgentSystem(moduleName, moduleDir, definition, brief, methodology = '') {
    return `Eres el agente del módulo «${moduleName}» (${moduleDir}).

OBJETIVO DE NEGOCIO DE LA TAREA:
${definition || '(sin definir)'}

TU ENCARGO EN ESTE MÓDULO:
${brief || '(sin encargo)'}
${methodology ? '\n--- METODOLOGÍA COMÚN ---\n' + methodology + '\n' : ''}
REGLAS OBLIGATORIAS:
1. Solo puedes tocar ficheros DENTRO de la carpeta del módulo (el sistema lo veta a nivel de herramienta).
2. Para datos de otro módulo, usa su API/servicio; nunca edites ficheros ajenos.
3. Usa las herramientas (read_file, glob, grep, write_file) para investigar y aplicar el cambio.
4. Cuando termines, responde SOLO con un resumen de 3 líneas de lo que has cambiado (sin más herramientas).`;
}

/**
 * Ejecuta un agente de módulo con un LLMProvider (sin tmux).
 * @param {object} o
 * @param {LLMProvider} o.provider
 * @param {string}   o.moduleName
 * @param {string}   o.moduleDir        Carpeta del módulo (raíz del veto).
 * @param {string}   o.brief
 * @param {string}   [o.definition]
 * @param {string}   [o.methodology]    Metodología común incrustada (COMMON_MODULE_SPEC_*).
 * @param {boolean}  [o.readOnly=false] false = puede escribir (dentro del módulo).
 * @param {Function} [o.sqlRunner]
 * @param {number}   [o.maxSteps=20]
 * @param {Function} [o.onEvent]        Eventos del bucle (para supervisión dirigida por eventos).
 * @param {object}   [o.bus]            Bus de mensajes; si viene, publica el resultado.
 * @param {number}   [o.taskId]
 * @returns {Promise<{summary, steps, stoppedBy, usage}>}
 */
async function runModuleAgent(o) {
    const {
        provider, moduleName, moduleDir, brief, definition = '', methodology = '',
        readOnly = false, sqlRunner, maxSteps = 20, onEvent, bus, taskId, signal,
    } = o;
    if (!provider || !moduleName || !moduleDir) throw new Error('runModuleAgent: faltan provider/moduleName/moduleDir');

    const system = buildAgentSystem(moduleName, moduleDir, definition, brief, methodology);
    const { defs, handlers } = buildDefaultTools({ root: path.resolve(moduleDir), sqlRunner, readOnly });

    const start = { type: 'agent_start', module: moduleName };
    if (onEvent) onEvent(start);

    const r = await runAgent({
        provider, system,
        messages: [{ role: 'user', content: brief || 'Realiza tu encargo.' }],
        tools: defs, handlers, maxSteps, onEvent, signal,
    });

    if (bus && taskId) {
        await bus.post({ taskId, sender: `agent:${moduleName}`, recipient: 'estratega', kind: 'result',
            payload: { summary: r.text, steps: r.steps, stoppedBy: r.stoppedBy } });
    }
    return { summary: r.text, steps: r.steps, stoppedBy: r.stoppedBy, usage: r.usage };
}

module.exports = { runModuleAgent, buildAgentSystem };
