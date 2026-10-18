use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

const SCHEMA: &str = include_str!("schema.sql");
const ENTRY_COLUMNS: &str = "id, russian, english, german, spanish, french, created_at";
const MAX_CHARACTERS: usize = 500;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Entry {
    pub id: i64,
    pub russian: String,
    pub english: String,
    pub german: String,
    pub spanish: String,
    pub french: String,
    pub created_at: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct NewEntry {
    pub russian: String,
    pub english: String,
    pub german: String,
    pub spanish: String,
    pub french: String,
}

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path)
            .map_err(|error| format!("Could not open database at {}: {error}", path.display()))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("Could not configure the database: {error}"))?;
        connection
            .execute_batch(SCHEMA)
            .map_err(|error| format!("Could not initialize the vocabulary database: {error}"))?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn connection(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "The database is unavailable. Please restart the app.".to_string())
    }

    pub fn list_entries(&self) -> Result<Vec<Entry>, String> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {ENTRY_COLUMNS} FROM entries ORDER BY id DESC"
            ))
            .map_err(|error| format!("Could not load vocabulary: {error}"))?;
        statement
            .query_map([], entry_from_row)
            .and_then(|rows| rows.collect())
            .map_err(|error| format!("Could not read vocabulary: {error}"))
    }

    pub fn add_entry(&self, entry: NewEntry) -> Result<Entry, String> {
        let entry = validate_entry(entry)?;
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO entries (russian, english, german, spanish, french)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    entry.russian,
                    entry.english,
                    entry.german,
                    entry.spanish,
                    entry.french
                ],
            )
            .map_err(|error| format!("Could not save this word: {error}"))?;
        connection
            .query_row(
                &format!("SELECT {ENTRY_COLUMNS} FROM entries WHERE id = ?1"),
                [connection.last_insert_rowid()],
                entry_from_row,
            )
            .map_err(|error| format!("The word was saved but could not be read back: {error}"))
    }
}

fn entry_from_row(row: &Row<'_>) -> rusqlite::Result<Entry> {
    Ok(Entry {
        id: row.get(0)?,
        russian: row.get(1)?,
        english: row.get(2)?,
        german: row.get(3)?,
        spanish: row.get(4)?,
        french: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn validate_entry(mut entry: NewEntry) -> Result<NewEntry, String> {
    let fields = [
        ("Russian", &mut entry.russian),
        ("English", &mut entry.english),
        ("German", &mut entry.german),
        ("Spanish", &mut entry.spanish),
        ("French", &mut entry.french),
    ];
    let mut has_content = false;
    for (language, value) in fields {
        *value = value.trim().to_string();
        if value.chars().count() > MAX_CHARACTERS {
            return Err(format!(
                "{language} must be {MAX_CHARACTERS} characters or fewer."
            ));
        }
        has_content |= !value.is_empty();
    }
    if !has_content {
        return Err("Enter a word in at least one language.".to_string());
    }
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, time::SystemTime};

    struct TestDatabaseFile(PathBuf);

    impl TestDatabaseFile {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(
                std::env::temp_dir()
                    .join(format!("lang-cols-{}-{unique}.sqlite3", std::process::id())),
            )
        }
    }

    impl Drop for TestDatabaseFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn unicode_quotes_and_newlines_survive_reopening() {
        let file = TestDatabaseFile::new();
        let saved = {
            let database = Database::open(&file.0).unwrap();
            database
                .add_entry(NewEntry {
                    russian: "  Мне нравится \"кофе\"\nи чай.  ".into(),
                    english: "  I don't know; DROP TABLE entries; --  ".into(),
                    german: "  Straße & Grüße  ".into(),
                    spanish: "  ¿Qué tal? ¡Mañana!  ".into(),
                    french: "  L'été, ça va.  ".into(),
                })
                .unwrap()
        };
        assert_eq!(saved.russian, "Мне нравится \"кофе\"\nи чай.");
        assert_eq!(saved.english, "I don't know; DROP TABLE entries; --");
        assert_eq!(saved.german, "Straße & Grüße");
        assert_eq!(saved.spanish, "¿Qué tal? ¡Mañana!");
        assert_eq!(saved.french, "L'été, ça va.");
        assert!(saved.created_at.ends_with('Z'));
        let reopened = Database::open(&file.0).unwrap();
        assert_eq!(reopened.list_entries().unwrap(), vec![saved]);
    }

    #[test]
    fn entries_are_newest_first_and_partial_rows_are_allowed() {
        let file = TestDatabaseFile::new();
        let database = Database::open(&file.0).unwrap();
        assert!(database.list_entries().unwrap().is_empty());
        let first = database
            .add_entry(NewEntry {
                english: "first".into(),
                ..Default::default()
            })
            .unwrap();
        let second = database
            .add_entry(NewEntry {
                russian: "второй".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(database.list_entries().unwrap(), vec![second, first]);
    }

    #[test]
    fn whitespace_only_rows_are_rejected_without_writing() {
        let file = TestDatabaseFile::new();
        let database = Database::open(&file.0).unwrap();
        let error = database
            .add_entry(NewEntry {
                russian: " \t\n".into(),
                english: "\u{2003}".into(),
                german: "\r".into(),
                spanish: "\u{00a0}".into(),
                french: " ".into(),
            })
            .unwrap_err();
        assert_eq!(error, "Enter a word in at least one language.");
        assert!(database.list_entries().unwrap().is_empty());
    }

    #[test]
    fn every_language_has_a_character_limit() {
        let file = TestDatabaseFile::new();
        let database = Database::open(&file.0).unwrap();
        for language in ["Russian", "English", "German", "Spanish", "French"] {
            let mut entry = NewEntry::default();
            let value = "я".repeat(MAX_CHARACTERS + 1);
            match language {
                "Russian" => entry.russian = value,
                "English" => entry.english = value,
                "German" => entry.german = value,
                "Spanish" => entry.spanish = value,
                "French" => entry.french = value,
                _ => unreachable!(),
            }
            assert_eq!(
                database.add_entry(entry).unwrap_err(),
                format!("{language} must be {MAX_CHARACTERS} characters or fewer.")
            );
        }
        assert!(database.list_entries().unwrap().is_empty());
        let value = "я".repeat(MAX_CHARACTERS);
        let saved = database
            .add_entry(NewEntry {
                russian: format!("  {value}  "),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(saved.russian, value);
    }
}
