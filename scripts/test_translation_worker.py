"""Dependency-free tests for the offline worker's validation and pipe protocol."""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

import translation_worker as worker
import check_translation as checker

REAL_ENGINE = worker.TranslationEngine


class RequestValidationTests(unittest.TestCase):
    def test_accepts_each_source_and_preserves_unicode_and_whitespace(self) -> None:
        text = "  café / книги / Bücher  \n"
        for source in worker.LANGUAGE_FIELDS:
            with self.subTest(source=source):
                self.assertEqual(worker.validate_request(text, source), text)

    def test_limit_counts_characters_rather_than_utf8_bytes(self) -> None:
        text = "я" * worker.MAX_CHARACTERS
        self.assertEqual(worker.validate_request(text, "ru"), text)
        with self.assertRaisesRegex(ValueError, "characters or fewer"):
            worker.validate_request(text + "я", "ru")

    def test_rejects_missing_blank_and_non_string_text(self) -> None:
        for text in (None, "", " \t\n", 42, False, [], {}):
            with self.subTest(text=text):
                with self.assertRaisesRegex(ValueError, "Enter a word or sentence"):
                    worker.validate_request(text, "en")

    def test_rejects_unknown_and_non_string_sources(self) -> None:
        for source in (None, "", "EN", "it", 1, False, [], {}):
            with self.subTest(source=source):
                with self.assertRaisesRegex(ValueError, "source language"):
                    worker.validate_request("hello", source)


class EnvironmentConfigurationTests(unittest.TestCase):
    def test_local_cpu_worker_uses_float32_even_with_inherited_int8_setting(self) -> None:
        original_environment = os.environ.copy()
        with tempfile.TemporaryDirectory(prefix="lang-cols-worker-test-") as temporary:
            root = Path(temporary)
            with mock.patch.dict(os.environ, {"ARGOS_COMPUTE_TYPE": "int8", "ARGOS_DEVICE_TYPE": "cuda"}):
                storage = worker.configure_environment(root)
                self.assertEqual(os.environ["ARGOS_DEVICE_TYPE"], "cpu")
                # The Spanish 1.9 model can loop with int8; preserving float32
                # prevents that observed regression in the production worker.
                self.assertEqual(os.environ["ARGOS_COMPUTE_TYPE"], "float32")
                self.assertEqual(storage, root / ".argos")
                self.assertEqual(os.environ["ARGOS_PACKAGES_DIR"], str(storage / "models"))
        self.assertEqual(dict(os.environ), original_environment)


class RouteStub:
    def __init__(self, source: str, target: str, result: str | None = None) -> None:
        self.source = source
        self.target = target
        self.result = result
        self.calls: list[str] = []

    def translate(self, text: str) -> str:
        self.calls.append(text)
        return self.result if self.result is not None else f"{self.source} → {self.target}: {text.strip()}"


def engine_with_stub_routes(source: str) -> worker.TranslationEngine:
    # Exercise the real translate method without importing or loading Argos.
    engine = REAL_ENGINE.__new__(REAL_ENGINE)
    engine.routes = {
        (source, target): RouteStub(source, target)
        for target in worker.LANGUAGE_FIELDS
        if target != source
    }
    return engine


class EngineTranslationTests(unittest.TestCase):
    def test_each_output_uses_original_source_and_source_field_is_unchanged(self) -> None:
        text = "  J’aime lire des livres.  \n"
        for source, source_field in worker.LANGUAGE_FIELDS.items():
            with self.subTest(source=source):
                engine = engine_with_stub_routes(source)
                result = engine.translate(text, source)
                self.assertEqual(set(result), set(worker.LANGUAGE_FIELDS.values()))
                self.assertEqual(result[source_field], text)
                for target, field in worker.LANGUAGE_FIELDS.items():
                    if target == source:
                        continue
                    route = engine.routes[source, target]
                    self.assertEqual(route.calls, [text])
                    self.assertEqual(result[field], f"{source} → {target}: {text.strip()}")

    def test_blank_translation_is_an_error_instead_of_an_incomplete_row(self) -> None:
        engine = engine_with_stub_routes("en")
        engine.routes["en", "de"] = RouteStub("en", "de", " \t\n")
        with self.assertRaisesRegex(RuntimeError, "empty german translation"):
            engine.translate("hello", "en")

    def test_invalid_text_never_reaches_a_translation_route(self) -> None:
        engine = engine_with_stub_routes("en")
        with self.assertRaises(ValueError):
            engine.translate("", "en")
        self.assertTrue(all(not route.calls for route in engine.routes.values()))


