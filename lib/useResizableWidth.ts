"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

/**
 * Drag-to-resize width for a side panel, persisted per-browser via
 * localStorage (a per-viewer UI preference, not something that belongs in
 * the database or synced between participants).
 *
 * `direction` says which edge the drag handle sits on: "right" for a panel
 * anchored to the left of the screen (dragging right grows it — the
 * sidebar), "left" for a panel anchored to the right (dragging left grows
 * it — the code panel).
 */
export function useResizableWidth({
  storageKey,
  defaultWidth,
  min,
  max,
  direction,
}: {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  direction: "left" | "right";
}) {
  const [width, setWidth] = useState(defaultWidth);
  const widthRef = useRef(defaultWidth);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(defaultWidth);

  // localStorage isn't available during SSR — the default renders first and
  // this corrects it once mounted, matching the rest of this app's
  // client-only-state patterns.
  useEffect(() => {
    const stored = Number(localStorage.getItem(storageKey));
    if (stored && !Number.isNaN(stored)) {
      const clamped = Math.min(max, Math.max(min, stored));
      widthRef.current = clamped;
      setWidth(clamped);
    }
    // Only re-run if the storage key itself changes — min/max are bounds, not
    // triggers for re-reading a value that hasn't moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    function onMouseMove(e: globalThis.MouseEvent) {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const raw = direction === "right" ? startWidthRef.current + delta : startWidthRef.current - delta;
      const clamped = Math.min(max, Math.max(min, raw));
      widthRef.current = clamped;
      setWidth(clamped);
    }
    function onMouseUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(storageKey, String(widthRef.current));
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [direction, min, max, storageKey]);

  const onHandleMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  // Double-click the handle to snap back to the default — the usual escape
  // hatch once someone's dragged it somewhere awkward.
  const onHandleDoubleClick = useCallback(() => {
    widthRef.current = defaultWidth;
    setWidth(defaultWidth);
    localStorage.setItem(storageKey, String(defaultWidth));
  }, [defaultWidth, storageKey]);

  return { width, onHandleMouseDown, onHandleDoubleClick };
}
