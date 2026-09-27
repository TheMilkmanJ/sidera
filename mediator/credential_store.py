"""
Saved ChatGPT login for the operator's own account.

On Windows the email and password are encrypted with DPAPI, so only this
Windows user on this PC can read them. The file lives under data/credentials
and is never written to the transcript or the log.
"""

import json
import sys
from pathlib import Path
from typing import Callable, Optional


class CredentialStoreError(Exception):
    """The login could not be saved or read."""


Protect = Callable[[bytes], bytes]
Unprotect = Callable[[bytes], bytes]


def _dpapi_protect(data: bytes) -> bytes:
    return _dpapi(data, protect=True)


def _dpapi_unprotect(data: bytes) -> bytes:
    return _dpapi(data, protect=False)


def _dpapi(data: bytes, protect: bool) -> bytes:
    import ctypes
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]

    def blob_from(raw: bytes) -> DATA_BLOB:
        buffer = ctypes.create_string_buffer(raw)
        blob = DATA_BLOB(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
        blob._keepalive = buffer
        return blob

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    incoming = blob_from(data)
    outgoing = DATA_BLOB()
    # CRYPTPROTECT_UI_FORBIDDEN: never pop a Windows credential dialog.
    flags = 0x1
    if protect:
        ok = crypt32.CryptProtectData(
            ctypes.byref(incoming),
            "Sidera ChatGPT login",
            None,
            None,
            None,
            flags,
            ctypes.byref(outgoing),
        )
    else:
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(incoming),
            None,
            None,
            None,
            None,
            flags,
            ctypes.byref(outgoing),
        )
    if not ok:
        action = "encrypt" if protect else "decrypt"
        raise CredentialStoreError(f"Windows could not {action} the ChatGPT login.")
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        kernel32.LocalFree(outgoing.pbData)


class ChatGptLoginStore:
    """One saved ChatGPT email and password."""

    def __init__(
        self,
        path: Path,
        protect: Optional[Protect] = None,
        unprotect: Optional[Unprotect] = None,
    ):
        self.path = Path(path)
        self._protect = protect
        self._unprotect = unprotect

    def _codecs(self):
        if self._protect is not None and self._unprotect is not None:
            return self._protect, self._unprotect
        if sys.platform == "win32":
            return _dpapi_protect, _dpapi_unprotect
        raise CredentialStoreError(
            "A ChatGPT login can be saved on Windows, where it is encrypted for this user."
        )

    def save(self, email: str, password: str) -> None:
        cleaned = (email or "").strip()
        if "@" not in cleaned or not password:
            raise CredentialStoreError("Email and password are both required.")
        protect, _unprotect = self._codecs()
        payload = json.dumps({"email": cleaned, "password": password}).encode("utf-8")
        sealed = protect(payload)
        if password.encode("utf-8") in sealed or cleaned.encode("utf-8") in sealed:
            raise CredentialStoreError("Refusing to write the ChatGPT login without encryption.")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(sealed)

    def clear(self) -> None:
        if self.path.exists():
            self.path.unlink()

    def load(self) -> Optional[dict]:
        if not self.path.exists():
            return None
        try:
            _protect, unprotect = self._codecs()
            raw = unprotect(self.path.read_bytes())
            data = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError, CredentialStoreError, json.JSONDecodeError):
            return None
        email = str(data.get("email") or "").strip()
        password = str(data.get("password") or "")
        if not email or not password:
            return None
        return {"email": email, "password": password}

    def status(self) -> dict:
        record = self.load()
        if not record:
            return {"saved": False, "email": ""}
        return {"saved": True, "email": record["email"]}