class StubEngine:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def translate(self, text: str, source: str) -> dict[str, str]:
        self.calls.append((text, source))
        return engine_with_stub_routes(source).translate(text, source)


def run_protocol(lines: list[object], engine_factory: object) -> tuple[list[dict], str]:
    input_text = "".join(
        line + "\n" if isinstance(line, str) else json.dumps(line, ensure_ascii=False) + "\n"
        for line in lines
    )
    output = io.StringIO()
    diagnostics = io.StringIO()
    with mock.patch.object(worker, "TranslationEngine", engine_factory):
        with contextlib.redirect_stderr(diagnostics):
            worker.serve(io.StringIO(input_text), output)
    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    return responses, diagnostics.getvalue()


class WorkerProtocolTests(unittest.TestCase):
    def test_status_and_multiple_requests_reuse_one_engine(self) -> None:
        engine = StubEngine()
        factory = mock.Mock(return_value=engine)
        requests = [{"action": "status"}]
        for source in worker.LANGUAGE_FIELDS:
            requests.append({"action": "translate", "sourceLanguage": source, "text": "  café  "})
        responses, diagnostics = run_protocol(requests, factory)
        factory.assert_called_once_with()
        self.assertEqual(len(responses), len(requests))
        self.assertTrue(all(response["ok"] is True for response in responses))
        self.assertEqual(responses[0]["data"]["ready"], True)
        self.assertEqual(engine.calls, [("  café  ", source) for source in worker.LANGUAGE_FIELDS])
        for source, response in zip(worker.LANGUAGE_FIELDS, responses[1:]):
            self.assertEqual(response["data"][worker.LANGUAGE_FIELDS[source]], "  café  ")
        self.assertEqual(diagnostics, "")

    def test_invalid_json_and_requests_do_not_prevent_later_success(self) -> None:
        factory = mock.Mock(return_value=StubEngine())
        invalid_requests = [
            "{broken json",
            "[]",
            "null",
            {"action": "unknown"},
            {"action": "translate", "text": "SECRET_SENTENCE", "sourceLanguage": "it"},
            {"action": "translate", "sourceLanguage": "en"},
        ]
        responses, diagnostics = run_protocol(invalid_requests + [{"action": "status"}], factory)
        self.assertEqual(len(responses), len(invalid_requests) + 1)
        self.assertTrue(all(response["ok"] is False for response in responses[:-1]))
        self.assertTrue(all(isinstance(response["error"], str) and response["error"] for response in responses[:-1]))
        self.assertTrue(responses[-1]["ok"])
        factory.assert_called_once_with()
        events = [json.loads(line) for line in diagnostics.splitlines()]
        self.assertEqual(len(events), len(invalid_requests))
        self.assertTrue(all(event["event"] == "translation_error" for event in events))
        self.assertNotIn("SECRET_SENTENCE", diagnostics)
        self.assertNotIn("Traceback", diagnostics)

    def test_invalid_request_does_not_load_models(self) -> None:
        factory = mock.Mock(side_effect=AssertionError("must not load models"))
        responses, _ = run_protocol([{"action": "translate", "sourceLanguage": "en", "text": " "}], factory)
        self.assertFalse(responses[0]["ok"])
        factory.assert_not_called()

    def test_failed_initialization_is_reported_and_retried(self) -> None:
        factory = mock.Mock(side_effect=[RuntimeError("Missing offline model."), StubEngine()])
        responses, _ = run_protocol([{"action": "status"}, {"action": "status"}], factory)
        self.assertEqual(responses[0], {"ok": False, "error": "Missing offline model."})
        self.assertTrue(responses[1]["ok"])
        self.assertEqual(factory.call_count, 2)

    def test_translation_error_keeps_the_worker_available(self) -> None:
        engine = StubEngine()
        engine.translate = mock.Mock(side_effect=[RuntimeError("Empty model output."), {"english": "hello"}])
        request = {"action": "translate", "sourceLanguage": "en", "text": "hello"}
        factory = mock.Mock(return_value=engine)
        responses, _ = run_protocol([request, request], factory)
        self.assertEqual(responses[0], {"ok": False, "error": "Empty model output."})
        self.assertTrue(responses[1]["ok"])
        factory.assert_called_once_with()


