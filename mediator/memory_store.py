"""
Sidera Dual-Hemisphere Mediator - Memory Store
Manages durable local memory stored in machine-readable JSONL and mirrored to Markdown.
"""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

class MemoryStore:
    def __init__(self, memory_dir: Path):
        self.memory_dir = memory_dir.resolve()
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self._next_id = self._initialize_counter()

    def _initialize_counter(self) -> int:
        max_id = 0
        for jsonl_file in self.memory_dir.glob("*.jsonl"):
            with jsonl_file.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                        mem_id_str = data.get("id", "")
                        if mem_id_str.startswith("MEM-"):
                            num = int(mem_id_str.split("-")[1])
                            if num > max_id:
                                max_id = num
                    except (ValueError, KeyError, json.JSONDecodeError):
                        continue
        return max_id + 1

    def _generate_memory_id(self) -> str:
        mem_id = f"MEM-{self._next_id:06d}"
        self._next_id += 1
        return mem_id

    def write_memory(
        self,
        category: str,
        content: str,
        project: str = "default",
        source: str = "SYSTEM",
        parent_message_id: Optional[str] = None,
    ) -> Dict:
        clean_category = "".join(c for c in category.lower() if c.isalnum() or c in ("_", "-"))
        if not clean_category:
            clean_category = "core"

        mem_id = self._generate_memory_id()
        now_iso = datetime.now(timezone.utc).isoformat()

        entry = {
            "id": mem_id,
            "timestamp": now_iso,
            "source": source,
            "category": clean_category,
            "project": project,
            "content": content.strip(),
            "parent_message_id": parent_message_id or "",
        }

        jsonl_path = self.memory_dir / f"{clean_category}.jsonl"
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

        md_path = self.memory_dir / f"{clean_category}.md"
        with md_path.open("a", encoding="utf-8") as f:
            if md_path.stat().st_size == 0:
                f.write(f"# Sidera Persistent Memory: {clean_category.title()}\n\n")
            f.write(
                f"### Entry {mem_id} | {now_iso}\n"
                f"- **Project:** `{project}`\n"
                f"- **Source:** `{source}`\n"
                f"- **Parent Message:** `{parent_message_id or 'N/A'}`\n\n"
                f"{content.strip()}\n\n---\n\n"
            )
        return entry

    def read_memory(
        self,
        category: Optional[str] = None,
        project: Optional[str] = None,
        query: Optional[str] = None,
        limit: int = 10,
    ) -> List[Dict]:
        results = []
        files = []
        if category:
            clean_cat = "".join(c for c in category.lower() if c.isalnum() or c in ("_", "-"))
            target_file = self.memory_dir / f"{clean_cat}.jsonl"
            if target_file.is_file():
                files.append(target_file)
        else:
            files = sorted(self.memory_dir.glob("*.jsonl"))

        query_terms = query.lower().split() if query else []
        for fpath in files:
            with fpath.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                        if project and project != "all" and record.get("project") != project:
                            continue
                        if query_terms:
                            content_lower = record.get("content", "").lower()
                            if not all(term in content_lower for term in query_terms):
                                continue
                        results.append(record)
                    except json.JSONDecodeError:
                        continue

        results.reverse()
        return results[:limit]
