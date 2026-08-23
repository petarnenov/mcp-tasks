CREATE TABLE tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'TODO',
    priority    TEXT    NOT NULL DEFAULT 'MEDIUM',
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