class OfflineNetworkGuardTests(unittest.TestCase):
    def test_connection_entry_points_fail_before_any_network_attempt(self) -> None:
        original_create = socket.create_connection
        original_connect = socket.socket.connect
        original_connect_ex = socket.socket.connect_ex
        # The guard intentionally changes socket functions. These patches restore
        # every function when the test exits, including on assertion failures.
        with mock.patch.object(socket, "create_connection"):
            with mock.patch.object(socket.socket, "connect"):
                with mock.patch.object(socket.socket, "connect_ex"):
                    worker.prohibit_network()
                    with socket.socket() as connection:
                        attempts = (
                            lambda: socket.create_connection(("127.0.0.1", 1)),
                            lambda: connection.connect(("127.0.0.1", 1)),
                            lambda: connection.connect_ex(("127.0.0.1", 1)),
                        )
                        for attempt in attempts:
                            with self.assertRaisesRegex(RuntimeError, "Translation runs offline"):
                                attempt()
        self.assertIs(socket.create_connection, original_create)
        self.assertIs(socket.socket.connect, original_connect)
        self.assertIs(socket.socket.connect_ex, original_connect_ex)


class SmokeRegressionValidationTests(unittest.TestCase):
    def valid_translations(self) -> dict[str, str]:
        return {
            "russian": "Я люблю читать книги.",
            "english": "I like reading books.",
            "german": "Ich lese gern Bücher.",
            "spanish": "Me gusta leer libros.",
            "french": "J’aime lire des livres.",
        }

    def test_known_sentences_accept_book_anchors_and_preserve_each_source(self) -> None:
        for source, original in checker.SENTENCES.items():
            with self.subTest(source=source):
                data = self.valid_translations()
                data[checker.LANGUAGE_FIELDS[source]] = original
                checker.validate_translation(data, source, original)

    def test_rejects_translation_too_long_to_copy_into_app(self) -> None:
        data = self.valid_translations()
        data["english"] = "books " + "x" * checker.MAX_TRANSLATED_CHARACTERS
        with self.assertRaisesRegex(RuntimeError, "character limit"):
            checker.validate_translation(data, "es", checker.SENTENCES["es"])

    def test_rejects_repeated_words_and_unbroken_generation_loops(self) -> None:
        for broken_text in ("books books books books books", "bookmainstre" * 8):
            with self.subTest(broken_text=broken_text):
                data = self.valid_translations()
                data["english"] = broken_text
                with self.assertRaisesRegex(RuntimeError, "pathological repetition"):
                    checker.validate_translation(data, "es", checker.SENTENCES["es"])

    def test_rejects_nonblank_output_that_loses_sentence_meaning(self) -> None:
        data = self.valid_translations()
        data["english"] = "I like swimming."
        with self.assertRaisesRegex(RuntimeError, "book-word anchor"):
            checker.validate_translation(data, "es", checker.SENTENCES["es"])

    def test_preview_length_is_bounded_and_unicode_is_preserved(self) -> None:
        self.assertEqual(checker.display_text("Bücher"), "Bücher")
        preview = checker.display_text("я" * 1000)
        self.assertEqual(len(preview), checker.MAX_DISPLAY_CHARACTERS)
        self.assertTrue(preview.endswith("…"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
