"use strict";
// Carga el .env del proceso que lo requiere. Cada proceso (app, assistant) tiene
// su propio .env en su carpeta, pero comparten esta utilidad. El .env manda sobre
// el entorno heredado de pm2 (salvo en tests, que fijan DB_DATABASE antes).
const path = require('path');

function load(dir) {
    const _dotenv = require('dotenv').config({ path: path.join(dir, '.env'), override: true });
    if (_dotenv && _dotenv.parsed) {
        for (const [k, v] of Object.entries(_dotenv.parsed)) {
            if (process.env.NODE_ENV === 'test' && (k === 'DB_DATABASE' || k === 'DB_USER' || k === 'DB_PASSWORD')) continue;
            process.env[k] = v;
        }
        if (_dotenv.parsed.PORT) process.env.PORT = _dotenv.parsed.PORT;
    }
    return process.env;
}

module.exports = { load };
