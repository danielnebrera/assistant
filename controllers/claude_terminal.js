"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Puente WebSocket ↔ tmux ↔ CLI `claude` (asistente).                       ║
// ║                                                                            ║
// ║  Portado de factory_dev/main/controllers/claude_terminal.js con dos        ║
// ║  cambios que hacen al asistente AUTÓNOMO (sobrevive a caídas de la app):   ║
// ║   1. authorise(): verifica el JWT en LOCAL y comprueba CLAUDE_CODE_VIEW    ║
// ║      en los permisos embebidos del token. Sin axios a la app, sin BD.      ║
// ║   2. El store de sesiones es un fichero JSON local (sessions_store), no    ║
// ║      la BD vía HTTP.                                                        ║
// ║                                                                            ║
// ║  Como `claude` corre dentro de tmux, también sobrevive a reinicios de       ║
// ║  ESTE proceso: el bridge solo se re-engancha (tmux attach).                ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const WebSocket = require('ws');
const pty       = require('node-pty');
const path      = require('path');
const { execFile } = require('child_process');
const auth      = require('../lib/auth');
const store     = require('./sessions_store');
const agents    = require('./agents');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const WORK_DIR   = process.env.CLAUDE_WORK_DIR || path.join(__dirname, '..', '..'); // raíz de factory3_dev
const HOME_DIR   = process.env.CLAUDE_HOME || '/home/ubuntu';

/* ── tmux helpers ──────────────────────────────────────────────────────────── */
function tmux(args) {
    return new Promise(resolve => {
        execFile('tmux', args, { env: { ...process.env, HOME: HOME_DIR } },
            (err, stdout) => resolve({ ok: !err, stdout: (stdout || '').trim() }));
    });
}
const tmuxExists = async (name) => (await tmux(['has-session', '-t', name])).ok;
async function tmuxPanePid(name) {
    const r = await tmux(['list-panes', '-t', name, '-F', '#{pane_pid}']);
    const pid = parseInt((r.stdout || '').split('\n')[0], 10);
    return Number.isFinite(pid) ? pid : null;
}
const tmuxCreate = async (name, cwd, cols, rows) =>
    (await tmux(['new-session', '-d', '-s', name, '-c', cwd, '-x', String(cols || 120), '-y', String(rows || 30), CLAUDE_BIN])).ok;

function spawnBridge(name, cols, rows) {
    return pty.spawn('tmux', ['attach-session', '-d', '-t', name], {
        name: 'xterm-256color', cols: cols || 120, rows: rows || 30, cwd: WORK_DIR,
        env: { ...process.env, HOME: HOME_DIR, TERM: 'xterm-256color', FORCE_COLOR: '1' },
    });
}

/* ── auth LOCAL: JWT + permiso embebido, sin red ─────────────────────────────── */
function authorise(req) {
    const token = auth.parseCookies(req.headers.cookie).token;
    const user  = auth.verify(token);
    if (!user) return null;
    if ((user.permissions || []).indexOf('CLAUDE_CODE_VIEW') === -1) return null;
    return user.user_id;
}

const send = (ws, obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
function ownedSession(userId, sessionId) {
    const row = store.get(sessionId);
    return (row && row.user_id === userId) ? row : null;
}

function setupWebSocket(server) {
    const wss = new WebSocket.Server({ server, path: '/ws/assistant' });

    // Keepalive: ping periódico para que nginx (proxy_read_timeout) y demás
    // intermediarios no corten la conexión por inactividad, y para detectar
    // sockets muertos (medio-abiertos tras una caída de red) y liberar sus
    // bridges. El navegador responde el pong solo; aquí solo marcamos vivo/muerto.
    const HEARTBEAT_MS = 30000;
    const heartbeat = setInterval(() => {
        wss.clients.forEach(ws => {
            if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
            ws.isAlive = false;
            try { ws.ping(); } catch {}
        });
    }, HEARTBEAT_MS);
    wss.on('close', () => clearInterval(heartbeat));

    wss.on('connection', (ws, req) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws._bridges = new Map();
        let ready = false; const queue = [];
        const dispatch = (msg) => handleMessage(ws, msg).catch(err => {
            try { send(ws, { type: 'error', sessionId: msg && msg.sessionId, data: err.message }); } catch {}
        });

        ws.on('error', e => console.error('[assistant] WS error:', e.message));
        ws.on('message', raw => {
            let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
            if (!ready) { queue.push(msg); return; }
            dispatch(msg);
        });
        ws.on('close', () => {
            ws._bridges.forEach(b => { b.detaching = true; try { b.proc.kill(); } catch {} });
            ws._bridges.clear();
        });

        const userId = authorise(req);
        if (!userId) { send(ws, { type: 'error', data: 'No autorizado' }); ws.close(1008, 'Unauthorized'); return; }
        ws.userId = userId; ready = true;
        while (queue.length) dispatch(queue.shift());
    });
}

