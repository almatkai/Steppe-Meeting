"""Resolve and migrate Steppe Meeting's writable application data directory."""

from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path

APP_NAME = "Steppe Meeting"
logger = logging.getLogger("steppe.desktop.storage")


def get_app_data_dir() -> Path:
    """Return the per-user writable data directory for the current OS.

    STEPPE_DATA_DIR is supported for development, tests, and portable installs.
    """
    override = os.environ.get("STEPPE_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()

    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / APP_NAME
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        return root / APP_NAME

    root = Path(os.environ.get("XDG_DATA_HOME", home / ".local" / "share"))
    return root / APP_NAME


def prepare_app_data_dir(legacy_dir: Path) -> Path:
    """Create app storage and safely copy missing data from the old repo-local path.

    Existing destination files always win, making migration safe and idempotent.
    Legacy data is deliberately left in place until the user confirms migration.
    """
    target = get_app_data_dir()
    target.mkdir(parents=True, exist_ok=True)

    try:
        same_location = legacy_dir.resolve() == target.resolve()
    except OSError:
        same_location = False

    if legacy_dir.exists() and not same_location:
        for source in legacy_dir.rglob("*"):
            if not source.is_file() or source.name in {".gitkeep", ".DS_Store"}:
                continue
            relative = source.relative_to(legacy_dir)
            destination = target / relative
            if destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            logger.info("Migrated app data: %s -> %s", source, destination)

    for directory in ("audio", "exports", "logs", "templates", "models", "models/whisper"):
        (target / directory).mkdir(parents=True, exist_ok=True)

    return target
