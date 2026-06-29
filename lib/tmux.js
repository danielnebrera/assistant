"use strict";
// Helpers tmux para los agentes de módulo (independientes del bridge del terminal).
// Cada agente vive en su propia sesión tmux `ag_<agentId>`, así sobrevive a
// reinicios del proceso assistant y se puede enganchar/ver en vivo.
const { execFile } = require('child_process');

const HOME_DIR = process.env.CLAUDE_HOME || '/home/ubuntu';

function tmux(args) {
    return new Promise(resolve => {
        execFile('tmux', args, { env: { ...process.env, HOME: HOME_DIR } },
            (err, stdout) => resolve({ ok: !err, stdout: (stdout || '').trim() }));
    });
}

const exists = async (name) => (await tmux(['has-session', '-t', name])).ok;

async function panePid(name) {
    const r = await tmux(['list-panes', '-t', name, '-F', '#{pane_pid}']);
    const pid = parseInt((r.stdout || '').split('\n')[0], 10);
    return Number.isFinite(pid) ? pid : null;
}

// Crea una sesión que ejecuta `command` (string ya montado) vía bash -lc, en `cwd`.
async function create(name, cwd, command, cols, rows) {
    return (await tmux(['new-session', '-d', '-s', name, '-c', cwd,
        '-x', String(cols || 140), '-y', String(rows || 34),
        'bash', '-lc', command])).ok;
}

const kill = (name) => tmux(['kill-session', '-t', name]);
const capture = async (name) => (await tmux(['capture-pane', '-t', name, '-p'])).stdout;
const sendKeys  = (name, literal) => tmux(['send-keys', '-t', name, '-l', literal]);
const sendEnter = (name) => tmux(['send-keys', '-t', name, 'Enter']);

module.exports = { tmux, exists, panePid, create, kill, capture, sendKeys, sendEnter };
