export default function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent font-display text-xs font-bold text-accent-foreground">
            K
          </span>
          <span className="translate-y-[2px] font-display font-bold text-foreground">
            Koopi
          </span>
        </div>
        <p>&copy; {new Date().getFullYear()} Koopi. All rights reserved.</p>
      </div>
    </footer>
  );
}
