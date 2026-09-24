"""
Sidera Dual-Hemisphere Mediator - Message Ledger
SQLite-backed message ledger providing monotonic IDs, SHA-256 hashing,
strict turn lifecycle states, and crash recovery.
"""

import hashlib
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

class MessageLedger:
    def __init__(self, db_path: Path):
        self.db_path = db_path.resolve()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=10.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                message_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                source TEXT NOT NULL,
                destination TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                content_sha256 TEXT NOT NULL,
                content TEXT NOT NULL,
                clean_content TEXT,
                status TEXT NOT NULL,
                parent_message_id TEXT
            );
            """)
            conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_messages_hash 
            ON messages (content_sha256, source);
            """)
            conn.execute("""
            CREATE TABLE IF NOT EXISTS turns (
                turn_number INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                source TEXT NOT NULL,
                state TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (message_id) REFERENCES messages(message_id)
            );
            """)
            conn.commit()

    @staticmethod
    def compute_sha256(content: str) -> str:
        return hashlib.sha256(content.strip().encode("utf-8")).hexdigest()

    def get_next_message_id(self) -> str:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM messages")
            count = cursor.fetchone()[0]
            return f"SIDERA-{count + 1:07d}"

    def is_duplicate(self, content: str, source: str) -> bool:
        content_hash = self.compute_sha256(content)
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT 1 FROM messages WHERE content_sha256 = ? AND source = ? LIMIT 1",
                (content_hash, source),
            )
            return cursor.fetchone() is not None

    def capture_message(
        self,
        conversation_id: str,
        source: str,
        destination: str,
        content: str,
        parent_message_id: Optional[str] = None,
    ) -> Dict:
        message_id = self.get_next_message_id()
        content_hash = self.compute_sha256(content)
        now_iso = datetime.now(timezone.utc).isoformat()

        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO messages (
                    message_id, conversation_id, source, destination,
                    captured_at, content_sha256, content, status, parent_message_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CAPTURED', ?)
                """,
                (
                    message_id,
                    conversation_id,
                    source,
                    destination,
                    now_iso,
                    content_hash,
                    content,
                    parent_message_id,
                ),
            )
            conn.commit()

        return {
            "message_id": message_id,
            "conversation_id": conversation_id,
            "source": source,
            "destination": destination,
            "captured_at": now_iso,
            "content_sha256": content_hash,
            "content": content,
            "status": "CAPTURED",
            "parent_message_id": parent_message_id,
        }

    def update_status(self, message_id: str, new_status: str, clean_content: Optional[str] = None):
        with self._get_connection() as conn:
            if clean_content is not None:
                conn.execute(
                    "UPDATE messages SET status = ?, clean_content = ? WHERE message_id = ?",
                    (new_status, clean_content, message_id),
                )
            else:
                conn.execute(
                    "UPDATE messages SET status = ? WHERE message_id = ?",
                    (new_status, message_id),
                )
            conn.commit()

    def get_message(self, message_id: str) -> Optional[Dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM messages WHERE message_id = ?", (message_id,))
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_last_message(self, conversation_id: Optional[str] = None) -> Optional[Dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            if conversation_id:
                cursor.execute(
                    "SELECT * FROM messages WHERE conversation_id = ? ORDER BY captured_at DESC LIMIT 1",
                    (conversation_id,),
                )
            else:
                cursor.execute("SELECT * FROM messages ORDER BY captured_at DESC LIMIT 1")
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_unacknowledged_message(self) -> Optional[Dict]:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM messages WHERE status IN ('CAPTURED', 'PROCESSED', 'SUBMITTING') ORDER BY captured_at DESC LIMIT 1"
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def record_turn(self, conversation_id: str, message_id: str, source: str, state: str):
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO turns (conversation_id, message_id, source, state, timestamp)
                VALUES (?, ?, ?, ?, ?)
                """,
                (conversation_id, message_id, source, state, now_iso),
            )
            conn.commit()

    def get_turn_count(self, conversation_id: str) -> int:
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT COUNT(*) FROM turns WHERE conversation_id = ?",
                (conversation_id,),
            )
            return cursor.fetchone()[0]
