"use client";

import { useState } from "react";
import { Bot, Send, Check, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { ProjectFile } from "@/components/RoomView";

type Proposal = { path: string; language: string; code: string };
type Message = { role: "user" | "assistant"; content: string; proposal?: Proposal | null };

// Private, per-user, ephemeral (see app/api/projects/assistant/route.ts's
// header comment for why this is never persisted) — a fresh mount starts
// empty, on purpose. Scoped to the CURRENT project's files, not the room's
// chat memory: a genuinely separate assistant from room-wide Koopi, not
// another entry point into the same one.
export default function ProjectAssistant({
  projectId,
  files,
  activeFile,
  currentUserId,
}: {
  projectId: string;
  files: ProjectFile[];
  activeFile: ProjectFile | null;
  currentUserId: string;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [acceptedFor, setAcceptedFor] = useState<Set<number>>(new Set());

  async function send() {
    const prompt = draft.trim();
    if (!prompt || loading) return;
    setDraft("");
    const nextMessages: Message[] = [...messages, { role: "user", content: prompt }];
    setMessages(nextMessages);
    setLoading(true);
    try {
      const res = await fetch("/api/projects/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          filePath: activeFile?.path ?? null,
          fileContent: activeFile?.content ?? "",
          otherPaths: files.filter((f) => f.id !== activeFile?.id).map((f) => f.path),
          turns: nextMessages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data?.error ?? "Something went wrong." },
        ]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply ?? "", proposal: data.proposal ?? null },
      ]);
    } catch (err) {
      console.error("ProjectAssistant: request failed", err);
      setMessages((prev) => [...prev, { role: "assistant", content: "Request failed — try again." }]);
    } finally {
      setLoading(false);
    }
  }

  // Always lands in project_file_changes as a pending proposal — this
  // component has no path that writes project_files directly, by design
  // (Phase 2's test gate: an accepted suggestion must never be a direct
  // write, even for the user who requested it).
  async function accept(index: number, proposal: Proposal) {
    const targetFile = files.find((f) => f.path === proposal.path) ?? activeFile;
    if (!targetFile) return;
    const supabase = createClient();
    const { error } = await supabase.from("project_file_changes").insert({
      project_file_id: targetFile.id,
      proposed_by: currentUserId,
      proposed_content: proposal.code,
      source: "ai_assistant",
    });
    if (error) {
      console.error("ProjectAssistant: failed to propose change", error);
      return;
    }
    setAcceptedFor((prev) => new Set(prev).add(index));
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Bot className="h-3.5 w-3.5" strokeWidth={1.75} />
            Ask about {activeFile ? activeFile.path : "this project"} — only you see this conversation.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[90%] rounded-lg px-3 py-2 text-left text-xs ${
                m.role === "user" ? "bg-accent/20 text-foreground" : "bg-background text-foreground"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.content}</p>
              {m.proposal && (
                <div className="mt-2 rounded border border-border bg-surface p-2">
                  <p className="mb-1 font-mono text-[10px] text-muted">{m.proposal.path}</p>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-foreground">
                    {m.proposal.code}
                  </pre>
                  <button
                    type="button"
                    onClick={() => void accept(i, m.proposal!)}
                    disabled={acceptedFor.has(i)}
                    className="mt-2 flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <Check className="h-3 w-3" strokeWidth={2} />
                    {acceptedFor.has(i) ? "Proposed — awaiting review" : "Accept as proposed change"}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            Thinking…
          </p>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="flex shrink-0 items-center gap-2 border-t border-border p-2"
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={loading}
          placeholder="Ask the assistant to modify this file…"
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={loading || !draft.trim()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </form>
    </div>
  );
}
