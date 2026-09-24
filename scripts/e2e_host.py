"""Run the real mediator for one live round trip. Two forwards, then the ceiling pauses."""

import os
from pathlib import Path

from mediator.main import MediatorService

if __name__ == "__main__":
    root = Path(os.environ["SIDERA_FLOW_ROOT"])
    MediatorService(root_dir=root, max_turns=2).run()
