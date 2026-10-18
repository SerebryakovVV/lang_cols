use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CHARACTERS: usize = 500;
const SETUP_HINT: &str = "Run npm run setup:translation in the project folder.";

#[derive(Debug, Deserialize, Serialize)]
pub struct TranslationStatus {
    pub ready: bool,
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct Translations {
    pub russian: String,
    pub english: String,
    pub german: String,
    pub spanish: String,
    pub french: String,
}

pub struct TranslationService {
    project_root: PathBuf,
    worker: Mutex<Option<Worker>>,
    active_child: Mutex<Option<Arc<Mutex<Child>>>>,
    stopping: AtomicBool,
}

impl TranslationService {
    pub fn new(project_root: PathBuf) -> Self {
        Self {
            project_root,
            worker: Mutex::new(None),
            active_child: Mutex::new(None),
            stopping: AtomicBool::new(false),
        }
    }

    pub fn status(&self) -> TranslationStatus {
        self.request(json!({ "action": "status" }))
            .unwrap_or_else(|message| TranslationStatus {
                ready: false,
                message,
            })
    }

    pub fn translate(&self, text: String, source_language: String) -> Result<Translations, String> {
        validate_request(&text, &source_language)?;
        self.request(json!({
            "action": "translate",
            "text": text,
            "sourceLanguage": source_language,
        }))
    }

    fn request<T: DeserializeOwned>(&self, request: Value) -> Result<T, String> {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "Offline translation is unavailable. Restart the app.".to_string())?;
        if self.stopping.load(Ordering::Acquire) {
            return Err("Offline translation is shutting down.".to_string());
        }
        if worker.is_none() {
            *worker = Some(Worker::start(&self.project_root)?);
            let child = Arc::clone(&worker.as_ref().expect("worker was initialized").child);
            *self
                .active_child
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = Some(child);
            // Exit can arrive while Python is being spawned, before its handle
            // is published. Catch that race before waiting for a response.
            if self.stopping.load(Ordering::Acquire) {
                self.stop_active_child();
                *worker = None;
                return Err("Offline translation is shutting down.".to_string());
            }
        }
        let result = worker
            .as_mut()
            .expect("the worker was initialized above")
            .request(request);
        if result.is_err() {
            // Drop kills a failed or timed-out process; the next request starts cleanly.
            *worker = None;
            *self
                .active_child
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = None;
        }
        result
    }

    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.stop_active_child();
    }

    fn stop_active_child(&self) {
        // This lock is separate from request I/O: killing Python closes stdout
        // and immediately wakes a request waiting for its response.
        let active_child = self
            .active_child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        if let Some(child) = active_child {
            stop_child(&child);
        }
    }
}

struct Worker {
    child: Arc<Mutex<Child>>,
    input: ChildStdin,
    output: mpsc::Receiver<Result<String, String>>,
}

impl Worker {
    fn start(project_root: &Path) -> Result<Self, String> {
        let storage = project_root.join(".argos");
        let python = if cfg!(target_os = "windows") {
            storage.join("venv/Scripts/python.exe")
        } else {
            storage.join("venv/bin/python")
        };
        if !python.is_file() {
            return Err(format!(
                "Offline translation is not installed. {SETUP_HINT}"
            ));
        }
        let script = project_root.join("scripts/translation_worker.py");
        if !script.is_file() {
            return Err("The translation worker script is missing from the project.".to_string());
        }
        let error_log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(storage.join("worker.log"))
            .map_err(|error| format!("Could not open the translation log: {error}"))?;
        let mut command = Command::new(python);
        command
            .arg("-u")
            .arg(script)
            .current_dir(project_root)
            .env("PYTHONUTF8", "1")
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(error_log));
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW keeps the private Python subprocess invisible.
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| {
            format!("Could not start offline translation: {error}. {SETUP_HINT}")
        })?;
        let input = child.stdin.take().expect("stdin was configured as a pipe");
        let output = child
            .stdout
            .take()
            .expect("stdout was configured as a pipe");
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let response = line
                    .map_err(|error| format!("Could not read the translation response: {error}"));
                if sender.send(response).is_err() {
                    return;
                }
            }
            let _ = sender.send(Err(
                "Offline translation stopped. Check .argos/worker.log and try again.".to_string(),
            ));
        });
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            input,
            output: receiver,
        })
    }

    fn request<T: DeserializeOwned>(&mut self, request: Value) -> Result<T, String> {
        if self
            .child
            .lock()
            .map_err(|_| "Could not access the translation process.".to_string())?
            .try_wait()
            .map_err(|error| format!("Could not check the translation worker: {error}"))?
            .is_some()
        {
            return Err(
                "Offline translation stopped. Check .argos/worker.log and try again.".to_string(),
            );
        }
        let mut line = serde_json::to_vec(&request)
            .map_err(|error| format!("Could not prepare the translation request: {error}"))?;
        line.push(b'\n');
        self.input
            .write_all(&line)
            .and_then(|_| self.input.flush())
            .map_err(|error| format!("Could not send the translation request: {error}"))?;
        let response =
            self.output
                .recv_timeout(REQUEST_TIMEOUT)
                .map_err(|error| match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        "Offline translation took too long. Try a shorter sentence or try again."
                            .to_string()
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        "Offline translation stopped. Check .argos/worker.log and try again."
                            .to_string()
                    }
                })??;
        parse_response(&response)
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        stop_child(&self.child);
    }
}

fn stop_child(child: &Mutex<Child>) {
    let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Deserialize)]
struct Response<T> {
    ok: bool,
    data: Option<T>,
    error: Option<String>,
}

