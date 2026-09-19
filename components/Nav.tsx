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

        <div className="ml-4 hidden items-center gap-8 text-sm text-muted sm:flex">
          <a href="#features" className="transition-colors duration-150 hover:text-foreground">
            Features
          </a>
        </div>

        <Link
          href="/auth"
          className="ml-auto rounded-md bg-accent px-4 py-2 font-display text-sm font-medium text-accent-foreground transition-[background-color,transform] duration-150 hover:bg-[#1f3af5] active:translate-y-px"
        >
          Let&apos;s build
        </Link>
      </nav>
    </header>
  );
}
