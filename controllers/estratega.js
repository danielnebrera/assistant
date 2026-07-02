"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  El ESTRATEGA — interlocutor no-técnico de cada tarea.                     ║
// ║                                                                            ║
// ║  Conversa con el usuario en lenguaje de negocio, mantiene la DEFINICIÓN    ║
// ║  de la tarea al día y (en fases siguientes) coordinará a los agentes de    ║
// ║  cada módulo. Un "turno" del Estratega es una llamada NO interactiva al    ║
// ║  CLI `claude` (modo -p/print): le pasamos la conversación + la definición  ║
// ║  actual y devuelve JSON { reply, definition, ready, actions }.             ║
// ║                                                                            ║
// ║  Acceso de SOLO LECTURA al proyecto: corre con cwd=WORK_DIR y solo las     ║
// ║  herramientas Read/Grep/Glob (sin Edit/Write/Bash), así puede CONSULTAR    ║
// ║  el código, los SPEC.md y los esquemas SQL para fundamentar respuestas y   ║
// ║  planes, pero NO puede modificar nada ni ejecutar shell.                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const path  = require('path');
const { execFile } = require('child_process');
const tasks = require('./tasks_store');
const modules = require('./modules_store');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const HOME_DIR   = process.env.CLAUDE_HOME || '/home/ubuntu';
const MODEL      = process.env.ESTRATEGA_MODEL || 'sonnet';
// Raíz del proyecto (mismo que los agentes): el Estratega lee AQUÍ, en SOLO LECTURA.
const WORK_DIR   = process.env.CLAUDE_WORK_DIR || path.join(__dirname, '..', '..');
// Credenciales MySQL de SOLO LECTURA (usuario assistant_ro). El Estratega consulta
// datos en vivo con `mysql --defaults-file=...`; el usuario read-only impide escribir.
const DB_RO_DEFAULTS = process.env.DB_RO_DEFAULTS_FILE || '/home/factory/.assistant_ro.cnf';
// Herramientas permitidas (todas de lectura): leer/buscar código + mysql (solo SELECT,
// garantizado por el usuario read-only). Sin Edit/Write ni Bash general.
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(mysql:*)'];

const SYSTEM = `Eres el ESTRATEGA de una plataforma de desarrollo asistido. Hablas con una
persona SIN perfil técnico que quiere evolucionar su aplicación. Tu trabajo en esta fase:

1. Entender QUÉ quiere conseguir (su negocio), haciendo preguntas breves cuando falte
   información importante. Una pregunta cada vez, en lenguaje sencillo.
2. Mantener una DEFINICIÓN clara de la tarea: qué se quiere lograr y por qué, en lenguaje
   de negocio (NUNCA detalles técnicos, ni nombres de ficheros, ni tablas, ni código).
3. NO prometas plazos ni des nada por hecho. No inventes. Si algo no está claro, pregúntalo.
4. GESTIONAR el desarrollo: cuando el usuario te ordene empezar y la definición esté clara,
   lánzalo (acción "lanzar"). El usuario te seguirá hablando SOLO a ti: traduce cada corrección
   suya a (a) un cambio en la "definition" y (b) acciones sobre los agentes (corregir con
   "enviar", abrir nuevos con "lanzar", o parar/hard_kill los que sobren). El usuario NUNCA
   habla con los agentes: los coordinas tú.

PUEDES CONSULTAR el proyecto en SOLO LECTURA para fundamentar tus respuestas y planes:
- CÓDIGO y ESQUEMA: lee el código, los SPEC.md de cada módulo y los esquemas SQL (ficheros sql/).
- DATOS en vivo: ejecuta consultas de SOLO LECTURA con
    mysql --defaults-file=${DB_RO_DEFAULTS} -N -e "<SQL>"
  (usuario read-only: SOLO SELECT/SHOW/DESCRIBE; nada de escribir, sin tuberías). La BD de la
  app es \`factory\` y sus tablas llevan prefijo de entorno (\`dev_\`, \`pro_\`); oriéntate con
  SHOW TABLES y DESCRIBE.
NO puedes modificar nada (ni código ni datos). Si el usuario pregunta por una pantalla, dato o
estructura que YA existe, INVESTÍGALO en el código/esquema/BD antes de responder; NO digas que
no tienes acceso. Al usuario háblale siempre en lenguaje de negocio, sin tecnicismos.

Hablas español, cercano y conciso. La aplicación está dividida en módulos (secciones); los
conoces solo para orientarte, no se los menciones al usuario salvo que ayude.

Responde SIEMPRE y SOLO con un objeto JSON válido (sin texto alrededor, sin markdown) con
esta forma exacta:
{
  "reply": "mensaje para el usuario NO técnico, SOLO cuando haga falta: una PREGUNTA de negocio o una decisión que necesites de él, o un hito importante (p.ej. 'ya está listo'). Si solo estás trabajando/coordinando, deja \\"\\" (la pantalla ya muestra 'Trabajando…'). NUNCA pongas detalle técnico aquí.",
  "definition": "la definición de la tarea ACTUALIZADA en lenguaje de negocio; deja \\"\\" si todavía no tienes suficiente para definirla",
  "ready": true|false,  // true solo cuando la definición está clara y completa para empezar a desarrollar
  "actions": []         // órdenes para los agentes (ver protocolo); [] si no hay nada que hacer
}

El CHAT es SOLO para el usuario no técnico (lenguaje de negocio). El detalle técnico de
coordinación (abrir/parar/hard_kill agentes, tests, etc.) va por "actions" y se registra en el
panel del Estratega, NUNCA en "reply". Usa "reply" con moderación: sobre todo para PREGUNTAR
decisiones de negocio o avisar de un hito; mientras trabajas, "reply" vacío.`;

