"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Verificación de JWT compartida entre `app` y `assistant`.                 ║
// ║                                                                            ║
// ║  Punto clave de resiliencia: el access token lleva embebidos los permisos  ║
// ║  del usuario en el momento del login. Así el `assistant` (proceso aparte)  ║
// ║  puede decidir si dar acceso a /claude verificando SOLO la firma del       ║
// ║  token, sin llamar a la `app` ni a la BD. Si la app está caída, /claude    ║
// ║  sigue funcionando.                                                        ║
// ║                                                                            ║
// ║  (La `app`, para sus pantallas normales, recarga permisos frescos del      ║
// ║   módulo users en cada request, de modo que un cambio de permisos surte    ║
// ║   efecto al instante sin re-login.)                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const jwt = require('jsonwebtoken');

// Sesión persistente del asistente: la cookie dura ~10 años y se renueva en cada
// request (ver gate en app.js), de modo que la sesión NO caduca nunca mientras no
// se haga logout (que borra la cookie). Es una terminal de desarrollo de un único
// usuario privilegiado (CLAUDE_CODE_VIEW), así que este canje de caducidad por
// comodidad es aceptable — y es coherente con el diseño resiliente del asistente,
// que ya confía en los permisos embebidos en el token sin reconsultar la BD.
const SESSION_COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365 * 10;   // ~10 años

function sign(payload, expiresIn) {
    return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: expiresIn || '3650d' });
}
function signRefresh(payload) {
    return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '12h' });
}

// Devuelve el payload decodificado o null si el token falta / la firma es inválida.
// IGNORAMOS la expiración a propósito: el asistente no debe echar al usuario del
// terminal por antigüedad del token (incluido el token de 180m que emite la `app`).
// La firma sí se sigue validando, y el logout borra la cookie → eso sí desconecta.
function verify(token) {
    if (!token) return null;
    try { return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, { ignoreExpiration: true }); }
    catch (e) { return null; }
}

function parseCookies(header) {
    const out = {};
    (header || '').split(';').forEach(c => {
        const i = c.indexOf('=');
        if (i < 0) return;
        out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
    });
    return out;
}

module.exports = { sign, signRefresh, verify, parseCookies, SESSION_COOKIE_MAX_AGE };
