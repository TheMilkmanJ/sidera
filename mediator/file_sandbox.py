"""
Sidera Dual-Hemisphere Mediator - File Sandbox
Provides strictly sandboxed file read/write/append operations within the Sidera root directory.
Prevents directory traversal, absolute path escape, and symlink escape.
"""

import re
from pathlib import Path
from typing import List, Optional

_DRIVE_OR_UNC = re.compile(r"^(?:[A-Za-z]:|[\\/]{2})")

class SandboxSecurityError(Exception):
    """Raised when a file path violates sandbox security boundaries."""
    pass

class FileSandbox:
    def __init__(self, sandbox_root: Path, allowed_extensions: Optional[List[str]] = None):
        self.sandbox_root = sandbox_root.resolve()
        self.sandbox_root.mkdir(parents=True, exist_ok=True)
        self.allowed_extensions = allowed_extensions or [".md", ".txt", ".json", ".jsonl", ".csv"]

    def _resolve_safe_path(self, relative_path: str) -> Path:
        if not relative_path or not relative_path.strip():
            raise SandboxSecurityError("Empty file path is not allowed.")
        raw = relative_path.strip()
        if "\x00" in raw or _DRIVE_OR_UNC.match(raw) or Path(raw).is_absolute():
            raise SandboxSecurityError(
                f"Absolute or drive-qualified path is not allowed: '{relative_path}'"
            )
        clean_rel = raw.lstrip("/\\")
        if not clean_rel or clean_rel.startswith(("/", "\\")):
            raise SandboxSecurityError(f"Absolute path is not allowed: '{relative_path}'")
        target_path = (self.sandbox_root / clean_rel).resolve()
        try:
            target_path.relative_to(self.sandbox_root)
        except ValueError:
            raise SandboxSecurityError(
                f"Path traversal detected: '{relative_path}' resolves outside sandbox '{self.sandbox_root}'"
            )
        if target_path.suffix and target_path.suffix.lower() not in self.allowed_extensions:
            raise SandboxSecurityError(
                f"Disallowed file extension '{target_path.suffix}'. Allowed: {self.allowed_extensions}"
            )
        return target_path

    def read_file(self, relative_path: str) -> str:
        safe_path = self._resolve_safe_path(relative_path)
        if not safe_path.is_file():
            raise FileNotFoundError(f"File not found in sandbox: {relative_path}")
        return safe_path.read_text(encoding="utf-8")

    def write_file(self, relative_path: str, content: str) -> int:
        safe_path = self._resolve_safe_path(relative_path)
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        safe_path.write_text(content, encoding="utf-8")
        return len(content)

    def append_file(self, relative_path: str, content: str) -> int:
        safe_path = self._resolve_safe_path(relative_path)
        safe_path.parent.mkdir(parents=True, exist_ok=True)
        with safe_path.open("a", encoding="utf-8") as f:
            if safe_path.stat().st_size > 0 and not content.startswith("\n"):
                f.write("\n")
            f.write(content)
        return len(content)

    def list_files(self, relative_dir: str = "") -> List[str]:
        safe_dir = self._resolve_safe_path(relative_dir) if relative_dir else self.sandbox_root
        if not safe_dir.is_dir():
            return []
        results = []
        for p in safe_dir.rglob("*"):
            if p.is_file():
                results.append(str(p.relative_to(self.sandbox_root)).replace("\\", "/"))
        return sorted(results)

    def file_exists(self, relative_path: str) -> bool:
        try:
            safe_path = self._resolve_safe_path(relative_path)
            return safe_path.is_file()
        except SandboxSecurityError:
            return False
