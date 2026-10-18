"""Persistent, offline Argos Translate worker; stdout is a JSON-lines protocol."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sys
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LANGUAGE_FIELDS = {
    "ru": "russian",
    "en": "english",
    "de": "german",
    "es": "spanish",
    "fr": "french",
}
MODEL_VERSIONS = {
    ("en", "ru"): "1.9",
    ("ru", "en"): "1.9",
    ("en", "de"): "1.3",
    ("de", "en"): "1.3",
    ("en", "es"): "1.0",
    ("es", "en"): "1.9",
    ("en", "fr"): "1.9",
    ("fr", "en"): "1.9",
}
MAX_CHARACTERS = 500


def configure_environment(root: Path = ROOT) -> Path:
    """Set paths before Argos, Stanza, Torch, or MiniSBD can import."""
    storage = root / ".argos"
    settings = {
        "ARGOS_PACKAGES_DIR": storage / "models",
        "XDG_DATA_HOME": storage / "data",
        "XDG_CONFIG_HOME": storage / "config",
        "XDG_CACHE_HOME": storage / "cache",
        "STANZA_RESOURCES_DIR": storage / "stanza",
        "TORCH_HOME": storage / "cache" / "torch",
        "HF_HOME": storage / "cache" / "huggingface",
        "PIP_CACHE_DIR": storage / "cache" / "pip",
    }
    for key, value in settings.items():
        os.environ[key] = str(value)
    os.environ.update(
        ARGOS_DEVICE_TYPE="cpu",
        # The pinned ES→EN model produces repeated garbage under int8 on this
        # Windows CPU. Float32 gives correct output and is the stable baseline.
        ARGOS_COMPUTE_TYPE="float32",
        ARGOS_CHUNK_TYPE="MINISBD",
        ARGOS_MODEL_PROVIDER="OPENNMT",
        ARGOS_DEBUG="0",
        ARGOS_INTER_THREADS="1",
        ARGOS_INTRA_THREADS="4",
        PYTHONNOUSERSITE="1",
        HF_HUB_OFFLINE="1",
        TOKENIZERS_PARALLELISM="false",
    )
    return storage


def prohibit_network() -> None:
    """Missing local files must produce an error, never trigger a download."""
    def offline(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("Translation runs offline. Run npm run setup:translation to install missing models.")

    socket.create_connection = offline
    socket.socket.connect = offline
    socket.socket.connect_ex = offline


def validate_request(text: Any, source: Any) -> str:
    if not isinstance(source, str) or source not in LANGUAGE_FIELDS:
        raise ValueError("Choose Russian, English, German, Spanish, or French as the source language.")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Enter a word or sentence to translate.")
    if len(text) > MAX_CHARACTERS:
        raise ValueError(f"Text must be {MAX_CHARACTERS} characters or fewer.")
    return text


class TranslationEngine:
    def __init__(self) -> None:
        storage = configure_environment()
        from argostranslate import package, translate

        installed = {(model.from_code, model.to_code): model for model in package.get_installed_packages()}
        missing = [
            f"{source} → {target} ({version})"
            for (source, target), version in MODEL_VERSIONS.items()
            if (source, target) not in installed
            or installed[source, target].package_version != version
        ]
        sbd_directory = storage / "data" / "argos-translate" / "minisbd"
        missing.extend(
            f"{code} sentence detector"
            for code in LANGUAGE_FIELDS
            if not (sbd_directory / f"{code}.onnx").is_file()
        )
        if missing:
            raise RuntimeError("Offline models are missing: " + ", ".join(missing) + ". Run npm run setup:translation.")

        translate.get_installed_languages.cache_clear()
        languages = {language.code: language for language in translate.get_installed_languages()}
        self.routes = {}
        for source in LANGUAGE_FIELDS:
            for target in LANGUAGE_FIELDS:
                if source != target:
                    route = languages[source].get_translation(languages[target])
                    if route is None:
                        raise RuntimeError(f"The offline translation route {source} → {target} is missing.")
                    self.routes[source, target] = route

    def translate(self, text: str, source: str) -> dict[str, str]:
        validate_request(text, source)
        result = {}
        for target, field in LANGUAGE_FIELDS.items():
            result[field] = text if target == source else self.routes[source, target].translate(text)
            if not result[field].strip():
                raise RuntimeError(f"The offline model returned an empty {field} translation. Try a longer phrase.")
        return result


def serve(input_stream: Any, output_stream: Any) -> None:
    engine = None
    for line in input_stream:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("The request must be a JSON object.")
            action = request.get("action")
            if action not in ("status", "translate"):
                raise ValueError("Unknown translation worker action.")
            if action == "translate":
                validate_request(request.get("text"), request.get("sourceLanguage"))
            if engine is None:
                engine = TranslationEngine()
            data = (
                {"ready": True, "message": "Offline translation is ready."}
                if action == "status"
                else engine.translate(request["text"], request["sourceLanguage"])
            )
            response = {"ok": True, "data": data}
        except Exception as error:
            # Deliberately omit request text and tracebacks from diagnostics.
            message = str(error)
            print(json.dumps({"event": "translation_error", "type": type(error).__name__, "message": message}, ensure_ascii=True), file=sys.stderr, flush=True)
            response = {"ok": False, "error": message}
        output_stream.write(json.dumps(response, ensure_ascii=True) + "\n")
        output_stream.flush()


def main() -> None:
    configure_environment()
    # Reserve the original pipe, then redirect both Python and native-library
    # stdout to stderr so unexpected library output cannot corrupt the protocol.
    output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    prohibit_network()
    try:
        serve(sys.stdin, output)
    finally:
        output.close()


if __name__ == "__main__":
    main()
