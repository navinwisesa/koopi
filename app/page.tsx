import Nav from "@/components/Nav";
import Hero from "@/components/Hero";
import Features from "@/components/Features";
import Split from "@/components/landing/Split";
import CatchUpDemo from "@/components/landing/CatchUpDemo";
import MemoryDemo from "@/components/landing/MemoryDemo";
import PersonalityDemo from "@/components/landing/PersonalityDemo";
import JudgmentDemo from "@/components/landing/JudgmentDemo";
import WholeTeam from "@/components/landing/WholeTeam";
import StickyCta from "@/components/landing/StickyCta";
import LandingCta from "@/components/LandingCta";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <div className="landing min-h-screen">
      <noscript>
        <style>{".scroll-in{opacity:1!important;transform:none!important}.demo-step{opacity:1!important}"}</style>
      </noscript>
      <Nav />
      <main>
        <Hero />
        <Features />
        <Split title="Step away. Catch up in one click." visual={<CatchUpDemo />}>
          Come back to a busy thread and Koopi summarizes what happened while you were gone. Flagged risks are
          always listed in full, never buried in the recap.
        </Split>
        <Split title="The room remembers" visual={<MemoryDemo />} visualFirst>
          What your team decides in one thread carries into the others. When Koopi draws on room memory, its reply
          says so.
        </Split>
        <Split title="Set the tone per thread" visual={<PersonalityDemo />}>
          Pick how Koopi talks in each thread: brief, thorough, casual or blunt. Everyone in the thread gets the
          same tone. Try the switcher.
        </Split>
        <WholeTeam />
        <section className="border-t border-border">
          <Split title="You decide what lands" visual={<JudgmentDemo />} visualFirst>
            The agent proposes changes. Your team approves or rejects them, and Koopi flags risks it spots along
            the way. Every call goes into one shared log, so nobody has to ask who signed off.
          </Split>
        </section>
        <LandingCta />
      </main>
      <Footer />
      <StickyCta />
    </div>
  );
}