function openBridge(ws, sessionId, name, cols, rows) {
    const prev = ws._bridges.get(sessionId);
    if (prev) { prev.detaching = true; try { prev.proc.kill(); } catch {} ws._bridges.delete(sessionId); }
    let proc;
    try { proc = spawnBridge(name, cols, rows); }
    catch (e) { send(ws, { type: 'error', sessionId, data: 'Error al enganchar: ' + e.message }); return; }
    const bridge = { proc, name, detaching: false };
    ws._bridges.set(sessionId, bridge);
    proc.onData(d => { try { send(ws, { type: 'output', sessionId, data: d }); } catch {} });
    proc.onExit(async () => {
        // Solo retiramos la entrada si sigue siendo ESTE bridge. Al cambiar de
        // sesión y volver, openBridge mata el bridge viejo y crea uno nuevo de
        // inmediato; el onExit del viejo llega después y, sin esta guarda,
        // borraba el bridge nuevo del mapa → los 'input' se descartaban y había
        // que refrescar la página para volver a escribir.
        if (ws._bridges.get(sessionId) === bridge) ws._bridges.delete(sessionId);
        if (bridge.detaching) return;
        if (await tmuxExists(name)) send(ws, { type: 'detached', sessionId });
        else { store.update(sessionId, { status: 'exited' }); send(ws, { type: 'exit', sessionId, code: 0 }); }
    });
}

async function handleMessage(ws, msg) {
    const { type, sessionId, data, cols, rows } = msg;

    if (type === 'ping') {
        // Heartbeat a nivel de aplicación: el navegador no expone los ping/pong del
        // protocolo, así que el cliente nos sondea para detectar sockets muertos.
        send(ws, { type: 'pong' });

    } else if (type === 'list') {
        const sessions = [];
        for (const r of store.listByUser(ws.userId, 'running')) {
            if (await tmuxExists('cc_' + r.id)) sessions.push({ sessionId: r.id, title: r.title || ('Sesión #' + r.id), status: 'running' });
            else store.update(r.id, { status: 'exited' });
        }
        send(ws, { type: 'sessions', sessions });

    } else if (type === 'create') {
        const id = store.create({ user_id: ws.userId, title: msg.title || null, cwd: WORK_DIR, status: 'running' });
        const name = 'cc_' + id;
        store.update(id, { tmux_name: name });
        if (!(await tmuxCreate(name, WORK_DIR, cols, rows))) {
            store.update(id, { status: 'exited' });
            send(ws, { type: 'error', sessionId: id, data: 'No se pudo iniciar (¿tmux/claude disponibles?)' });
            return;
        }
        const pid = await tmuxPanePid(name); if (pid) store.update(id, { pid });
        send(ws, { type: 'created', sessionId: id, title: msg.title || ('Sesión #' + id) });
        openBridge(ws, id, name, cols, rows);

    } else if (type === 'attach') {
        const row = ownedSession(ws.userId, sessionId);
        if (!row) { send(ws, { type: 'error', sessionId, data: 'Sesión no encontrada' }); return; }
        if (!(await tmuxExists(row.tmux_name))) { store.update(row.id, { status: 'exited' }); send(ws, { type: 'exit', sessionId: row.id, code: 0 }); return; }
        send(ws, { type: 'attached', sessionId: row.id });
        openBridge(ws, row.id, row.tmux_name, cols, rows);

    } else if (type === 'agent_attach') {
        // Engancha el log en vivo de un agente de módulo (tmux ag_<id>) a su columna.
        const a = await agents.ownedAgent(ws.userId, msg.agentId);
        if (!a || !a.tmux_name || !(await tmuxExists(a.tmux_name))) {
            send(ws, { type: 'exit', sessionId: 'ag_' + msg.agentId, code: 0 }); return;
        }
        send(ws, { type: 'attached', sessionId: a.tmux_name });
        openBridge(ws, a.tmux_name, a.tmux_name, cols, rows);

    } else if (type === 'input') {
        const b = ws._bridges.get(sessionId); if (b) b.proc.write(data);

    } else if (type === 'resize') {
        const b = ws._bridges.get(sessionId); if (b) try { b.proc.resize(Math.max(cols, 1), Math.max(rows, 1)); } catch {}

    } else if (type === 'detach') {
        const b = ws._bridges.get(sessionId);
        if (b) { b.detaching = true; try { b.proc.kill(); } catch {} ws._bridges.delete(sessionId); }

    } else if (type === 'terminate') {
        const row = ownedSession(ws.userId, sessionId); if (!row) return;
        const b = ws._bridges.get(sessionId);
        if (b) { b.detaching = true; try { b.proc.kill(); } catch {} ws._bridges.delete(sessionId); }
        await tmux(['kill-session', '-t', row.tmux_name]);
        store.update(row.id, { status: 'exited' });
        send(ws, { type: 'exit', sessionId: row.id, code: 0 });

    } else if (type === 'rename') {
        const row = ownedSession(ws.userId, sessionId); if (!row) return;
        const title = String(msg.title || '').slice(0, 255);
        store.update(row.id, { title });
        send(ws, { type: 'renamed', sessionId: row.id, title });
    }
}

module.exports = { setupWebSocket };
