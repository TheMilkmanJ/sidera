# Sidera control-tag protocol

Tags are parsed only from **completed** assistant replies, executed locally by the
mediator, and stripped before the conversational text is forwarded to the other
hemisphere. Results of read/recall tags are returned to the hemisphere that asked,
attached to the next message pasted into it as a clearly marked Sidera system block.

Canonical form (build spec, section 8):

```text
[[SIDERA:OPERATION attr="value" attr2="value"]]
body
[[/SIDERA]]
```

A space after `SIDERA:` is tolerated. Attribute values are quoted. Operation names
are case-insensitive. Tags with a body need the closing `[[/SIDERA]]`; read, list and
control tags may be written on one line without a closing tag.

## Operations

| Tag | Body | Effect | Result returned to requester |
| --- | --- | --- | --- |
| `MEMORY_WRITE category="…" project="…"` | text to remember | Appends one record to `data/memory/<category>.jsonl` and mirrors it to `<category>.md`. Executed once per message. | none |
| `MEMORY_READ category="…" project="…" limit="20"` | optional search words | Returns up to `limit` matching memories (category, project and body words all optional). | `[SIDERA SYSTEM: Memory Query Results (N items)]` |
| `FILE_APPEND path="…"` | text | Appends to a file under `data/files/`. Creates it if needed. | none |
| `FILE_WRITE path="…"` | whole content | Creates or replaces a file under `data/files/`. | none |
| `FILE_READ path="…"` | – | Returns the file's text. | `[SIDERA SYSTEM: File Content (path)]` |
| `FILE_LIST path="…"` | – | Lists files under `data/files/` (or under the given sub-folder). | `[SIDERA SYSTEM: Files]` |
| `STATUS` | – | Reports the current turn. | `[SIDERA SYSTEM: Active Turn under Message …]` |
| `PAUSE reason="…"` | – | Pauses the exchange after this turn; the operator resumes from the popup. | – |
| `STOP` | – | Ends the exchange; nothing more is pasted. | – |
| `READY` | – | Acknowledgement to the Genesis Protocol; never forwarded, never counted as a turn. | – |

Aliases accepted for convenience: `[[MEMORY:category]] … [[/MEMORY]]` (legacy memory
write, project `default`), `SAVE` (memory, or file append when `path=` is given on a
`SIDERA:` tag), `RECALL`, `READ`, `WRITE`, `LIST`, `REMEMBER`, `APPEND`. The
`SIDERA:`-prefixed names above are canonical.

The hemisphere role files use a shorter form. These are executed the same way:

```text
[[MEMORY:category]]
text to remember
[[/MEMORY]]

[[RECALL:category]]
optional search words
[[/RECALL]]

[[READ:relative/path]][[/READ]]

[[SAVE:relative/path]]
whole file content (creates or replaces)
[[/SAVE]]

[[READY:LEFT]]
acknowledgement
[[/READY]]

[[READY:RIGHT]]
acknowledgement
[[/READY]]
```

`[[SAVE:path]]` from a role file writes the file (creates or replaces). A
`[[SIDERA: SAVE path="…"]]` tag still appends. A reply that is only a
`[[READY:LEFT]]` or `[[READY:RIGHT]]` block is that side's handshake
acknowledgement. The other side's block does not count as this side's acknowledgement.

## Rules

- `category`, `project` and `path` may contain letters, numbers, `-`, `_`, `.` and `/`.
  Paths are relative to `data/files/`; `..`, absolute paths, UNC paths and files with
  extensions other than `.md .txt .json .jsonl .csv` are rejected.
- Unknown or malformed tags **fail closed**: the error is logged (`TAG_ERROR`) and
  written to the transcript, nothing is executed for that tag, and the requester
  receives `[SIDERA SYSTEM ERROR: … ; the tag was not executed]`.
- Every executed operation is recorded in the ledger (`tag_operations`) under the
  message that requested it. If the same message is processed again after a crash
  the operations are not repeated.
- A reply consisting only of `READY` (word, tag, or a `[[READY:LEFT]]` /
  `[[READY:RIGHT]]` block) is an acknowledgement and is dropped without being
  forwarded. During the handshake, the block has to name the side that was just
  taught.

## Example exchange

LEFT writes:

```text
Let's fix the working fluid.
[[SIDERA:MEMORY_WRITE category="inventions" project="gyrocell"]]
Baseline working-fluid decision: use Galinstan rather than NaK.
[[/SIDERA]]
```

RIGHT receives only `Let's fix the working fluid.` Later RIGHT writes:

```text
Remind me what we decided.
[[SIDERA:MEMORY_READ category="inventions" project="gyrocell" limit="20"]]
working fluid
[[/SIDERA]]
```

LEFT receives `Remind me what we decided.` and, with the next message pasted into
RIGHT, RIGHT receives:

```text
[SIDERA SYSTEM: Memory Query Results (1 items)]
- [MEM-000001 inventions/gyrocell] Baseline working-fluid decision: use Galinstan rather than NaK.

<LEFT's next reply>
```
