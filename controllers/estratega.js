"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  El ESTRATEGA — interlocutor no-técnico de cada tarea.                     ║
// ║                                                                            ║
// ║  Conversa con el usuario en lenguaje de negocio, mantiene la DEFINICIÓN    ║
// ║  de la tarea al día y (en fases siguientes) coordinará a los agentes de    ║
// ║  cada módulo. Un "turno" del Estratega es una llamada NO interactiva al    ║
// ║  CLI `claude` (modo -p/print): le pasamos la conversación + la definición  ║
// ║  actual y devuelve JSON { reply, definition, ready }. Sin herramientas:    ║
// ║  este turno solo CONVERSA, no toca el repo.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const { execFile } = require('child_process');
const tasks = require('./tasks_store');
const modules = require('./modules_store');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const HOME_DIR   = process.env.CLAUDE_HOME || '/home/ubuntu';
const MODEL      = process.env.ESTRATEGA_MODEL || 'sonnet';
// cwd neutro y vacío: aunque el modelo intentara leer algo, aquí no hay nada que
// tocar (defensa adicional a --disallowed-tools).
const NEUTRAL_CWD = path.join(os.tmpdir(), 'assistant-estratega');
try { fs.mkdirSync(NEUTRAL_CWD, { recursive: true }); } catch (e) {}

const SYSTEM = `Eres el ESTRATEGA de una plataforma de desarrollo asistido. Hablas con una
persona SIN perfil técnico que quiere evolucionar su aplicación. Tu trabajo en esta fase:

1. Entender QUÉ quiere conseguir (su negocio), haciendo preguntas breves cuando falte
   información importante. Una pregunta cada vez, en lenguaje sencillo.
2. Mantener una DEFINICIÓN clara de la tarea: qué se quiere lograr y por qué, en lenguaje
   de negocio (NUNCA detalles técnicos, ni nombres de ficheros, ni tablas, ni código).
3. NO prometas plazos ni des nada por hecho. No inventes. Si algo no está claro, pregúntalo.

Hablas español, cercano y conciso. La aplicación está dividida en módulos (secciones); los
conoces solo para orientarte, no se los menciones al usuario salvo que ayude.

Responde SIEMPRE y SOLO con un objeto JSON válido (sin texto alrededor, sin markdown) con
esta forma exacta:
{
  "reply": "tu mensaje para el usuario (lenguaje natural, cercano)",
  "definition": "la definición de la tarea ACTUALIZADA en lenguaje de negocio; deja \\"\\" si todavía no tienes suficiente para definirla",
  "ready": true|false   // true solo cuando la definición está clara y completa para empezar a desarrollar
}`;

function buildPrompt({ task, messages, mods }) {
    const modList = mods.filter(m => m.active).map(m => '- ' + m.name).join('\n');
    const convo = messages.map(m => (m.role === 'user' ? 'USUARIO' : 'ESTRATEGA') + ': ' + m.content).join('\n\n');
    return [
        SYSTEM,
        '\n--- MÓDULOS DE LA APP (solo para tu orientación) ---\n' + (modList || '(ninguno)'),
        '\n--- TÍTULO DE LA TAREA ---\n' + (task.title || ''),
        '\n--- DEFINICIÓN ACTUAL ---\n' + (task.definition && task.definition.trim() ? task.definition : '(aún sin definir)'),
        '\n--- CONVERSACIÓN HASTA AHORA ---\n' + (convo || '(vacía)'),
        '\nResponde al último mensaje del USUARIO. Devuelve SOLO el JSON.',
    ].join('\n');
}

// Llama al CLI claude en modo print y devuelve el texto de `.result`.
function runClaude(prompt) {
    return new Promise((resolve, reject) => {
        const args = ['-p', '--output-format', 'json', '--model', MODEL,
            '--disallowed-tools', 'Bash', 'Edit', 'Write', 'WebSearch', 'WebFetch'];
        const child = execFile(CLAUDE_BIN, args, {
            cwd: NEUTRAL_CWD,
            env: { ...process.env, HOME: HOME_DIR },
            timeout: 120000,
            maxBuffer: 8 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            if (err && !stdout) return reject(new Error('claude: ' + (stderr || err.message)));
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
        return { reply: String(o.reply || '').trim(), definition: String(o.definition || '').trim(), ready: !!o.ready };
    } catch (e) {
        // Si no vino JSON, tratamos todo el texto como el mensaje al usuario.
        return { reply: text.trim(), definition: '', ready: false };
    }
}

// Genera el turno del Estratega para una tarea: lee el contexto, llama a claude,
// guarda el mensaje del asistente y actualiza la definición/estado.
async function respond(taskId) {
    const task = await tasks.get(taskId);
    if (!task) throw new Error('Tarea no encontrada');
    const [messages, mods] = await Promise.all([tasks.messages(taskId), modules.list()]);
    const prompt = buildPrompt({ task, messages, mods });

    let out;
    try { out = parseReply(await runClaude(prompt)); }
    catch (e) {
        const msg = 'Ahora mismo no he podido procesar tu mensaje (' + e.message + '). ¿Puedes intentarlo de nuevo?';
        await tasks.addMessage(taskId, 'assistant', msg);
        return { ok: false, error: e.message };
    }

    if (out.reply) await tasks.addMessage(taskId, 'assistant', out.reply);
    if (out.definition) await tasks.setDefinition(taskId, out.definition);
    // Mientras se define, la tarea está en "Definiendo". (Pasar a desarrollo será
    // una acción explícita del usuario en la fase 3.)
    if (task.status === 'pendiente') await tasks.setStatus(taskId, 'definicion');
    return { ok: true, ready: out.ready };
}

module.exports = { respond, runClaude, parseReply, MODEL };
