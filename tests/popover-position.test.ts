import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getPopoverPosition } from "../src/review/popover-position.js";

describe("comment popover positioning", () => {
  it("keeps an expanded comment form inside a short viewport", () => {
    const position = getPopoverPosition({
      selectionRect: {
        left: 280,
        top: 240,
        width: 180,
        height: 28,
      },
      viewportWidth: 900,
      viewportHeight: 580,
      popoverWidth: 320,
      estimatedHeight: 390,
    });

    assert.equal(position.left, 210);
    assert.equal(position.top, 12);
    assert.equal(position.width, 320);
    assert.equal(position.maxHeight, 556);
    assert.ok(position.top + position.maxHeight <= 580);
  });

  it("places a compact action under the selection when there is room", () => {
    const position = getPopoverPosition({
      selectionRect: {
        left: 400,
        top: 120,
        width: 80,
        height: 22,
      },
      viewportWidth: 1000,
      viewportHeight: 720,
      popoverWidth: 220,
      estimatedHeight: 58,
    });

    assert.equal(position.left, 330);
    assert.equal(position.top, 154);
    assert.equal(position.maxHeight, 696);
  });

  it("clamps a compact action into the viewport when the selection is offscreen", () => {
    const position = getPopoverPosition({
      selectionRect: {
        left: 300,
        top: 760,
        width: 120,
        height: 24,
      },
      viewportWidth: 900,
      viewportHeight: 620,
      popoverWidth: 320,
      estimatedHeight: 58,
    });

    assert.equal(position.top, 550);
    assert.ok(position.top + 58 <= 608);
  });
});
