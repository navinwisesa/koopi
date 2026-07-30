import BackgroundGrid from "@/components/BackgroundGrid";
import UpdatePasswordGate from "@/components/UpdatePasswordGate";

export default function UpdatePasswordPage() {
  return (
    <div className="relative flex min-h-screen items-start justify-center overflow-hidden px-6 pb-16 pt-16 sm:pt-20">
      <BackgroundGrid />

      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-display text-sm font-bold text-accent-foreground">
            K
          </span>
          <span className="translate-y-[2px] font-display text-lg font-bold tracking-tight">
            Koopi
          </span>
        </div>

        <div className="rounded-xl border border-border bg-surface p-8">
          <UpdatePasswordGate />
        </div>
      </div>
    </div>
  );
}
