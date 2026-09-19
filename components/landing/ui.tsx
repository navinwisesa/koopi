// Shared building blocks for the landing page's product vignettes.

export const FRAME =
  "overflow-hidden rounded-xl border border-border-strong bg-surface shadow-[0_30px_60px_-30px_rgba(0,0,0,0.9)]";

/** One beat of a vignette. Plays in sequence once the enclosing <Reveal> is on screen. */
export function Step({
  i,
  className = "",
  children,
}: {
  i: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`demo-step ${className}`} style={{ "--i": i } as React.CSSProperties}>
      {children}
    </div>
  );
}

export function KoopiMark({ size = "h-6 w-6 text-[11px]" }: { size?: string }) {
  return (
    <span
      className={`${size} flex shrink-0 items-center justify-center rounded-md bg-accent font-display font-bold text-accent-foreground`}
    >
      K
    </span>
  );
}
