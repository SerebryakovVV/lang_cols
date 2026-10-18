"""Install the app's private Python runtime and the eight pinned Argos models."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import os
import subprocess
import sys
import time
import urllib.request
import venv
import zipfile

from translation_worker import ROOT, LANGUAGE_FIELDS, MODEL_VERSIONS, configure_environment


def download(url: str, target: Path) -> None:
    if target.is_file() and zipfile.is_zipfile(target):
        print(f"Using downloaded {target.name}", flush=True)
        return
    temporary = target.with_suffix(target.suffix + ".part")
    print(f"Downloading {target.name}", flush=True)
    # Use the same client identity as Argos' official download implementation.
    request = urllib.request.Request(url, headers={"User-Agent": "ArgosTranslate"})
    with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
        total = int(response.headers.get("Content-Length", 0))
        received = 0
        last_update = 0.0
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            received += len(chunk)
            now = time.monotonic()
            if now - last_update >= 10:
                print(f"  {received / 1024**2:.0f} MiB" + (f" / {total / 1024**2:.0f} MiB" if total else ""), flush=True)
                last_update = now
    if not zipfile.is_zipfile(temporary):
        raise RuntimeError(f"{target.name} is not a valid model archive.")
    temporary.replace(target)


def install_models() -> None:
    storage = configure_environment()
    from argostranslate import package, settings
    from minisbd import models

    archives = storage / "downloads"
    archives.mkdir(parents=True, exist_ok=True)
    installed = {(model.from_code, model.to_code): model for model in package.get_installed_packages()}
    records = []
    for number, ((source, target), version) in enumerate(MODEL_VERSIONS.items(), 1):
        filename = f"translate-{source}_{target}-{version.replace('.', '_')}.argosmodel"
        url = "https://argos-net.com/v1/" + filename
        current = installed.get((source, target))
        print(f"[{number}/8] {source} → {target}, model {version}", flush=True)
        if current is None or current.package_version != version:
            archive = archives / filename
            download(url, archive)
            with zipfile.ZipFile(archive) as bundle:
                bad_file = bundle.testzip()
                if bad_file:
                    raise RuntimeError(f"The model archive is damaged: {bad_file}")
                for member in bundle.namelist():
                    relative = Path(member)
                    if relative.is_absolute() or ".." in relative.parts:
                        raise RuntimeError("The model archive contains an invalid path.")
                metadata_files = [member for member in bundle.namelist() if member.endswith("/metadata.json")]
                if len(metadata_files) != 1:
                    raise RuntimeError("The model archive has no unique metadata file.")
                metadata = json.loads(bundle.read(metadata_files[0]))
                if (metadata.get("from_code"), metadata.get("to_code"), metadata.get("package_version")) != (source, target, version):
                    raise RuntimeError("The downloaded model does not match the pinned language pair and version.")
            checksum = hashlib.sha256()
            with archive.open("rb") as model_file:
                while chunk := model_file.read(1024 * 1024):
                    checksum.update(chunk)
            package.install_from_path(archive)
            archive.unlink()  # Installed models suffice; avoid keeping a second large copy.
            records.append({"source": source, "target": target, "version": version, "url": url, "sha256": checksum.hexdigest()})
        else:
            print("  Already installed.", flush=True)
            records.append({"source": source, "target": target, "version": version, "url": url})

    models.cache_dir = str(settings.data_dir / "minisbd")
    for code in LANGUAGE_FIELDS:
        print(f"Installing {code} sentence detector", flush=True)
        models.get_model_file(code)
    (storage / "models-manifest.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")
    result = subprocess.check_output([sys.executable, "-m", "pip", "freeze"], text=True)
    (storage / "python-packages.txt").write_text(result, encoding="utf-8")
    model_bytes = sum(path.stat().st_size for path in (storage / "models").rglob("*") if path.is_file())
    print(f"Installed all eight translation models ({model_bytes / 1024**2:.0f} MiB).", flush=True)
    print("Setup complete. Restart the app or press Check again to load offline translation.", flush=True)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-models", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if arguments.install_models:
        install_models()
        return
    if not (3, 10) <= sys.version_info[:2] < (3, 14):
        raise RuntimeError("Offline translation setup requires Python 3.10, 3.11, 3.12, or 3.13.")
    storage = configure_environment()
    environment_path = storage / "venv"
    python = environment_path / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.is_file():
        print(f"Creating private Python environment at {environment_path}", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment_path)
    child_environment = os.environ.copy()
    child_environment.update(PYTHONUTF8="1", PYTHONNOUSERSITE="1", PIP_DISABLE_PIP_VERSION_CHECK="1")
    commands = [
        [str(python), "-m", "pip", "install", "pip==25.1.1"],
        [str(python), "-m", "pip", "install", "torch==2.7.1+cpu", "--index-url", "https://download.pytorch.org/whl/cpu"],
        [str(python), "-m", "pip", "install", "-r", str(ROOT / "scripts" / "requirements-translation.txt")],
        [str(python), "-u", str(Path(__file__).resolve()), "--install-models"],
    ]
    for command in commands:
        subprocess.run(command, cwd=ROOT, env=child_environment, check=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Offline translation setup failed: {error}", file=sys.stderr)
        sys.exit(1)
