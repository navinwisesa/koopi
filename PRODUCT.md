# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Mixed technical and non-technical teams working together in one shared room: developers plus PMs, designers, and founders. Some write and run code; others chat with the agent, review what it did, and approve or reject its changes. Mobile web is supported (the Project panel has a mobile layout).

## Product Purpose

Koopi is a real-time multiplayer AI agent workspace. A team shares a room with threads, and everyone talks to the same agent (@Koopi) instead of each person having a private assistant. The agent replies in chat, runs code and web apps in a sandbox, searches the web, and edits a shared project. Success is a team that ships together without hand-offs, merge conflicts, or waiting for a turn.

## Positioning

A plain chat assistant or single-player coding agent cannot truthfully claim all three of these together:

- **Shared room, one agent, many humans.** Teammates share threads, presence, and per-thread settings (such as the agent's personality), and can steer the agent mid-stream.
- **Squad memory and judgment log.** The agent accumulates room memory of how the team works. A judgment log records flagged items and approved or rejected agent changes, and catch-up summaries bring people back up to speed.
- **Sandboxed project with an approval flow.** Agent runs execute in a sandbox with a project file tree, terminal, and live preview, and humans decide whether the agent's changes land.

## Operating Context

- A room contains threads. Members are humans; Koopi is not a taggable member and has no profile row. Each person controls their own "Ask Koopi" toggle per thread, so Koopi may answer one participant and not another.
- The room view holds chat, a member list, a Project panel (collapsible file tree, code editor, terminal, preview, and a proposed-changes view), a judgment log, and catch-up summaries.
- People join a room by code or invite. Auth is Supabase (email, plus password update flow).
- Replies are routed by intent: code requests to a code model, other requests to an Efficient or Powerful tier. Koopi is told not to reply with markdown tables.

## Capabilities and Constraints

- Stack: Next.js 15 (App Router), React 19, Tailwind CSS 4, Supabase (auth, realtime, RPC, migrations), Groq and OpenRouter for models, E2B sandboxes, Tavily web search, CodeMirror editor, lucide-react icons.
- Thread-wide agent personality: Default, Concise, Explanatory, Casual, Direct.
- Landing page names four features: Shared Workspace, Mid-Stream Steering, Squad Memory, No-Git Vibe-Coding (parallel sandboxes that auto-integrate).
- Fonts currently loaded: League Spartan (display) and Nunito Sans. Not confirmed as a brand commitment.
- Undecided: pricing, licensing, deployment target, and whether the product name is stylized beyond "Koopi".

## Brand Commitments

Name: Koopi. Landing headline and voice are informal, builder-to-builder ("What will you make today?", "Let's build"). No binding visual constraints were stated during init.

## Evidence on Hand

The running app and its landing copy (`components/Hero.tsx`, `components/Features.tsx`). The product is early stage: there are no confirmed customers, testimonials, benchmarks, or usage numbers. Future work must not fabricate any.

## Product Principles

- The room is the unit, not the individual: every surface should make it clear who is present, who did what, and what the agent is doing right now.
- Humans stay in charge of the agent's consequences: agent changes are visible, attributable, and approvable or rejectable by people, including non-coders.
- Shared context beats private context: memory, flagged items, and catch-ups exist so no teammate is left behind by a running session.
- Serve technical and non-technical members in the same view without splitting them into separate products.
- Claims stay honest at the early stage: describe what the product does today, not proof it does not have.

## Accessibility & Inclusion

No product-specific requirement established. Non-technical members should not need to read code to understand what the agent did or to approve it.
