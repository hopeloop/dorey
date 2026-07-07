export type PopoverSelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PopoverPositionInput = {
  selectionRect: PopoverSelectionRect;
  viewportWidth: number;
  viewportHeight: number;
  popoverWidth: number;
  estimatedHeight: number;
  margin?: number;
  gap?: number;
};

export type PopoverPosition = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export function getPopoverPosition({
  selectionRect,
  viewportWidth,
  viewportHeight,
  popoverWidth,
  estimatedHeight,
  margin = 12,
  gap = 12,
}: PopoverPositionInput): PopoverPosition {
  const maxHeight = Math.max(120, viewportHeight - margin * 2);
  const width = Math.min(popoverWidth, Math.max(160, viewportWidth - margin * 2));
  const centeredLeft = selectionRect.left + selectionRect.width / 2 - width / 2;
  const left = clamp(centeredLeft, margin, viewportWidth - width - margin);
  const belowTop = selectionRect.top + selectionRect.height + gap;
  const aboveTop = selectionRect.top - estimatedHeight - gap;
  const bottomLimit = viewportHeight - margin;
  const availableHeight = Math.min(estimatedHeight, maxHeight);
  const rawTop =
    belowTop + estimatedHeight <= bottomLimit
      ? belowTop
      : aboveTop >= margin
        ? aboveTop
        : margin;
  const top = clamp(rawTop, margin, bottomLimit - availableHeight);

  return {
    left,
    top,
    width,
    maxHeight,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}
