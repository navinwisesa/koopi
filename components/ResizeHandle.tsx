"use client";

import type { MouseEvent } from "react";

/**
 * Draggable divider between a resizable panel and the rest of the layout.
 * Deliberately `h-full` on the root, not just a short centered grip — the
 * wrapping element around this stretches to the full panel height (it's a
 * flex sibling in a row), but this component's own root is a plain block by
 * default and won't inherit that height without saying so explicitly, which
 * is why an earlier version rendered as a short segment near the top instead
 * of running the whole border.
 */
export default function ResizeHandle({
  onMouseDown,
  onDoubleClick,
}: {
  onMouseDown: (e: MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize (double-click to reset)"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      className="group relative z-10 flex h-full w-2.5 shrink-0 cursor-col-resize select-none items-stretch justify-center"
    >
      {/* The whole border is the handle — visible at rest (not hover-only),
          thickening and tinting on hover/drag for feedback. */}
      <div className="w-[3px] bg-border/70 transition-colors group-hover:bg-accent group-active:bg-accent" />
    </div>
  );
}
