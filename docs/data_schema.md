# Sidera local data schema

Everything lives under the data folder (`data_root` in `config.toml`; `C:\Sidera\data`
on a standard Windows install). Records are append-only; nothing is deleted
automatically.

```text
data/
  ledger.sqlite            routing ledger and runtime state (SQLite, WAL mode)
  transcripts/<date>-main.md
  logs/sidera_mediator.log
  memory/<category>.jsonl  one JSON object per line, machine-readable
  memory/<category>.md     human-readable mirror of the same records
  files/…                  the sandboxed folder the AIs read and write
  credentials/chatgpt.bin  the operator's ChatGPT login, DPAPI-encrypted on Windows
  credentials/grok.bin     the operator's Grok login, DPAPI-encrypted on Windows
```

## ledger.sqlite

### messages

One row per captured assistant reply (the message envelope from spec section 7).

| column | meaning |
| --- | --- |
| `message_id` | `SIDERA-0000184`, monotonically increasing |
| `conversation_id` | `YYYY-MM-DD-main` |
| `source` / `destination` | `LEFT` or `RIGHT` |
| `captured_at` | ISO-8601 UTC |
| `content_sha256` | hash of the trimmed raw text |
| `content` | full raw reply including tags |
| `clean_content` | reply with tags stripped (set at `PROCESSED`) |
| `status` | `CAPTURED` → `PROCESSED` → `SUBMITTING` → `ACKNOWLEDGED` |
| `parent_message_id` | the previous message in the conversation |

### turns

`turn_number` (autoincrement), `conversation_id`, `message_id`, `source`, `state`, `timestamp`;
one row per acknowledged submission.

### tag_operations

`message_id`, `op_index`, `op_type`, `target` (path or category), `result`, `executed_at`.
Present rows mean the operations for that message already ran; they are never repeated.

### runtime_state

Key/value: `state`, `turn_count`, `current_message_id`, `last_error`, `max_autonomous_turns`.
Written on every state transition. On start-up the mediator restores `PAUSED`, and if
the previous session ended mid-exchange it starts `PAUSED` with an explanatory reason
rather than resuming.

## memory/<category>.jsonl

```json
{"id": "MEM-000217", "timestamp": "2026-09-22T22:31:24+00:00", "source": "LEFT",
 "category": "inventions", "project": "gyrocell",
 "content": "Baseline working-fluid decision: use Galinstan rather than NaK.",
 "parent_message_id": "SIDERA-0000184"}
```

`memory/<category>.md` holds the same entries as Markdown sections (`### Entry MEM-000217 | …`).

## transcripts/<date>-main.md

For each routed message: a heading `## [SIDERA-0000184] LEFT -> RIGHT | <time> UTC`, the
status, hash prefix, executed tags, turn number and the forwarded text. Between messages:
status transitions, Genesis handshake lines, fresh-chat catch-ups (`Fresh chat: LEFT caught up with N memories and K recent turns`), settings changes, manual forwards and error
signals (`TAG_ERROR`, `INJECTION_ERROR`, `SUBMISSION_STALLED`).

## logs/sidera_mediator.log

Timestamped lines: `STATUS turn=N/M state=… message=… error=…`, `ACKNOWLEDGED …`,
`GENESIS …`, `TAG_ERROR …`, `INJECTION_ERROR …`, `SUBMISSION_STALLED …`,
`BURN_IN_LIMIT_REACHED …`, `MONITOR_ONLY …`, duplicate and out-of-turn warnings. Logs
never contain cookies or tokens; the extension only sends reply text and control packets.
