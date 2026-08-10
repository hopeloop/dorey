---
name: dorey-review-loop
description: Use when a Codex or TraeX task mentions opening, reviewing, waiting in, polling, replying to, or troubleshooting Dorey; when a Markdown or HTML artifact should be reviewed in Dorey; or when Dorey feedback only appears after the user says poll.
---

# Dorey Review Loop

## Core contract

Dorey owns the long-lived review state. An Agent turn handles one bounded action and ends. For Codex Desktop, use the wake bridge; do not keep the launch turn alive with an infinite Bash poll.

```text
launch -> Dorey server remains open -> user submits
                                   -> wake original task -> handle one request -> reply -> turn ends
                                   -> heartbeat fallback checks once per minute
user ends review -> review_closed -> heartbeat stops
```

Read [references/dorey-cli-and-protocol.md](references/dorey-cli-and-protocol.md) before launching, handling feedback, or troubleshooting.

## Open Dorey correctly

1. Run `command -v dorey`, then `dorey --help` when syntax or installation is uncertain. Dorey is a CLI plus local Web UI, not a macOS app.
2. Resolve and verify the absolute input path:
   - one Markdown/HTML file: `dorey --review-file '<absolute-path>'`
   - a folder of Markdown files: `dorey --review-folder '<absolute-path>'`
   - built-in demo only when requested: `dorey --demo`
3. Run `dorey status`. If the configured port belongs to another workspace or target, choose an unused `--port`; do not replace the other review.
4. Do not use bare `dorey`, `open -a Dorey`, or `--preview` for an interactive review.
5. Verify the Web URL, `previewOnly=false`, `deliveryMode`, and launcher target. Missing target means static preview only; report that limitation instead of claiming feedback can return.
6. Tell the user the page is open and explain the active delivery mode.

## Choose delivery by host

### Codex Desktop: wake mode

`codex-desktop:<thread-id>` defaults to `deliveryMode=wake`.

- The launch command starts the server, opens the page, prints `Wake bridge armed`, and exits. Ending that Agent turn is correct.
- Each Dorey submit is durably queued first, then Dorey asks Codex App Server to start a fresh turn in the original task.
- A wake turn contains `requestId`, `payloadPath`, and `replyCommand`. Handle exactly that request, POST the reply, report completion, and end the turn.
- Do not start a second foreground `dorey poll` unless diagnosing wake failure.
- When same-task recurring automations are available, add a one-minute local heartbeat as a fallback. Each heartbeat runs `dorey poll --check --base-url <url> --target <target>` once: `waiting` ends silently, `feedback` handles and replies to one request, and `review_closed` removes the heartbeat. Never keep a heartbeat turn alive between checks.

### Codex CLI or TraeX: foreground mode

CLI targets default to `deliveryMode=foreground` because they do not have the Codex Desktop wake bridge.

- Keep the returned PTY/session ID and read it with short waits.
- Process each `status: "feedback"`, reply, then resume the same PTY.
- Use `--delivery foreground` explicitly only for compatibility or troubleshooting.

### Static preview

Use `--preview` only when the user explicitly wants no Agent feedback. Preview mode may end immediately after opening.

## Handle one feedback request

1. Read `payloadPath`; terminal output can be truncated.
2. Use `request.artifact.markdown` as the base. Address every `comments[].id` and `globalInstruction` without inventing missing context.
3. Produce one complete `BatchRevisionResponse` for the request ID.
4. Before replying after a delayed or raced delivery, query `GET <base-url>/api/agent/submissions/<requestId>` exactly. Do not append `/status`. If it is already `completed`, do not post again.
5. Write the response to a request-specific JSON file and run the supplied `replyCommand` with that file.
6. Require HTTP success with the matching request ID and `status: "completed"`. A local file write is not completion.
7. Tell the user the round is visible in Dorey. In wake/heartbeat mode, end the turn; in foreground mode, resume the saved PTY.

## End deliberately

When the user is done, use Dorey's **结束评审** action or POST `/api/dorey/review`. This changes the lifecycle to `review_closed` so heartbeat and foreground poll can stop cleanly. Then remove any heartbeat and stop only the server/port for this review if shutdown was requested. Never use `dorey stop --all` implicitly.

Dorey normally reviews a temporary workspace. State whether the original source was actually copied back; never imply source overwrite without verifying it.

## Red flags

- Keeping a Codex Desktop launch turn alive in an infinite poll.
- Requiring the user to type `poll` before feedback is noticed.
- Claiming wake succeeded when the request is only queued.
- Launching preview mode for interactive feedback.
- Inventing a thread/session ID or replacing another review's port.
- Treating browser close as `review_closed`.
- Posting two different replies for the same request ID.
