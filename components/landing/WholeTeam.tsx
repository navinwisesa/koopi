import ScrollIn from "@/components/landing/ScrollIn";

const GROUPS = [
  {
    title: "Developers",
    lines: [
      "Edit files and run the project in the sandbox.",
      "Read the diff before it lands.",
      "Steer the agent mid-run when it heads the wrong way.",
    ],
  },
  {
    title: "PMs, designers, founders",
    lines: [
      "Ask Koopi for changes in plain language.",
      "Read a written summary of every proposed change.",
      "Approve or reject it without opening the code.",
    ],
  },
];

export default function WholeTeam() {
  return (
    <section className="border-t border-border">
      <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
        <ScrollIn>
          <h2 className="max-w-2xl text-balance font-display text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
            One room for the whole team
          </h2>
          <p className="mt-4 max-w-xl text-pretty leading-relaxed text-muted">
            Everyone works in the same thread with the same agent. What each person does there depends on the job
            they came to do.
          </p>
        </ScrollIn>

        <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-0">
          {GROUPS.map((g, idx) => (
            <ScrollIn
              key={g.title}
              delay={idx * 120}
              className={`md:px-10 ${idx === 0 ? "md:border-r md:border-border md:pl-0" : "md:pr-0"}`}
            >
              <h3 className="font-display text-xl font-semibold">{g.title}</h3>
              <ul className="mt-4 space-y-3 leading-relaxed text-muted">
                {g.lines.map((l) => (
                  <li key={l} className="max-w-[46ch]">
                    {l}
                  </li>
                ))}
              </ul>
            </ScrollIn>
          ))}
        </div>
      </div>
    </section>
  );
}
