import ScrollIn from "@/components/landing/ScrollIn";

// Text beside a product vignette. `visualFirst` puts the vignette on the left
// at desktop widths; on small screens the text always comes first.
export default function Split({
  title,
  children,
  visual,
  visualFirst = false,
}: {
  title: string;
  children: React.ReactNode;
  visual: React.ReactNode;
  visualFirst?: boolean;
}) {
  return (
    <div
      className={`mx-auto grid max-w-6xl items-center gap-10 px-6 py-14 sm:py-20 lg:gap-20 ${
        visualFirst ? "lg:grid-cols-[7fr_5fr]" : "lg:grid-cols-[5fr_7fr]"
      }`}
    >
      <ScrollIn className={visualFirst ? "lg:order-2" : ""}>
        <h2 className="text-balance font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          {title}
        </h2>
        <p className="mt-4 max-w-md text-pretty leading-relaxed text-muted">{children}</p>
      </ScrollIn>
      <ScrollIn delay={120} className={visualFirst ? "lg:order-1" : ""}>
        {visual}
      </ScrollIn>
    </div>
  );
}
