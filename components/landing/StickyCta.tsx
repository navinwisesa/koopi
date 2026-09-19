"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

// Phones only: a slim action bar once the hero is behind you, out of the way
// again when the closing call to action is on screen.
export default function StickyCta() {
  const [heroVisible, setHeroVisible] = useState(true);
  const [ctaVisible, setCtaVisible] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const hero = document.getElementById("top");
    const cta = document.getElementById("cta");
    const observers: IntersectionObserver[] = [];
    if (hero) {
      const io = new IntersectionObserver(([e]) => setHeroVisible(e.isIntersecting));
      io.observe(hero);
      observers.push(io);
    }
    if (cta) {
      const io = new IntersectionObserver(([e]) => setCtaVisible(e.isIntersecting));
      io.observe(cta);
      observers.push(io);
    }
    return () => observers.forEach((o) => o.disconnect());
  }, []);

  const show = !heroVisible && !ctaVisible;

  return (
    <div
      aria-hidden={!show}
      className={`fixed inset-x-0 bottom-0 z-40 border-t border-border-strong bg-background px-4 py-3 transition-transform duration-300 ease-out sm:hidden ${
        show ? "translate-y-0" : "translate-y-full"
      }`}
    >
      <Link
        href="/auth"
        tabIndex={show ? 0 : -1}
        className="block rounded-md bg-accent px-6 py-3 text-center font-display text-base font-medium text-accent-foreground active:translate-y-px"
      >
        Let&apos;s build
      </Link>
    </div>
  );
}
