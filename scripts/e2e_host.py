"""Run the real mediator for a live copy-paste conversation."""

import os
from pathlib import Path

from mediator.config import MediatorConfig
from mediator.main import MediatorService

if __name__ == "__main__":
    root = Path(os.environ["SIDERA_FLOW_ROOT"])
    max_turns = int(os.environ.get("SIDERA_MAX_TURNS", "2"))
    config = MediatorConfig(
        data_root=root,
        max_autonomous_turns=max_turns,
        rotate_after_pastes=int(os.environ.get("SIDERA_ROTATE_AFTER", "50")),
    )
    MediatorService(root_dir=root, max_turns=max_turns, config=config).run()
