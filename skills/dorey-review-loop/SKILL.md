---
name: dorey-review-loop
description: Use when a Codex or TraeX task mentions opening, reviewing, waiting in, polling, replying to, or troubleshooting Dorey; when a Markdown or HTML artifact should be reviewed in Dorey; or when Dorey feedback only appears after the user says poll.
---

# Dorey Review Loop

## Core contract

Dorey owns durable review state, while the task that launched it owns the live delivery channel. Keep Dorey's foreground poll attached to that active Agent turn; Dorey does not try to resume an ended Codex task.

```text
launch -> foreground poll waits in original task -> user submits
       -> same poll returns one request -> Agent handles and replies -> poll waits again
user ends review -> review_closed -> foreground poll exits
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

### Codex Desktop: foreground mode

`codex-desktop:<thread-id>` defaults to `deliveryMode=foreground`.

- The launch command starts the server, opens the page, and remains attached to a long poll. Keep its PTY/session alive.
- Each submit is persisted before the waiting poll claims it. The browser shows `listening`, `working`, or `waiting` from server-derived presence.
- Queue state uses a stable namespace derived from review source, target, and port. Relaunching the same open review recovers queued, delivered, and completed submissions instead of starting from an unrelated temporary queue.
- A delivered request has a lease. If the HTTP response disconnects before completion it is returned to the queue; an abandoned lease expires and can be claimed again.
- Do not background the poll or let the launch turn finish while review is active. An ended Codex turn has no supported Dorey wake path.
- `dorey poll --check` is a one-shot diagnostic/recovery command, not an automatic callback mechanism.

### Codex CLI or TraeX: foreground mode

CLI targets also default to `deliveryMode=foreground`.

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
7. Tell the user the round is visible in Dorey, then resume the saved foreground PTY.

The browser restores only unacknowledged submissions after refresh. Once a completed response has been applied, Dorey acknowledges it so later refreshes do not replay the same revision.

## End deliberately

When the user is done, use Dorey's **结束评审** action or POST `/api/dorey/review`. This changes the lifecycle to `review_closed`: queued work is no longer claimed, the foreground poll stops, and an already delivered in-flight reply may still complete. A later launch archives that closed queue and opens a fresh review. Stop only the server/port for this review if shutdown was requested. Never use `dorey stop --all` implicitly.

Dorey normally reviews a temporary workspace. State whether the original source was actually copied back; never imply source overwrite without verifying it.

## Red flags

- Letting a Codex Desktop launch turn end while review is still active.
- Requiring the user to type `poll` before feedback is noticed.
- Claiming an ended Codex task will be automatically woken.
- Launching preview mode for interactive feedback.
- Inventing a thread/session ID or replacing another review's port.
- Treating browser close as `review_closed`.
- Posting two different replies for the same request ID.
