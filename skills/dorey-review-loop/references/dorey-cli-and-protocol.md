# Dorey CLI and reply protocol

## Launch matrix

Resolve `dorey_bin="$(command -v dorey)"` and use an absolute input path.

| Intent | Command shape | Expected lifecycle |
|---|---|---|
| Codex Desktop review | `"$dorey_bin" --review-file '<absolute-path>'` | `foreground`; retain PTY and launch turn |
| CLI review | `"$dorey_bin" --review-file '<absolute-path>'` | `foreground`; retain PTY |
| Review a Markdown folder | replace `--review-file` with `--review-folder` | delivery inferred from target |
| Open built-in demo | `"$dorey_bin" --demo` | preview unless a real target is supplied |
| Force foreground diagnostics | add `--delivery foreground` | retain PTY |
| Static UI only | add `--preview` | no Agent feedback |
| Check once | `"$dorey_bin" poll --check --base-url '<url>' --target '<target>'` | immediate `waiting`, `feedback`, or `review_closed`; process exits |
| Inspect server | `"$dorey_bin" status --port <port>` | read-only |
| Stop this server | `"$dorey_bin" stop --port <port>` | explicit shutdown |

Add `--port <unused-port>` when the default port serves another workspace or target. Launch from the task's relevant working directory. Let Dorey detect `CODEX_THREAD_ID`, `CODEX_CLI_SESSION_ID`, or TraeX session environment; use `--target` only when verified.

## Foreground delivery semantics

Submission order is:

1. Dorey persists `payload.json` and creates a queued request ID.
2. The foreground poll attached to the original task claims the request with a delivery lease.
3. The poll returns `requestId`, `payloadPath`, and `replyCommand` to that active task.
4. The Agent posts one reply, then keeps the same foreground poll alive for later rounds. Completion is idempotent.

If the poll response disconnects before it is written, Dorey releases the request back to the queue. If an Agent abandons a delivered request, its lease expires and a later poll can reclaim it. `dorey poll --check` performs one immediate recovery check; it does not wake an ended task.

Interactive queue state lives under `.local/dorey-submissions/<review>/active/`, where the review namespace is stable for the same source, target, and port. A normal relaunch reuses that active queue. After `review_closed`, the next launch archives the closed state and starts a new active queue.

## Feedback and reply

Poll data contains at least `requestId`, `payloadPath`, `replyCommand`, and target context. Read `payloadPath` even when terminal output includes the request.

Return exactly one object:

```json
{
  "revisedMarkdown": "complete revised Markdown",
  "summary": "concise revision summary",
  "addressedComments": [
    {
      "commentId": "the original comment id",
      "resolution": "what changed or why it was not changed"
    }
  ]
}
```

Write valid JSON to a request-specific response file. Execute the emitted `replyCommand`, replacing `@response.json` with the actual file. Require a matching request ID and `status: "completed"`.

The exact status endpoint is `GET <base-url>/api/agent/submissions/<requestId>`. There is no trailing `/status`. Use it before replying after a delayed or reclaimed delivery; if status is already `completed`, keep that first response and do not POST another.

The Web UI lists unacknowledged submissions with `GET /api/agent/submissions?target=<target>&unacknowledged=1`, restores at most the latest pending result, and POSTs `/api/agent/submissions/<requestId>/acknowledge` only after applying a completed response.

## Troubleshooting

| Symptom | Meaning and action |
|---|---|
| Bare command prints help | Relaunch with `--review-file`, `--review-folder`, or `--demo`. |
| `previewOnly=true` | No interactive target was detected or preview was requested. |
| `Polling codex-desktop:...` | Healthy interactive launch; keep the command and current turn alive. |
| Submit stays queued | Check the page's Agent presence. Resume foreground polling in the original task; inspect `.local/dorey/server.log`. |
| Feedback appears only after user says poll | No foreground poll was attached. Relaunch from the original task or run the printed poll command there and keep it alive. |
| `waiting` from `--check` | No work now; end this check turn. |
| `review_closed` | Stop foreground polling. |
| Submit was queued before review close | It remains durable but is not newly claimed; already delivered work may still reply. |
| Browser closed | UI closed only; review lifecycle may still be open. |
| Ended Agent turn | Dorey cannot wake it; feedback remains durable until a foreground poll reconnects. |

Do not use `dorey stop --all` unless the user explicitly asks to stop every Dorey server.
