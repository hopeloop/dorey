import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createRevisionPollBroker } from "../src/server/revision-poll-broker.js";
import { handleRevisionReviewRequest } from "../src/server/revision-review-endpoint.js";

describe("revision review endpoint", () => {
  it("reports and closes the review lifecycle", async () => {
    const payloadRoot = await mkdtemp(path.join(tmpdir(), "review-endpoint-"));

    try {
      const broker = createRevisionPollBroker({ payloadRoot });

      assert.deepEqual(
        handleRevisionReviewRequest({ method: "GET" }, { broker }),
        { status: 200, body: { status: "open" } },
      );
      assert.deepEqual(
        handleRevisionReviewRequest({ method: "POST" }, { broker }),
        { status: 200, body: { status: "review_closed" } },
      );
    } finally {
      await rm(payloadRoot, { force: true, recursive: true });
    }
  });
});