fn parse_response<T: DeserializeOwned>(line: &str) -> Result<T, String> {
    let response: Response<T> = serde_json::from_str(line)
        .map_err(|_| "Offline translation returned an invalid response. Try again.".to_string())?;
    if response.ok {
        response
            .data
            .ok_or_else(|| "Offline translation returned no result. Try again.".to_string())
    } else {
        Err(response
            .error
            .unwrap_or_else(|| "Offline translation failed. Try again.".to_string()))
    }
}

fn validate_request(text: &str, source_language: &str) -> Result<(), String> {
    if !matches!(source_language, "ru" | "en" | "de" | "es" | "fr") {
        return Err(
            "Choose Russian, English, German, Spanish, or French as the source language."
                .to_string(),
        );
    }
    if text.trim().is_empty() {
        return Err("Enter a word or sentence to translate.".to_string());
    }
    if text.chars().count() > MAX_CHARACTERS {
        return Err(format!(
            "Text must be {MAX_CHARACTERS} characters or fewer."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_accepts_only_supported_sources_and_nonblank_text() {
        for source in ["ru", "en", "de", "es", "fr"] {
            assert!(validate_request("  A sentence.  ", source).is_ok());
        }
        assert!(validate_request("A sentence.", "ja").is_err());
        assert!(validate_request("\t\n\u{2003}", "en").is_err());
    }

    #[test]
    fn request_limit_counts_unicode_characters_including_the_original_whitespace() {
        assert!(validate_request(&"я".repeat(500), "ru").is_ok());
        assert!(validate_request(&"🙂".repeat(500), "en").is_ok());
        assert!(validate_request(&format!(" {}", "я".repeat(500)), "ru").is_err());
    }

    #[test]
    fn protocol_preserves_source_text_and_decodes_escaped_unicode_and_newlines() {
        let expected = Translations {
            russian: "  Привет!\nКофе?  ".into(),
            english: "Hello!\nCoffee?".into(),
            german: "Hallo!".into(),
            spanish: "¡Hola!".into(),
            french: "L'été".into(),
        };
        let response = json!({ "ok": true, "data": expected });
        assert_eq!(
            parse_response::<Translations>(&response.to_string()).unwrap(),
            expected
        );
    }

    #[test]
    fn protocol_surfaces_worker_errors_and_rejects_missing_or_malformed_results() {
        let error =
            parse_response::<TranslationStatus>(r#"{"ok":false,"error":"Missing model ru → en"}"#)
                .unwrap_err();
        assert_eq!(error, "Missing model ru → en");
        assert!(parse_response::<TranslationStatus>("ordinary stdout log").is_err());
        assert!(parse_response::<TranslationStatus>(r#"{"ok":true}"#).is_err());
        assert!(
            parse_response::<Translations>(r#"{"ok":true,"data":{"english":"hello"}}"#).is_err()
        );
    }

    #[test]
    fn missing_private_environment_returns_a_setup_instruction() {
        let service =
            TranslationService::new(PathBuf::from("a-folder-that-has-no-argos-environment"));
        let status = service.status();
        assert!(!status.ready);
        assert!(status.message.contains("npm run setup:translation"));
    }

    #[test]
    fn shutdown_kills_the_child_without_waiting_for_the_request_mutex() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "translation::tests::shutdown_child_fixture"])
            .env("LANG_COLS_SHUTDOWN_CHILD", "1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child = Arc::new(Mutex::new(child));
        let service = Arc::new(TranslationService::new(PathBuf::new()));
        *service.active_child.lock().unwrap() = Some(Arc::clone(&child));
        let (ready_sender, ready_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let waiting_service = Arc::clone(&service);
        let waiting_request = std::thread::spawn(move || {
            let _request_lock = waiting_service.worker.lock().unwrap();
            ready_sender.send(()).unwrap();
            release_receiver.recv().unwrap();
        });
        ready_receiver.recv().unwrap();
        let (done_sender, done_receiver) = mpsc::channel();
        let closing_service = Arc::clone(&service);
        let closing = std::thread::spawn(move || {
            closing_service.shutdown();
            done_sender.send(()).unwrap();
        });
        let stopped_promptly = done_receiver.recv_timeout(Duration::from_secs(2)).is_ok();
        // Always release the fake request, including when the assertion fails.
        release_sender.send(()).unwrap();
        waiting_request.join().unwrap();
        closing.join().unwrap();
        assert!(
            stopped_promptly,
            "shutdown waited for the in-flight request lock"
        );
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(!service.status().ready);
    }

    #[test]
    fn shutdown_child_fixture() {
        if std::env::var_os("LANG_COLS_SHUTDOWN_CHILD").is_some() {
            std::thread::sleep(Duration::from_secs(30));
        }
    }

    #[test]
    #[ignore = "requires the project-local Argos environment and all models; never downloads anything"]
    fn offline_translation_service_smoke() {
        let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let service = TranslationService::new(project_root);
        let status = service.status();
        assert!(status.ready, "{}", status.message);
        let original = "  Я учу языки каждый день.  ";
        let translations = service
            .translate(original.to_string(), "ru".to_string())
            .unwrap();
        assert_eq!(translations.russian, original);
        for value in [
            &translations.russian,
            &translations.english,
            &translations.german,
            &translations.spanish,
            &translations.french,
        ] {
            assert!(!value.trim().is_empty());
        }
        service.shutdown();
        let error = service
            .translate("Привет!".to_string(), "ru".to_string())
            .unwrap_err();
        assert!(error.contains("shutting down"));
        let stopped_status = service.status();
        assert!(!stopped_status.ready);
        assert!(stopped_status.message.contains("shutting down"));
    }
}
