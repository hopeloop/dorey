import type { CommentAnchor } from "../contracts/index.js";

export type PendingSelection = {
  anchor: CommentAnchor;
  rect: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
};

export function getPendingSelection(root: HTMLElement): PendingSelection | null {
  const selection = window.getSelection();

  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const startBlock = closestCommentBlock(range.startContainer);
  const endBlock = closestCommentBlock(range.endContainer);

  if (!startBlock || !endBlock) {
    return null;
  }

  if (!root.contains(startBlock) || !root.contains(endBlock)) {
    return null;
  }

  const documentBlock = closestDocumentBlock(root, startBlock);
  const anchorBlock = startBlock === endBlock ? startBlock : documentBlock;

  if (!anchorBlock || !anchorBlock.contains(endBlock)) {
    return null;
  }

  const blockId = anchorBlock.dataset.blockId;
  const quote = range.toString();

  if (!blockId || quote.trim().length === 0) {
    return null;
  }

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(anchorBlock);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const startOffset = beforeRange.toString().length;
  const endOffset = startOffset + quote.length;
  const blockText = anchorBlock.textContent ?? "";
  const rect = range.getBoundingClientRect();
  const fallbackRect = anchorBlock.getBoundingClientRect();

  return {
    anchor: {
      blockId,
      startOffset,
      endOffset,
      quote,
      prefix: blockText.slice(Math.max(0, startOffset - 32), startOffset),
      suffix: blockText.slice(endOffset, endOffset + 32),
    },
    rect: {
      top: rect.top || fallbackRect.top,
      left: rect.left || fallbackRect.left,
      width: rect.width || fallbackRect.width,
      height: rect.height || fallbackRect.height,
    },
  };
}

function closestCommentBlock(node: Node): HTMLElement | null {
  const element =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement;

  return element?.closest<HTMLElement>("[data-block-id]") ?? null;
}

function closestDocumentBlock(
  root: HTMLElement,
  block: HTMLElement,
): HTMLElement | null {
  const documentBlock = block.closest<HTMLElement>(
    ".review-markdown[data-block-id]",
  );

  if (documentBlock && root.contains(documentBlock)) {
    return documentBlock;
  }

  if (root.matches(".review-markdown[data-block-id]")) {
    return root;
  }

  return null;
}
