"use strict";
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  Bus de mensajes — la COMUNICACIÓN ENTRE AGENTES, y es TUYA (no propietaria)║
// ║                                                                            ║
// ║  Sustituye al control por `tmux sendKeys` + scraping del pane. En vez de   ║
// ║  teclear en una terminal y leer la pantalla con regex, los mensajes entre  ║
// ║  el Estratega y los agentes de módulo viajan por una tabla con ESQUEMA     ║
// ║  PROPIO: estructurado, auditable y agnóstico del proveedor de IA.          ║
// ║                                                                            ║
// ║  Topología: estrella (el Estratega relaya). El "canal" es esta tabla + el  ║
// ║  workspace compartido (ficheros). Nada de esto depende de Anthropic.       ║
// ║                                                                            ║
// ║  Se construye con (query, t) inyectados → testeable sin BD real.           ║
// ╚══════════════════════════════════════════════════════════════════════════╝

const KINDS = ['instruction', 'result', 'note', 'status', 'question'];
const STATUSES = ['pending', 'delivered', 'consumed'];

/** Crea la tabla del bus (idempotente). MySQL, patrón de lib/db.js. */
async function ensureMessageSchema(query, t) {
    await query(`CREATE TABLE IF NOT EXISTS ${t('assistant_message')} (
        id           INT NOT NULL AUTO_INCREMENT,
        task_id      INT          NOT NULL,
        sender       VARCHAR(64)  NOT NULL,   -- 'user' | 'estratega' | 'agent:<modulo>'
        recipient    VARCHAR(64)  NOT NULL,   -- mismo espacio de nombres
        kind         ENUM('instruction','result','note','status','question') NOT NULL,
        payload      MEDIUMTEXT,              -- JSON
        status       ENUM('pending','delivered','consumed') NOT NULL DEFAULT 'pending',
        created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        consumed_at  DATETIME     DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_msg_task (task_id),
        KEY idx_msg_recipient (recipient, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

/** Fila de BD → objeto de dominio (payload deserializado). Función PURA. */
function rowToMessage(row) {
    let payload = row.payload;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch { /* deja el string */ } }
    return {
        id: row.id, taskId: row.task_id, sender: row.sender, recipient: row.recipient,
        kind: row.kind, payload, status: row.status,
        createdAt: row.created_at, consumedAt: row.consumed_at,
    };
}

/**
 * Bus de mensajes. `deps` = { query, t } (de lib/db.js, o falsos en test).
 */
function createMessageBus({ query, t }) {
    if (!query || !t) throw new Error('createMessageBus: faltan { query, t }');

    async function post({ taskId, sender, recipient, kind, payload }) {
        if (!taskId) throw new Error('post: falta taskId');
        if (!KINDS.includes(kind)) throw new Error(`post: kind inválido "${kind}"`);
        const body = payload == null ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload));
        const r = await query(
            `INSERT INTO ${t('assistant_message')} (task_id, sender, recipient, kind, payload) VALUES (?,?,?,?,?)`,
            [taskId, sender, recipient, kind, body]);
        return { id: r.insertId };
    }

    async function pending(recipient, taskId = null) {
        const params = [recipient];
        let sql = `SELECT * FROM ${t('assistant_message')} WHERE recipient=? AND status='pending'`;
        if (taskId != null) { sql += ' AND task_id=?'; params.push(taskId); }
        sql += ' ORDER BY id ASC';
        return (await query(sql, params)).map(rowToMessage);
    }

    async function thread(taskId) {
        return (await query(`SELECT * FROM ${t('assistant_message')} WHERE task_id=? ORDER BY id ASC`, [taskId])).map(rowToMessage);
    }

    async function markDelivered(id) {
        await query(`UPDATE ${t('assistant_message')} SET status='delivered' WHERE id=? AND status='pending'`, [id]);
    }
    async function markConsumed(id) {
        await query(`UPDATE ${t('assistant_message')} SET status='consumed', consumed_at=NOW() WHERE id=?`, [id]);
    }

    return { post, pending, thread, markDelivered, markConsumed };
}

module.exports = { createMessageBus, ensureMessageSchema, rowToMessage, KINDS, STATUSES };
