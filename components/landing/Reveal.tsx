"use client";

import { useRevealState } from "@/components/landing/useRevealState";

// Holds its children's `.demo-step` elements hidden until the block has scrolled
// meaningfully into view, then plays them in. Scrolling back up past the block
// hides them again so the sequence replays on the next approach. Hiding is
// CSS-only and limited to users who allow motion, so no-JS and reduced-motion
// see everything.
export default function Reveal({ children }: { children: React.ReactNode }) {
  const [ref, played] = useRevealState<HTMLDivElement>(0.6, "0px 0px -20% 0px");

  return (
    <div ref={ref} data-play={played}>
      {children}
    </div>
  );
}
