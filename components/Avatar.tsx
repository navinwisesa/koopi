const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-cyan-500",
];

/** Deterministic colour per name, so a given user keeps the same circle. */
function colorFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

const sizes = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
};

export default function Avatar({
  name,
  src,
  size = "md",
  className = "",
}: {
  name: string;
  src?: string | null;
  size?: keyof typeof sizes;
  className?: string;
}) {
  const base = `${sizes[size]} shrink-0 rounded-full ${className}`;

  if (src) {
    return (
      // Remote provider avatars — plain <img> avoids next.config remotePatterns setup.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        className={`${base} object-cover`}
        referrerPolicy="no-referrer"
      />
    );
  }

  const initial = (name.trim()[0] ?? "?").toUpperCase();

  return (
    <span
      aria-hidden="true"
      className={`${base} ${colorFor(name)} flex items-center justify-center font-display font-bold text-white`}
    >
      {initial}
    </span>
  );
}