// Protocolo de ACCIONES: el Estratega DECIDE (solo texto→JSON); el código de
// confianza (agents.executeActions) las EJECUTA contra los agentes. El Estratega
// nunca toca el repo ni tmux por sí mismo.
const ACTION_PROTOCOL = `Además de "reply" puedes incluir un array "actions" con órdenes que el sistema
EJECUTA por ti sobre los agentes (déjalo [] si no hay nada que hacer). TÚ gestionas a los agentes:
el usuario NO habla con ellos, solo contigo. Operaciones válidas:
- { "op": "lanzar" }                          // arranque INICIAL: planifica y abre 1 agente por cada módulo necesario. Úsalo al EMPEZAR, cuando aún no hay agentes.
- { "op": "abrir", "module": "<módulo>", "brief": "encargo técnico concreto para ese agente" }  // añade UN agente de módulo. Úsalo al CORREGIR la tarea si hace falta un módulo nuevo (p.ej. admin). Si ya hay uno trabajando en ese módulo, no hace nada.
- { "op": "enviar", "module": "<módulo>", "text": "instrucción o corrección para ese agente" }
- { "op": "parar",  "module": "<módulo>" }    // parada SUAVE (Esc + 'detente'); conserva su contexto
- { "op": "hard_kill", "module": "<módulo>" } // CIERRA (mata) el agente de ese módulo; úsalo si SOBRA (ya no lo pide la definición), está duplicado o irrecuperable
- { "op": "parar_todos" }                     // emergencia: parada suave de todos
- { "op": "probar" }                          // ejecuta los tests de los módulos de la tarea.
- { "op": "guardar" }                         // acepta y GUARDA (commit); SOLO cuando el usuario lo pida explícitamente.
Reconoce SIEMPRE cuántos agentes hay abiertos. Al CORREGIR la tarea: usa "abrir" para AÑADIR un
módulo nuevo, "hard_kill" para CERRAR el que ya no haga falta, y "enviar" para reorientar a los que
siguen. NO uses "lanzar" para añadir un módulo suelto (eso es solo el arranque inicial).
Sé CONSERVADOR con parar/hard_kill: solo cuando de verdad sobra o se desvía.`;

function renderAgentStates(agentStates) {
    if (!agentStates || !agentStates.length) return '';
    const blocks = agentStates.map(a =>
        `### Módulo «${a.module}» — estado: ${a.status}\n` +
        (a.tail ? '```\n' + a.tail + '\n```' : '(sin log reciente)')
    ).join('\n\n');
    return '\n--- AGENTES EN MARCHA (su log reciente) ---\n' + blocks;
}

