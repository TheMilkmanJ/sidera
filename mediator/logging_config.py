"""
Sidera Dual-Hemisphere Mediator - Logging Setup
Configures structured file and stderr logging.
"""

import logging
from pathlib import Path

def setup_logging(log_dir: Path, level: int = logging.INFO):
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "sidera_mediator.log"

    formatter = logging.Formatter(
        "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    file_handler = logging.FileHandler(str(log_file), encoding="utf-8")
    file_handler.setFormatter(formatter)
    file_handler.setLevel(level)

    import sys
    stderr_handler = logging.StreamHandler(sys.stderr)
    stderr_handler.setFormatter(formatter)
    stderr_handler.setLevel(level)

    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    for existing in list(root_logger.handlers):
        existing.close()
        root_logger.removeHandler(existing)
    root_logger.handlers = [file_handler, stderr_handler]
