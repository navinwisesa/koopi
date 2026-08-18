import type { Metadata } from "next";
import { Nunito_Sans, League_Spartan } from "next/font/google";
import "./globals.css";

const nunitoSans = Nunito_Sans({
  variable: "--font-nunito-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const leagueSpartan = League_Spartan({
  variable: "--font-league-spartan",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Koopi — Build anything... with your bros.",
  description:
    "Koopi is a real-time multiplayer AI coding tool for dev teams. Shared workspaces, mid-stream steering, and squad memory that gets smarter the more you ship.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning is scoped to this element's own attributes
    // only (not children/content) — needed because at least one browser
    // extension (seen live: a "crosspilot-bridged" attribute, not anything
    // this app renders) injects attributes onto <html> before React
    // hydrates. Next.js's own hydration-mismatch docs name this exact
    // pattern (Grammarly, password managers, etc. cause the identical
    // warning) as the sanctioned fix — a real mismatch in actual page
    // content would still surface normally, this only quiets the false
    // positive from something outside the app's control.
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${nunitoSans.variable} ${leagueSpartan.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
