"""Run fixed-sentence regressions through the real offline worker process.

The book-word anchors catch broken models and meaningless output for these five
known sentences. They are not a comprehensive translation accuracy assessment
or validation rules for arbitrary user text.
"""

from __future__ import annotations

from collections import deque
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
from typing import Any, TextIO

ROOT = Path(__file__).resolve().parent.parent
REQUEST_TIMEOUT_SECONDS = 120
MAX_TRANSLATED_CHARACTERS = 500
MAX_DISPLAY_CHARACTERS = 200
LANGUAGE_FIELDS = {
    "ru": "russian",
    "en": "english",
    "de": "german",
    "es": "spanish",
    "fr": "french",
}
SENTENCES = {
    "en": "I like reading books.",
    "ru": "  Я люблю читать книги.  ",
    "de": "Ich lese gern Bücher.",
    "es": "Me gusta leer libros.",
    "fr": "J’aime lire des livres.",
}
BOOK_ROOTS = {
    "russian": "книг",
    "english": "book",
    "german": "büch",
    "spanish": "libr",
    "french": "livr",
}
REPEATED_WORD = re.compile(r"\b(\w+)\b(?:\s+\1\b){4,}", re.IGNORECASE)
REPEATED_FRAGMENT = re.compile(r"(.{2,40})\1{5,}", re.DOTALL | re.IGNORECASE)


def validate_translation(data: dict, source: str, original: str) -> None:
    expected_fields = set(LANGUAGE_FIELDS.values())
    if set(data) != expected_fields:
        raise RuntimeError(f"{source}: expected all five language fields, received {sorted(data)}.")
    source_field = LANGUAGE_FIELDS[source]
    if data[source_field] != original:
        raise RuntimeError(f"{source}: original source text was changed.")
    for field, translated in data.items():
        if not isinstance(translated, str) or not translated.strip():
            raise RuntimeError(f"{source}: {field} translation is empty or invalid.")
        if field == source_field:
            continue
        if len(translated) > MAX_TRANSLATED_CHARACTERS:
            raise RuntimeError(
                f"{source}: {field} translation exceeds the app's {MAX_TRANSLATED_CHARACTERS}-character limit ({len(translated)} characters)."
            )
        if REPEATED_WORD.search(translated) or REPEATED_FRAGMENT.search(translated):
            raise RuntimeError(f"{source}: {field} translation contains pathological repetition.")
        if BOOK_ROOTS[field] not in translated.casefold():
            raise RuntimeError(f"{source}: {field} translation lost the expected book-word anchor for this fixed sentence.")


def display_text(text: str) -> str:
    return text if len(text) <= MAX_DISPLAY_CHARACTERS else text[:MAX_DISPLAY_CHARACTERS - 1] + "…"


def read_stdout(stream: TextIO, lines: queue.Queue[str | None]) -> None:
    try:
        for line in stream:
            lines.put(line)
    finally:
        lines.put(None)


def read_stderr(stream: TextIO, diagnostics: deque[str]) -> None:
    for line in stream:
        diagnostics.append(line.rstrip())


def request(process: subprocess.Popen[str], lines: queue.Queue[str | None], payload: dict[str, Any]) -> tuple[dict, float]:
    start = time.perf_counter()
    if process.stdin is None:
        raise RuntimeError("The worker input pipe is unavailable.")
    process.stdin.write(json.dumps(payload, ensure_ascii=True) + "\n")
    process.stdin.flush()
    try:
        line = lines.get(timeout=REQUEST_TIMEOUT_SECONDS)
    except queue.Empty as error:
        raise TimeoutError(f"Worker timed out after {REQUEST_TIMEOUT_SECONDS} seconds.") from error
    if line is None:
        raise RuntimeError(f"Worker closed its output pipe (exit code {process.poll()}).")
    try:
        response = json.loads(line)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"Worker returned a non-JSON protocol line: {line[:200]!r}") from error
    if not isinstance(response, dict) or response.get("ok") is not True:
        message = response.get("error", "Malformed worker response.") if isinstance(response, dict) else "Malformed worker response."
        raise RuntimeError(str(message))
    data = response.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("Worker response is missing its data object.")
    return data, time.perf_counter() - start


def stop_worker(process: subprocess.Popen[str]) -> None:
    if process.stdin is not None:
        try:
            process.stdin.close()
        except OSError:
            pass
    if process.poll() is None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
    else:
        process.wait()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    python = ROOT / ".argos" / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        print("Offline runtime is missing. Run npm run setup:translation first.", file=sys.stderr)
        return 1
    environment = os.environ.copy()
    environment.update(PYTHONUTF8="1", PYTHONNOUSERSITE="1")
    # Run the actual entry point: it applies its socket guard before Argos loads.
    # This checker does not import Argos, change network settings, or access SQLite.
    process = subprocess.Popen(
        [str(python), "-u", str(ROOT / "scripts" / "translation_worker.py")],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    lines: queue.Queue[str | None] = queue.Queue()
    diagnostics: deque[str] = deque(maxlen=20)
    assert process.stdout is not None and process.stderr is not None
    stdout_reader = threading.Thread(target=read_stdout, args=(process.stdout, lines), daemon=True)
    stderr_reader = threading.Thread(target=read_stderr, args=(process.stderr, diagnostics), daemon=True)
    stdout_reader.start()
    stderr_reader.start()
    failed = False
    try:
        status, elapsed = request(process, lines, {"action": "status"})
        if status.get("ready") is not True:
            raise RuntimeError("The offline worker did not report that it is ready.")
        print(f"Offline worker ready in {elapsed:.2f}s; network connections blocked by worker.", flush=True)
        for source, text in SENTENCES.items():
            data, elapsed = request(process, lines, {"action": "translate", "sourceLanguage": source, "text": text})
            validate_translation(data, source, text)
            preview = {field: display_text(translated) for field, translated in data.items()}
            print(f"{source} ({elapsed:.2f}s): {json.dumps(preview, ensure_ascii=False)}", flush=True)
        print("Passed fixed-sentence regressions: five sources, 20 translations with book-word anchors, exact source preservation.", flush=True)
        print("These checks detect broken outputs; they do not grade general translation accuracy.", flush=True)
    except (OSError, RuntimeError, TimeoutError) as error:
        failed = True
        print(f"Offline translation check failed: {display_text(str(error))}", file=sys.stderr)
    finally:
        # EOF normally stops the worker; force termination after a bounded grace
        # period if model inference is hung, then reap the child in either case.
        stop_worker(process)
        stdout_reader.join(timeout=1)
        stderr_reader.join(timeout=1)
        process.stdout.close()
        process.stderr.close()
        if failed:
            for line in list(diagnostics)[-5:]:
                print(f"worker stderr: {display_text(line)}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
