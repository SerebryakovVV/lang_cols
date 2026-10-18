CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    russian TEXT NOT NULL DEFAULT '' CHECK (length(russian) <= 500),
    english TEXT NOT NULL DEFAULT '' CHECK (length(english) <= 500),
    german TEXT NOT NULL DEFAULT '' CHECK (length(german) <= 500),
    spanish TEXT NOT NULL DEFAULT '' CHECK (length(spanish) <= 500),
    french TEXT NOT NULL DEFAULT '' CHECK (length(french) <= 500),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
        length(russian) + length(english) + length(german)
        + length(spanish) + length(french) > 0
    )
);

PRAGMA user_version = 1;
