"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Login PROPIO del assistant (resiliencia).                                 ║
// ║                                                                            ║
// ║  Normalmente el acceso a /assistant lo da el login de la `app` (módulo      ║
// ║  users): el navegador trae ya la cookie `token` y el gate solo verifica la ║
// ║  firma. PERO si la `app` está caída, ese login es inalcanzable y nadie      ║
// ║  podría entrar al terminal — justo cuando más falta hace para arreglarla.   ║
// ║                                                                            ║
// ║  Por eso el assistant sabe autenticar por su cuenta: lee la tabla de        ║
// ║  usuarios de la BD de la APP (`db.appT`: factory.dev_users; su BD propia    ║
// ║  factory_assistant no tiene usuarios), compara con bcrypt y, si tiene el    ║
// ║  permiso CLAUDE_CODE_VIEW, emite el MISMO access token que emitiría la app  ║
// ║  ({user_name, user_id, permissions}) firmado con ACCESS_TOKEN_SECRET. La    ║
// ║  cookie resultante vale para la app y para el assistant indistintamente.    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const bcrypt = require('bcryptjs');
const auth   = require('../lib/auth');
const db     = require('../lib/db');

const REQUIRED_PERMISSION = 'CLAUDE_CODE_VIEW';

// Solo permitimos volver a rutas internas del assistant (evita open-redirect).
function safeNext(next) {
    if (typeof next !== 'string') return '/assistant';
    if (!next.startsWith('/assistant')) return '/assistant';
    return next;
}

// GET /assistant/login — formulario propio. Si ya hay sesión válida, al lío.
exports.form = (req, res) => {
    const token = auth.parseCookies(req.headers.cookie).token;
    if (auth.verify(token)) return res.redirect(safeNext(req.query.next));
    res.render('login', {
        error: req.query.error || '',
        next:  safeNext(req.query.next),
    });
};

// POST /assistant/login — autentica contra la BD y deja la cookie `token`.
exports.submit = async (req, res) => {
    const user_name = (req.body.user_name || '').trim();
    const password  = req.body.password || '';
    const next       = safeNext(req.body.next);
    const fail = (msg) =>
        res.redirect('/assistant/login?error=' + encodeURIComponent(msg) +
                     '&next=' + encodeURIComponent(next));

    if (!user_name || !password) return fail('Introduce usuario y contraseña');

    let rows;
    try {
        rows = await db.query(
            `SELECT id, password FROM ${db.appT('users')} WHERE user_name = ?`, [user_name]);
    } catch (e) {
        console.error('[assistant/login] BD no disponible:', e.message);
        return fail('No se puede acceder a la base de datos');
    }
    if (!rows.length) return fail('Usuario o contraseña incorrectos');

    const user_id = rows[0].id;
    let ok = false;
    try { ok = await bcrypt.compare(password, rows[0].password || ''); }
    catch (e) { return fail('Usuario o contraseña incorrectos'); }
    if (!ok) return fail('Usuario o contraseña incorrectos');

    // Permisos embebidos en el token (mismo modelo que el login de la app): el gate
    // y cualquier verificador deciden con solo la firma, sin reconsultar la BD.
    let permissions = [];
    try {
        const permRows = await db.query(
            `SELECT a.activity_code
               FROM ${db.appT('user_roles')} ur
               JOIN ${db.appT('roles_activities')} ra ON ra.role_id = ur.role_id
               JOIN ${db.appT('activities')} a        ON a.id = ra.activity_id
              WHERE ur.user_id = ?`, [user_id]);
        permissions = permRows.map(r => r.activity_code);
    } catch (e) {
        console.error('[assistant/login] no se pudieron leer permisos:', e.message);
        return fail('No se puede acceder a la base de datos');
    }

    // Fallamos CERRADO: sin CLAUDE_CODE_VIEW no se entra al assistant.
    if (permissions.indexOf(REQUIRED_PERMISSION) === -1)
        return fail('Tu usuario no tiene acceso al asistente');

    const token = auth.sign({ user_name, user_id, permissions });
    // Mismos atributos que la cookie que pone la app (main/controllers/users.js),
    // para que ambos procesos compartan exactamente la misma sesión.
    res.cookie('token', token, { maxAge: 90000000, httpOnly: true });
    res.redirect(next);
};

// GET /assistant/logout — limpia la sesión y vuelve al formulario propio.
exports.logout = (req, res) => {
    res.clearCookie('token');
    res.redirect('/assistant/login');
};
