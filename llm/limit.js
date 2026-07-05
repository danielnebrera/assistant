"use strict";
// Semáforo de concurrencia sin dependencias. Limita cuántas tareas async corren a
// la vez (backpressure para las sesiones de agente in-process). Antes no había cap:
// N agentes en tmux podían saturar la caja; aquí se acotan explícitamente.
// Devuelve { run, active, pending, max }: usar `limiter.run(() => ...)`.
function createLimiter(max) {
    max = Math.max(1, max | 0);
    let active = 0;
    const queue = [];
    function drain() {
        if (active >= max || queue.length === 0) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(
            (v) => { active--; resolve(v); drain(); },
            (e) => { active--; reject(e); drain(); });
    }
    function run(fn) {
        return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); drain(); });
    }
    return { run, active: () => active, pending: () => queue.length, max };
}

module.exports = { createLimiter };
