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

function sign(payload, expiresIn) {
    return jwt.sign(payload, process.env.ACCESS_TOKEN_SECRET, { expiresIn: expiresIn || '180m' });
}
function signRefresh(payload) {
    return jwt.sign(payload, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '12h' });
}

// Devuelve el payload decodificado o null si el token falta / es inválido / caduca.
function verify(token) {
    if (!token) return null;
    try { return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET); }
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

module.exports = { sign, signRefresh, verify, parseCookies };
