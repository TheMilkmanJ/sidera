"""
Sidera Dual-Hemisphere Mediator - Tag Protocol Parser
Parses Sidera control, memory, and file I/O tags.
Extracts operational instructions and produces sanitized conversational text.
"""

import re
import shlex
from typing import Dict, List, Tuple, Any

TAG_BLOCK_REGEX = re.compile(
    r"\[\[SIDERA:\s*([A-Za-z0-9_]+)(.*?)\]\]([\s\S]*?)\[\[/SIDERA\]\]",
    re.IGNORECASE,
)

TAG_SINGLE_REGEX = re.compile(
    r"\[\[SIDERA:\s*([A-Za-z0-9_]+)(.*?)\]\]",
    re.IGNORECASE,
)

LEGACY_MEMORY_REGEX = re.compile(
    r"\[\[MEMORY:([A-Za-z0-9_-]+)\]\]([\s\S]*?)\[\[/MEMORY\]\]",
    re.IGNORECASE,
)

class TagParser:
    @staticmethod
    def _parse_attributes(attr_str: str) -> Dict[str, str]:
        attrs = {}
        if not attr_str or not attr_str.strip():
            return attrs
        try:
            tokens = shlex.split(attr_str.strip())
            for token in tokens:
                if "=" in token:
                    k, v = token.split("=", 1)
                    attrs[k.strip().lower()] = v.strip()
        except ValueError:
            pairs = re.findall(r'(\w+)=["\']([^"\']*)["\']', attr_str)
            for k, v in pairs:
                attrs[k.lower()] = v
        return attrs

    def parse(self, raw_text: str) -> Tuple[str, List[Dict[str, Any]], List[str]]:
        operations = []
        errors = []
        clean_text = raw_text

        for match in TAG_BLOCK_REGEX.finditer(raw_text):
            op_name = match.group(1).upper()
            attr_str = match.group(2)
            body = match.group(3).strip()
            attrs = self._parse_attributes(attr_str)
            op = {
                "type": op_name,
                "raw_match": match.group(0),
                "attributes": attrs,
                "body": body,
            }
            if op_name in ("MEMORY_WRITE", "MEMORY_READ", "FILE_APPEND", "FILE_READ"):
                operations.append(op)
            else:
                errors.append(f"Unknown block tag operation: {op_name}")

        clean_text = TAG_BLOCK_REGEX.sub("", clean_text)

        for match in TAG_SINGLE_REGEX.finditer(clean_text):
            op_name = match.group(1).upper()
            attr_str = match.group(2)
            attrs = self._parse_attributes(attr_str)
            op = {
                "type": op_name,
                "raw_match": match.group(0),
                "attributes": attrs,
                "body": "",
            }
            if op_name in ("STOP", "PAUSE", "STATUS"):
                operations.append(op)
            elif op_name not in ("MEMORY_WRITE", "MEMORY_READ", "FILE_APPEND", "FILE_READ"):
                errors.append(f"Unknown single tag operation: {op_name}")

        clean_text = TAG_SINGLE_REGEX.sub("", clean_text)

        for match in LEGACY_MEMORY_REGEX.finditer(clean_text):
            cat = match.group(1).lower()
            body = match.group(2).strip()
            operations.append({
                "type": "MEMORY_WRITE",
                "raw_match": match.group(0),
                "attributes": {"category": cat, "project": "default"},
                "body": body,
            })

        clean_text = LEGACY_MEMORY_REGEX.sub("", clean_text)
        clean_text = re.sub(r"\n{3,}", "\n\n", clean_text).strip()
        return clean_text, operations, errors

    def execute_operations(
        self,
        operations: List[Dict[str, Any]],
        memory_store: Any,
        file_sandbox: Any,
        source: str,
        parent_message_id: str,
    ) -> Tuple[List[str], Dict[str, Any]]:
        system_injections = []
        control_signals = {"pause": False, "stop": False, "reason": None}

        for op in operations:
            op_type = op["type"]
            attrs = op.get("attributes", {})
            body = op.get("body", "")

            try:
                if op_type == "MEMORY_WRITE":
                    cat = attrs.get("category", "core")
                    proj = attrs.get("project", "default")
                    memory_store.write_memory(
                        category=cat,
                        content=body,
                        project=proj,
                        source=source,
                        parent_message_id=parent_message_id,
                    )
                elif op_type == "MEMORY_READ":
                    cat = attrs.get("category")
                    proj = attrs.get("project")
                    limit = int(attrs.get("limit", 10))
                    memories = memory_store.read_memory(
                        category=cat, project=proj, query=body, limit=limit
                    )
                    if memories:
                        lines = [f"- [{m['id']} {m['category']}/{m['project']}] {m['content']}" for m in memories]
                        system_injections.append(
                            f"[SIDERA SYSTEM: Memory Query Results ({len(memories)} items)]\n" + "\n".join(lines)
                        )
                    else:
                        system_injections.append("[SIDERA SYSTEM: Memory query returned 0 results.]")
                elif op_type == "FILE_APPEND":
                    path = attrs.get("path")
                    if not path:
                        system_injections.append("[SIDERA SYSTEM ERROR: FILE_APPEND missing path]")
                    else:
                        file_sandbox.append_file(path, body)
                elif op_type == "FILE_READ":
                    path = attrs.get("path")
                    if not path:
                        system_injections.append("[SIDERA SYSTEM ERROR: FILE_READ missing path]")
                    else:
                        content = file_sandbox.read_file(path)
                        system_injections.append(
                            f"[SIDERA SYSTEM: File Content ({path})]\n{content}"
                        )
                elif op_type == "PAUSE":
                    control_signals["pause"] = True
                    control_signals["reason"] = attrs.get("reason", "AI requested pause.")
                elif op_type == "STOP":
                    control_signals["stop"] = True
                    control_signals["reason"] = "AI requested emergency stop."
                elif op_type == "STATUS":
                    system_injections.append(
                        f"[SIDERA SYSTEM: Active Turn under Message {parent_message_id}]"
                    )
            except Exception as e:
                system_injections.append(f"[SIDERA SYSTEM ERROR executing {op_type}: {str(e)}]")

        return system_injections, control_signals
