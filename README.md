# Lang Cols

A personal, local vocabulary notebook built with React, TypeScript, Tauri 2, and SQLite. Each row connects the same word or short sentence in Russian, English, German, Spanish, and French.

## Run

```powershell
npm install
npm run tauri dev
```

Requires Node.js and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/), including Rust and Microsoft C++ Build Tools. Offline translation also requires Python 3.10–3.13. `npm run dev` opens only the frontend; translating and saving require the Tauri desktop app.

The Argos runtime and models have been installed locally for this checkout. On a new machine, run the one-time setup before launching:

```powershell
npm run setup:translation
```

Setup downloads the pinned Python dependencies, eight translation models, and five sentence detectors into `.argos/`. It uses a private virtual environment and CPU inference. Translation itself works offline and makes no network requests. The app starts its hidden Python worker automatically; no separate server or API key is needed.

This installation occupies about 3.1 GiB including models, the Python environment, and dependency caches. CPU decoding uses float32: the Spanish-to-English model produced repetitive output with int8 on this setup, so correctness takes priority over that optimization.

## Current features

- Five fixed language columns, newest entries first.
- A translation block above the word form. Type in any of its five fields; after a 500 ms typing pause, Argos fills the other four. The most recently edited field becomes the source.
- “Use in word form” copies the completed translations for review. Existing unsaved text requires an explicit “Replace draft” action. Copying does not save anything; “Save word” does.
- Add words or short sentences in any combination of languages. At least one field is required; each field allows up to 500 characters. Leading and trailing whitespace is removed.
- Search across all five languages. Missing translations appear as a dash.
- SQLite persistence and local Argos translation with no account or cloud service.

The translation block and word form are independent: you can correct the suggested translations in the form before saving. Older translation responses cannot overwrite new input. Clearing the source clears the translation block, and only the latest waiting input is processed when the engine is busy.

Translation models route between Russian, German, Spanish, and French through English. Quality can vary, particularly for ambiguous single words; a short sentence usually gives more context. Spaced repetition and editing/deleting saved entries are future features.

## Database

The database is `vocabulary.sqlite3` at the project root:

```text
C:\Users\sereb\main_files\coding\lang_cols\vocabulary.sqlite3
```

The Rust app creates the file/schema if needed. The database location is resolved from the project directory at compile time, deliberately keeping both development and packaged builds pointed at this location for this personal app. If you relocate the project, rebuild the app and copy the existing database into the new project root. It does not depend on the terminal's working directory.

`src-tauri/src/schema.sql` defines the `entries` table and schema version. Each entry has an ID, five text fields, and a UTC creation timestamp. SQL writes are parameterized, and the database is excluded from version control to keep personal vocabulary private. To back up your words, close the app and copy `vocabulary.sqlite3`.

## Checks and builds

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo fmt --manifest-path src-tauri/Cargo.toml --check
python -m unittest discover -s scripts -p "test_*.py"
python scripts/check_translation.py
cargo test --manifest-path src-tauri/Cargo.toml --lib offline_translation_service_smoke -- --ignored
npm run tauri build
```

The Rust tests verify real SQLite persistence and the translation worker protocol/validation. Component tests cover typing races, IME composition, transfer safeguards, and save errors without opening a browser or touching the database. Python tests cover the worker protocol; the real-model checker translates from all five source languages without saving vocabulary.

The ignored Rust smoke test requires the installed local runtime and models. It verifies the actual Rust-to-Python service, translation of a Russian sentence, and shutdown without opening the UI or touching SQLite.

See [translation options](docs/translation-options.md) for the earlier provider overview. The app now uses its local Argos option.

## Translation troubleshooting

If models are missing, rerun `npm run setup:translation`, then use “Try again” in the translation block. Setup skips already-installed models. The first translation loads model weights and can be slower than later requests; the UI remains editable while it works. Shortening the sentence can help if a request times out.

Models, dependency caches, and diagnostic logs are inside `.argos/`, which is excluded from version control. `scripts/requirements-translation.txt` pins the resolved dependency versions; `.argos/python-packages.txt` records the installed environment and `.argos/models-manifest.json` records the model versions. Translation does not change the database schema. Before this integration, a source/database snapshot was saved in `.backups/`.

As with the database, the Python runtime and worker script are resolved from the project root at compile time. This installation is intended for your personal app on this computer; a portable app installer would need to bundle that runtime separately.
