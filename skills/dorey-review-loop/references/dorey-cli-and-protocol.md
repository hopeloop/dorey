# Dorey CLI and reply protocol

## Launch matrix

Resolve `dorey_bin="$(command -v dorey)"` and use an absolute input path.

| Intent | Command shape | Expected lifecycle |
|---|---|---|
| Codex Desktop review | `"$dorey_bin" --review-file '<absolute-path>'` | `wake`; launch command exits after arming bridge |
| CLI review | `"$dorey_bin" --review-file '<absolute-path>'` | `foreground`; retain PTY |
| Review a Markdown folder | replace `--review-file` with `--review-folder` | delivery inferred from target |
| Open built-in demo | `"$dorey_bin" --demo` | preview unless a real target is supplied |
| Force foreground diagnostics | add `--delivery foreground` | retain PTY |
| Static UI only | add `--preview` | no Agent feedback |
| Check once | `"$dorey_bin" poll --check --base-url '<url>' --target '<target>'` | immediate `waiting`, `feedback`, or `review_closed`; process exits |
| Inspect server | `"$dorey_bin" status --port <port>` | read-only |
| Stop this server | `"$dorey_bin" stop --port <port>` | explicit shutdown |

Add `--port <unused-port>` when the default port serves another workspace or target. Launch from the task's relevant working directory. Let Dorey detect `CODEX_THREAD_ID`, `CODEX_CLI_SESSION_ID`, or TraeX session environment; use `--target` only when verified.

## Wake bridge semantics

The wake bridge is a notifier, not the queue. Submission order is:

1. Dorey persists `payload.json` and creates a queued request ID.
2. The submit endpoint returns immediately.
3. For a Codex Desktop target, Dorey resumes the original thread through Codex App Server and starts a short turn containing `requestId`, `payloadPath`, and `replyCommand`.
4. The Agent posts one reply. Completion is idempotent: if wake and heartbeat race, the first completed response remains authoritative.

If wake fails because the task is active, App Server is unavailable, or a transient error occurs, the queued request remains available. Use heartbeat or `poll --check`; do not resubmit blindly.

## Feedback and reply

Poll/wake data contains at least `requestId`, `payloadPath`, `replyCommand`, and target context. Read `payloadPath` even when terminal output includes the request.

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

The exact status endpoint is `GET <base-url>/api/agent/submissions/<requestId>`. There is no trailing `/status`. Use it before replying when wake and heartbeat may have raced; if status is already `completed`, keep that first response and do not POST another.

## Troubleshooting

| Symptom | Meaning and action |
|---|---|
| Bare command prints help | Relaunch with `--review-file`, `--review-folder`, or `--demo`. |
| `previewOnly=true` | No interactive target was detected or preview was requested. |
| `Wake bridge armed` | Healthy Codex Desktop launch; allow the current turn to end. |
| Submit stays queued | Run one `poll --check`; inspect server stderr for `[dorey:wake]`; keep the same request ID. |
| Feedback appears only after user says poll | The old skill/runtime used foreground polling without a live turn. Switch Codex Desktop to wake and install a heartbeat fallback. |
| `waiting` from `--check` | No work now; end this check turn. |
| `review_closed` | Delete the heartbeat and stop foreground polling. |
| Browser closed | UI closed only; review lifecycle may still be open. |
| Cursor or Claude Code session | No native wake adapter currently; use an explicit supported foreground adapter or state the limitation. |

Do not use `dorey stop --all` unless the user explicitly asks to stop every Dorey server.
