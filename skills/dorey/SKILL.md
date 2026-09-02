---
name: dorey
description: Use only when the user explicitly mentions Dorey; explicitly asks to use Dorey to review a file or directory; queries the status of a Dorey server or Dorey review; or operates or troubleshoots an existing Dorey review or port.
---

# Dorey

Dorey is a local document-review CLI and Web UI. It sends comments to the Codex or TraeX task that launched it and displays revisions and diffs.

## Commands

| Intent | Command |
| --- | --- |
| Review one file | `dorey --review-file '<absolute-path>'` |
| Review a folder | `dorey --review-folder '<absolute-path>'` |
| Demo or static preview | `dorey --demo` or add `--preview` |
| Diagnose state | `dorey doctor --port <port>` |
| Print raw health | `dorey status --port <port>` |
| Stop one server | `dorey stop --port <port>` |
| Show help | `dorey --help` |

Interactive launches keep a foreground poll in the same command. Keep the command and Agent turn alive until the user ends the review; the user should not need to ask for `poll`. Without an Agent target, Dorey opens in preview mode and cannot return comments.

If a port belongs to another review, use a different `--port`. Browser close does not end a review; use **结束评审**.
