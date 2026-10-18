mod database;
mod translation;

use database::{Database, Entry, NewEntry};
use tauri::{Manager, State};
use translation::{TranslationService, TranslationStatus, Translations};

#[tauri::command]
fn list_entries(database: State<'_, Database>) -> Result<Vec<Entry>, String> {
    database.list_entries()
}

#[tauri::command]
fn add_entry(entry: NewEntry, database: State<'_, Database>) -> Result<Entry, String> {
    database.add_entry(entry)
}

#[tauri::command]
async fn translation_status(app: tauri::AppHandle) -> Result<TranslationStatus, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<TranslationService>().status())
        .await
        .map_err(|error| format!("Could not check offline translation: {error}"))
}

#[tauri::command]
async fn translate_text(
    text: String,
    source_language: String,
    app: tauri::AppHandle,
) -> Result<Translations, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<TranslationService>()
            .translate(text, source_language)
    })
    .await
    .map_err(|error| format!("Could not run offline translation: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // This personal app deliberately keeps its data in the project root.
            let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("src-tauri must have a project root")
                .to_path_buf();
            let database_path = project_root.join("vocabulary.sqlite3");
            let database = Database::open(&database_path).map_err(std::io::Error::other)?;
            app.manage(database);
            app.manage(TranslationService::new(project_root));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_entries,
            add_entry,
            translation_status,
            translate_text
        ])
        .build(tauri::generate_context!())
        .expect("error while building vocabulary app")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<TranslationService>().shutdown();
            }
        });
}
