const FADE =
  "radial-gradient(ellipse 80% 60% at 50% 0%, black 25%, transparent 100%)";

export default function BackgroundGrid() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      {/* Fine blueprint cells */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(99,134,255,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(99,134,255,0.07) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          maskImage: FADE,
          WebkitMaskImage: FADE,
        }}
      />

      {/* Heavier major lines every 4th cell — reads as a technical drawing */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(99,134,255,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(99,134,255,0.16) 1px, transparent 1px)",
          backgroundSize: "112px 112px",
          maskImage: FADE,
          WebkitMaskImage: FADE,
        }}
      />

      {/* Cool blue wash behind the headline */}
      <div className="absolute left-1/2 top-0 h-[560px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/20 blur-[130px]" />

      {/* Settle the grid back into the page colour at the bottom */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-background" />
    </div>
  );
}
