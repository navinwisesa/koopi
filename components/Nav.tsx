import Link from "next/link";

export default function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/80 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
        <Link href="#top" className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-display text-sm font-bold text-accent-foreground">
            K
          </span>
          <span className="translate-y-[2px] font-display text-lg font-bold tracking-tight">
            Koopi
          </span>
        </Link>

        <span className="hidden h-5 w-px bg-border sm:block" />

        <div className="hidden items-center gap-8 text-sm text-muted sm:flex">
          <a href="#features" className="transition-colors hover:text-foreground">
            Features
          </a>
        </div>

        <Link
          href="/auth"
          className="ml-auto rounded-md bg-accent px-4 py-2 font-display text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Let&apos;s build
        </Link>
      </nav>
    </header>
  );
}
