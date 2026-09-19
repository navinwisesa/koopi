"use client";

import { useRevealState } from "@/components/landing/useRevealState";

// Fades and lifts its children in as they scroll into view, and lets them
// settle back out when the user scrolls up past them. The hidden state is
// CSS-only and limited to users who allow motion.
export default function ScrollIn({
  children,
  className = "",
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  const [ref, seen] = useRevealState<HTMLDivElement>(0.15, "0px 0px -8% 0px");

  return (
    <div
      ref={ref}
      data-in={seen}
      className={`scroll-in ${className}`}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </div>
  );
}
