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
    <html lang="en" className="dark">
      <body
        className={`${nunitoSans.variable} ${leagueSpartan.variable} antialiased bg-background text-foreground`}
      >
        {children}
      </body>
    </html>
  );
}
