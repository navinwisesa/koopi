const FADE =
  "linear-gradient(to bottom, black 0%, black 35%, transparent 75%)";

// A quiet drafting grid behind the headline only. It fades out before the
// product window so the demo sits on a clean ground.
export default function BackgroundGrid() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[640px] overflow-hidden"
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(154,171,255,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(154,171,255,0.06) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
          maskImage: FADE,
          WebkitMaskImage: FADE,
        }}
      />
    </div>
  );
}
