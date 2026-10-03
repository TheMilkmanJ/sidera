"""
Sidera Dual-Hemisphere Mediator - Configuration

Reads config.toml (next to the installed files, or the path in SIDERA_CONFIG)
and applies defaults for anything missing. Nothing personal is hard-coded:
the data folder defaults to <install root>/data, which the Windows installer
places at C:\\Sidera\\data.
"""

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

try:  # Python 3.11+
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - older interpreter
    tomllib = None

logger = logging.getLogger("sidera.config")

INSTALL_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = INSTALL_ROOT / "config.toml"


@dataclass
class MediatorConfig:
    data_root: Path = INSTALL_ROOT / "data"
    max_autonomous_turns: int = 50
    # False = monitor and log only; nothing is ever pasted into a chat.
    autonomous_submissions: bool = True
    # A side moves to a fresh chat (and is caught up from memory) after this
    # many pastes into one chat; long single chats are where the sites degrade.
    rotate_after_pastes: int = 50
    # Pause with a plain explanation when nothing has been detected from a side
    # for this long (broken selectors, a dead tab). 0 disables the watchdog.
    idle_timeout_minutes: float = 20.0
    genesis_enabled: bool = True
    genesis_prompt_file: Path = INSTALL_ROOT / "mediator" / "genesis_protocol.md"
    log_level: str = "INFO"
    source_path: Optional[Path] = None
    raw: Dict[str, Any] = field(default_factory=dict)


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if value is None:
        return default
    return bool(value)


def _resolve(base: Path, value: Any, default: Path) -> Path:
    if not value:
        return default
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def load_config(path: Optional[Path] = None) -> MediatorConfig:
    """Load config.toml; missing file or missing keys fall back to defaults."""
    config = MediatorConfig()
    candidate = path or (Path(os.environ["SIDERA_CONFIG"]) if os.environ.get("SIDERA_CONFIG") else DEFAULT_CONFIG_PATH)
    if not candidate.exists():
        return config
    if tomllib is None:
        logger.warning("Python without tomllib; ignoring %s and using defaults", candidate)
        return config
    try:
        with candidate.open("rb") as handle:
            raw = tomllib.load(handle)
    except Exception as err:  # malformed file: fail closed to defaults, loudly
        logger.error("Could not read %s (%s); using defaults", candidate, err)
        return config

    base = candidate.resolve().parent
    mediator = raw.get("mediator", {})
    genesis = raw.get("genesis", {})
    logging_section = raw.get("logging", {})

    config.data_root = _resolve(base, mediator.get("data_root"), config.data_root)
    config.max_autonomous_turns = int(mediator.get("max_autonomous_turns", config.max_autonomous_turns))
    config.autonomous_submissions = _as_bool(mediator.get("autonomous_submissions"), config.autonomous_submissions)
    config.rotate_after_pastes = int(mediator.get("rotate_after_pastes", config.rotate_after_pastes))
    config.idle_timeout_minutes = float(mediator.get("idle_timeout_minutes", config.idle_timeout_minutes))
    config.genesis_enabled = _as_bool(genesis.get("enabled"), config.genesis_enabled)
    config.genesis_prompt_file = _resolve(base, genesis.get("prompt_file"), config.genesis_prompt_file)
    config.log_level = str(logging_section.get("level", config.log_level)).upper()
    config.source_path = candidate
    config.raw = raw
    return config
