#!/usr/bin/env node
"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  GUARDIÁN DE MÓDULO — hook PreToolUse común a TODOS los agentes de módulo. ║
// ║                                                                            ║
// ║  Vive en /assistant (código de confianza del asistente), NO en /app y NO  ║
// ║  por módulo. Convierte la "Regla de Oro" del prompt (blanda) en un VETO   ║
// ║  duro: un agente de módulo solo puede escribir DENTRO de su propia carpeta.║
// ║                                                                            ║
// ║  El `claude` de cada agente lo invoca ANTES de cada Edit/Write/NotebookEdit║
// ║  (ver agent-settings.json). Recibe por stdin el JSON del PreToolUse y sabe ║
// ║  a qué módulo pertenece por el entorno que le siembra agents.js:           ║
// ║    AGENT_MODULE       nombre del módulo (para los mensajes)                ║
// ║    AGENT_MODULE_DIR   ruta ABSOLUTA de la carpeta permitida (raíz de veto) ║
// ║    AGENT_EXTRA_DIRS   (opcional) rutas extra permitidas, separadas por ':' ║
// ║                                                                            ║
// ║  Protocolo de hook: exit 0 => permitir. exit 2 + stderr => BLOQUEAR (el    ║
// ║  motivo de stderr se le devuelve al modelo). Es el contrato estable de     ║
// ║  PreToolUse y funciona también en --permission-mode bypassPermissions.     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const path = require('path');

// Solo estas herramientas escriben ficheros. El resto (Read, Grep, Bash…) no las
// filtra el matcher del settings, así que aquí solo llegan mutaciones de fichero.
// La clave con la ruta cambia según la herramienta.
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

function allow() { process.exit(0); }
function deny(reason) { process.stderr.write(reason + '\n'); process.exit(2); }

// ¿`target` está dentro de `root` (o es el propio `root`)? Compara rutas ya
// normalizadas y absolutas, con separador para no confundir /foo con /foobar.
function isInside(target, root) {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
    const moduleDir = process.env.AGENT_MODULE_DIR;
    // Sin módulo asignado (p.ej. un agente que no sea de módulo) no gobernamos nada.
    if (!moduleDir) return allow();
    const moduleName = process.env.AGENT_MODULE || path.basename(moduleDir);

    let payload;
    // Si no podemos interpretar el payload (formato interno de claude), fallamos
    // ABIERTO para no dejar inservible al agente: es un fallo del harness, no una
    // fuga. El veto real depende de tener una ruta clara que evaluar.
    try { payload = JSON.parse(raw); } catch (e) { return allow(); }

    const input = payload.tool_input || payload.toolInput || {};
    let filePath = null;
    for (const k of PATH_KEYS) { if (input[k]) { filePath = input[k]; break; } }
    if (!filePath) return allow();   // herramienta sin ruta => no aplica

    // Resolver a absoluto: las rutas relativas cuelgan del cwd del agente.
    const cwd = payload.cwd || process.cwd();
    const target = path.resolve(cwd, filePath);

    // Raíces permitidas: la carpeta del módulo + las extra opcionales.
    const roots = [path.resolve(moduleDir)];
    for (const d of (process.env.AGENT_EXTRA_DIRS || '').split(':')) {
        if (d.trim()) roots.push(path.resolve(d.trim()));
    }

    if (roots.some(r => isInside(target, r))) return allow();

    const tool = payload.tool_name || payload.toolName || 'la herramienta';
    return deny(
        `BLOQUEADO por el guardián de módulo: eres el agente del módulo «${moduleName}» y ` +
        `solo puedes escribir dentro de ${moduleDir}. ` +
        `${tool} intentó modificar ${target}, que pertenece a otro módulo. ` +
        `Para datos o cambios de otro módulo, usa su servicio (\`<otro>.service.js\`) o coordínalo con el Estratega; ` +
        `no edites sus ficheros directamente.`
    );
});
