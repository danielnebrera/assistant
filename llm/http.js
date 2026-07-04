"use strict";
// POST JSON minimalista, SIN dependencias (fetch nativo de Node ≥18). Los
// adaptadores lo usan para hablar con las APIs REST de cada proveedor.
async function postJson(url, { headers = {}, body, timeoutMs = 300000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: typeof body === 'string' ? body : JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* respuesta no-JSON */ }
        if (!res.ok) {
            const msg = (json && json.error && (json.error.message || json.error)) || text || res.statusText;
            const err = new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
            err.status = res.status; err.body = json || text;
            throw err;
        }
        return json;
    } finally { clearTimeout(timer); }
}

module.exports = { postJson };
