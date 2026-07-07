import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRevisionSubmitQueue } from "../src/server/revision-submit-queue.js";

describe("revision submit queue", () => {
  it("serializes submit work for the same target while allowing independent targets", async () => {
    const queue = createRevisionSubmitQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = queue.enqueue("codex-desktop:thread-1", async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
      return "first";
    });
    const second = queue.enqueue("codex-desktop:thread-1", async () => {
      events.push("second:start");
      return "second";
    });
    const other = queue.enqueue("traex-cli:session-1", async () => {
      events.push("other:start");
      return "other";
    });

    await other;
    assert.deepEqual(events, ["first:start", "other:start"]);

    releaseFirst();

    assert.equal(await first, "first");
    assert.equal(await second, "second");
    assert.deepEqual(events, [
      "first:start",
      "other:start",
      "first:end",
      "second:start",
    ]);
  });
});
