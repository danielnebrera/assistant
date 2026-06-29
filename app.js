"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  `assistant` — PROCESO INDEPENDIENTE para /assistant.                      ║
// ║                                                                            ║
// ║  Sirve la UI del Assistant (tabs Tareas / Módulos / Terminal) y el         ║
// ║  WebSocket /ws/assistant del terminal. Autoriza verificando el JWT local   ║
// ║  (permisos embebidos). Las tareas y los módulos viven en MySQL (BD         ║
// ║  `factory`, prefijo de entorno) — ver lib/db.js. El terminal sigue sobre   ║
// ║  tmux, así que las sesiones sobreviven a reinicios de este proceso.        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const path = require('path');
require('./lib/config').load(__dirname);

const express  = require('express');
const auth     = require('./lib/auth');
const terminal = require('./controllers/claude_terminal');
const db       = require('./lib/db');
const modules  = require('./controllers/modules_store');
const api       = require('./controllers/api');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '1mb' }));

// Gate: verifica JWT local + permiso embebido. Puebla req.user. Si no, login.
function gate(req, res, next) {
    const token = auth.parseCookies(req.headers.cookie).token;
    const user  = auth.verify(token);
    const isApi = req.originalUrl.includes('/api/');   // tras el mount, req.path no incluye el prefijo
    if (!user) {
        const loginUrl = (process.env.APP_PUBLIC_URL || '') + '/users/login_form?next=/assistant';
        if (isApi) return res.status(401).json({ error: 'No autorizado' });
        return res.redirect(loginUrl);
    }
    if ((user.permissions || []).indexOf('CLAUDE_CODE_VIEW') === -1) {
        if (isApi) return res.status(403).json({ error: 'Acceso denegado' });
        return res.status(403).send('Acceso denegado');
    }
    req.user = user;
    next();
}

app.get('/assistant', gate, (req, res) => res.render('claude_code', { user: req.user }));
app.use('/assistant/api', gate, api);
app.get('/healthz', (req, res) => res.json({ ok: true, service: 'assistant', ts: Date.now() }));

const PORT = process.env.PORT || 5510;

// Arranca el HTTP+WS solo cuando la BD esté lista (esquema creado + módulos
// sembrados). Si la BD no responde, lo registramos pero igualmente levantamos el
// terminal (es lo crítico: poder operar el código aunque las tablas fallen).
async function boot() {
    try {
        await db.ensureSchema();
        const n = await modules.sync();
        console.log(`[assistant] BD lista · ${n} módulos sincronizados`);
    } catch (e) {
        console.error('[assistant] AVISO: la BD no está disponible:', e.message);
    }
    const server = app.listen(PORT, process.env.BIND_ADDR || '127.0.0.1', () => {
        console.log('assistant escuchando en ' + PORT);
    });
    terminal.setupWebSocket(server);
}

boot();
