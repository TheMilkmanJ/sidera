"""Saved ChatGPT login stays encrypted at rest and never echoes the password."""

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from mediator.credential_store import ChatGptLoginStore, CredentialStoreError
from mediator.main import MediatorService


def xor_codec(key=b"\x5a"):
    def protect(data: bytes) -> bytes:
        return bytes(b ^ key[0] for b in data)

    return protect, protect


class CredentialStoreTests(unittest.TestCase):
    def test_round_trip_hides_the_password_on_disk(self):
        protect, unprotect = xor_codec()
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "credentials" / "chatgpt.bin"
            store = ChatGptLoginStore(path, protect=protect, unprotect=unprotect)
            store.save("owner@example.com", "correct horse battery")
            raw = path.read_bytes()
            self.assertNotIn(b"correct horse battery", raw)
            self.assertNotIn(b"owner@example.com", raw)
            self.assertEqual(store.status(), {"saved": True, "email": "owner@example.com"})
            self.assertEqual(store.load()["password"], "correct horse battery")
            store.clear()
            self.assertFalse(path.exists())
            self.assertEqual(store.status()["saved"], False)

    def test_rejects_a_codec_that_leaves_the_password_readable(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "chatgpt.bin"
            store = ChatGptLoginStore(path, protect=lambda data: data, unprotect=lambda data: data)
            with self.assertRaises(CredentialStoreError):
                store.save("owner@example.com", "secret-value")
            self.assertFalse(path.exists())

    def test_service_save_does_not_return_the_password(self):
        protect, unprotect = xor_codec()
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            service = MediatorService(root_dir=root, genesis_enabled=False, max_turns=5)
            service.chatgpt_login = ChatGptLoginStore(
                root / "credentials" / "chatgpt.bin",
                protect=protect,
                unprotect=unprotect,
            )
            sent = []
            service.ipc.send_message = sent.append
            service.handle_message({
                "type": "SAVE_CHATGPT_LOGIN",
                "email": "owner@example.com",
                "password": "secret-value",
            })
            self.assertEqual(sent[-1]["type"], "CHATGPT_LOGIN_STATUS")
            self.assertTrue(sent[-1]["saved"])
            self.assertNotIn("password", sent[-1])
            self.assertNotIn("secret-value", json.dumps(sent[-1]))

            sent.clear()
            service.handle_message({"type": "GET_CHATGPT_LOGIN"})
            self.assertEqual(sent[-1]["password"], "secret-value")

            sent.clear()
            service.handle_message({"type": "GET_CHATGPT_LOGIN_STATUS"})
            self.assertNotIn("password", sent[-1])

            service.handle_message({"type": "FORGET_CHATGPT_LOGIN"})
            self.assertFalse(service.chatgpt_login.status()["saved"])


if __name__ == "__main__":
    unittest.main()