function buildPrompt({ task, messages, mods, agentStates }) {
    const modList = mods.filter(m => m.active).map(m => '- ' + m.name).join('\n');
    const convo = messages.map(m => (m.role === 'user' ? 'USUARIO' : 'ESTRATEGA') + ': ' + m.content).join('\n\n');
    const running = (agentStates || []).filter(a => a.status === 'running').length;
    const done = ['hecho', 'commit'].includes(task.status);
    let stateNote;
    if (running) {
        stateNote = renderAgentStates(agentStates) + '\n(Hay ' + running + ' agente(s) TRABAJANDO. Si el usuario pide cambios, ACTUALIZA la "definition" y propaga: "enviar" para corregir a cada agente afectado, "abrir" para AÑADIR un módulo nuevo, "hard_kill" para CERRAR el que sobre.)';
    } else if (done) {
        stateNote = (agentStates && agentStates.length ? renderAgentStates(agentStates) + '\n' : '') +
            '\n(Esta tarea ya está TERMINADA y guardada, pero SIGUES conversando con normalidad:\n' +
            '- Si el mensaje es una CONTINUACIÓN o PRECISIÓN de esta misma tarea, actualiza la "definition" y, si requiere trabajo, REÁBRELA con la acción "lanzar".\n' +
            '- Si es algo DISTINTO (otra funcionalidad no relacionada), NO amplíes esta tarea: recomienda amablemente al usuario guardar/cerrar esta y abrir una tarea NUEVA para eso.)';
    } else {
        stateNote = '\n(Aún NO hay agentes en marcha. Cuando el usuario te ordene empezar y la definición esté clara, emite la acción "lanzar".)';
    }
    return [
        SYSTEM,
        '\n' + ACTION_PROTOCOL,
        '\n--- MÓDULOS DE LA APP (solo para tu orientación) ---\n' + (modList || '(ninguno)'),
        '\n--- TÍTULO DE LA TAREA ---\n' + (task.title || ''),
        '\n--- ESTADO DE LA TAREA ---\n' + (task.status || ''),
        '\n--- DEFINICIÓN ACTUAL ---\n' + (task.definition && task.definition.trim() ? task.definition : '(aún sin definir)'),
        stateNote,
        '\n--- CONVERSACIÓN HASTA AHORA ---\n' + (convo || '(vacía)'),
        '\nResponde al último mensaje del USUARIO. Devuelve SOLO el JSON.',
    ].join('\n');
}

// Llama al CLI claude en modo print y devuelve el texto de `.result`.
function runClaude(prompt) {
    return new Promise((resolve, reject) => {
        const args = ['-p', '--output-format', 'json', '--model', MODEL,
            '--allowed-tools', ...READ_TOOLS];   // solo lectura: Read/Grep/Glob (sin Edit/Write/Bash)
        const child = execFile(CLAUDE_BIN, args, {
            cwd: WORK_DIR,                        // lee el proyecto real, en solo lectura
            env: { ...process.env, HOME: HOME_DIR },
            // El turno ahora usa herramientas (lee código/BD): más margen que los 120s originales.
            timeout: Number(process.env.ESTRATEGA_TIMEOUT_MS) || 300000,
            maxBuffer: 16 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (err && !stdout) {
                // Timeout (execFile mata el proceso): mensaje claro en vez de "Command failed".
                if (err.killed || err.signal) return reject(new Error('el turno tardó demasiado (timeout). Prueba con una petición más concreta.'));
                return reject(new Error('claude: ' + (stderr || err.message)));
            }
            try {
                const env = JSON.parse(stdout);
                if (env.is_error) return reject(new Error(env.result || 'error del modelo'));
                resolve(String(env.result || ''));
            } catch (e) { reject(new Error('respuesta no parseable: ' + e.message)); }
        });
        child.stdin.write(prompt);
        child.stdin.end();
    });
}

// Extrae el primer objeto JSON del texto (el modelo a veces lo envuelve).
function parseReply(text) {
    let s = text.trim();
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
        // Si no vino JSON, tratamos todo el texto como el mensaje al usuario.
        return { reply: text.trim(), definition: '', ready: false, actions: [] };
    }
}

