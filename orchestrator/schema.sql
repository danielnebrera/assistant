-- Bus de mensajes del assistant (comunicación entre Estratega y agentes de módulo).
-- BD propia del assistant (factory_assistant): tablas assistant_* SIN prefijo.
-- Lo crea también, idempotentemente, orchestrator/message_bus.js → ensureMessageSchema().

CREATE TABLE IF NOT EXISTS assistant_message (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
