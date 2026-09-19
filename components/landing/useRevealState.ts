"use client";

import { useEffect, useRef, useState } from "react";

// True once the element has scrolled `threshold` of the way into view. It goes
// back to false only when the element leaves through the bottom of the screen
// (the user scrolled back up past it), so content already read above the fold
// never vanishes, and the wait between the two states prevents flicker.
export function useRevealState<T extends HTMLElement>(threshold: number, rootMargin: string) {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.intersectionRatio >= threshold) {
          setShown(true);
        } else if (!entry.isIntersecting && entry.boundingClientRect.top > 0) {
          setShown(false);
        }
      },
      { threshold: [0, threshold], rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [threshold, rootMargin]);

  return [ref, shown] as const;
}