// Genera el turno del Estratega para una tarea: lee el contexto, llama a claude,
// guarda el mensaje del asistente y actualiza la definición/estado.
async function respond(taskId, agentStates = []) {
    const task = await tasks.get(taskId);
    if (!task) throw new Error('Tarea no encontrada');
    const [messages, mods] = await Promise.all([tasks.messages(taskId), modules.list()]);
    const prompt = buildPrompt({ task, messages, mods, agentStates });

    let out;
    try { out = parseReply(await runClaude(prompt)); }
    catch (e) {
        const msg = 'Ahora mismo no he podido procesar tu mensaje (' + e.message + '). ¿Puedes intentarlo de nuevo?';
        await tasks.addMessage(taskId, 'assistant', msg);
        return { ok: false, error: e.message, actions: [] };
    }

    if (out.reply) await tasks.addMessage(taskId, 'assistant', out.reply);
    // El chat gestiona la definición incluso durante el desarrollo: si el usuario pide
    // cambios, el Estratega actualiza aquí la definición (y propaga a los agentes con actions).
    if (out.definition) await tasks.setDefinition(taskId, out.definition);
    if (task.status === 'pendiente') await tasks.setStatus(taskId, 'definicion');
    return { ok: true, ready: out.ready, actions: out.actions || [] };
}

/* ── Supervisión: turno autónomo del Estratega sobre los agentes en marcha ──── */
const SUPERVISE_SYSTEM = `Eres el ESTRATEGA SUPERVISANDO a los agentes de módulo que lanzaste para una tarea
YA DEFINIDA. Revisas el estado y el log reciente de cada agente y decides si intervenir.

Tu objetivo: que cada agente se ciña a SU módulo y a su encargo. Intervén si un agente:
- toca o intenta tocar ficheros FUERA de su módulo,
- se desvía del objetivo de la tarea o hace cosas no pedidas,
- entra en un bucle de errores o se queda atascado/esperando,
- pide una confirmación que puedas resolver tú.
Cuenta CUÁNTOS agentes hay abiertos: si alguno SOBRA (duplicado, o un módulo que la definición
actual ya no necesita), retíralo con "parar" (si puede cerrar limpio) o "hard_kill" (si sobra del todo).
En supervisión limítate a COORDINAR agentes (enviar / parar / hard_kill / lanzar). NO uses "probar"
ni "guardar": esas las pide el usuario por el chat, no las decidas tú aquí.

NO toques el repo: solo DECIDES; el sistema ejecuta tus acciones. Responde SIEMPRE y SOLO con
un objeto JSON válido (sin markdown):
{
  "note": "nota BREVE para el registro de lo que observas/haces; déjala \\"\\" si todo va bien y no intervienes",
  "actions": [ ... ]
}
Sé CONSERVADOR: ante la duda, no intervengas (note "", actions []). Habla español.`;

function buildSupervisePrompt({ task, agentStates }) {
    return [
        SUPERVISE_SYSTEM,
        '\n' + ACTION_PROTOCOL,
        '\n--- OBJETIVO DE LA TAREA ---\n' + (task.definition && task.definition.trim() ? task.definition : (task.title || '')),
        renderAgentStates(agentStates) || '\n(no hay agentes en marcha)',
        '\nDecide si intervenir. Devuelve SOLO el JSON.',
    ].join('\n');
}

function parseSupervision(text) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) s = fence[1].trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { const o = JSON.parse(s); return { note: String(o.note || '').trim(), actions: Array.isArray(o.actions) ? o.actions : [] }; }
    catch (e) { return { note: '', actions: [] }; }
}

// Un turno de supervisión: el caller le pasa el estado de los agentes y devuelve
// {note, actions}. NO persiste nada (lo hace el caller, que también ejecuta).
async function supervise(taskId, agentStates) {
    const task = await tasks.get(taskId);
    if (!task) throw new Error('Tarea no encontrada');
    let out;
    try { out = parseSupervision(await runClaude(buildSupervisePrompt({ task, agentStates }))); }
    catch (e) { return { ok: false, error: e.message, note: '', actions: [] }; }
    return { ok: true, note: out.note, actions: out.actions };
}

module.exports = { respond, supervise, runClaude, parseReply, MODEL };
