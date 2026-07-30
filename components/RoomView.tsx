"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Link2,
  Check,
  Square,
  ArrowUp,
  PanelLeft,
  MessageSquarePlus,
  Terminal,
} from "lucide-react";
import Avatar from "@/components/Avatar";
import NewChatModal from "@/components/NewChatModal";
import ProfileMenu from "@/components/ProfileMenu";
import RoomSidebar from "@/components/RoomSidebar";
import { presenceOf } from "@/lib/presence";
import { createClient } from "@/lib/supabase/client";

export type ChatMessage = {
  id: string;
  threadId: string;
  senderType: "user" | "agent";
  senderId: string | null;
  content: string;
  status: "streaming" | "complete" | "interrupted";
  type: "text" | "tool_call" | "tool_result";
  interruptedBy: string | null;
  createdAt: string;
};

export type RoomMember = {
  userId: string;
  username: string;
  avatarUrl: string | null;
  lastSeenAt: string | null;
  joinedAt: string | null;
};

export type Thread = {
  id: string;
  createdBy: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

const HEARTBEAT_MS = 30_000;
// Tailwind's `lg` breakpoint — below this the sidebar is a drawer that
// should get out of the way after a selection; above it, it stays put.
const DRAWER_BREAKPOINT_PX = 1024;

function isNarrowViewport() {
  return typeof window !== "undefined" && window.innerWidth < DRAWER_BREAKPOINT_PX;
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ToolCallPayload = { code: string; language: string };
type ToolResultPayload = { stdout: string; stderr: string; exit_code: number };

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const KOOPI_MENTION = "Koopi";

// Finds the "@partial" fragment the cursor is currently sitting inside, if any —
// an "@" preceded by start-of-string or whitespace, with no whitespace since.
function detectMention(
  text: string,
  cursor: number
): { start: number; query: string } | null {
  let i = cursor;
  while (i > 0 && !/\s/.test(text[i - 1])) {
    i--;
    if (text[i] === "@") {
      const before = text[i - 1];
      if (i === 0 || /\s/.test(before)) {
        return { start: i, query: text.slice(i + 1, cursor) };
      }
      return null;
    }
  }
  return null;
}

function mentionsKoopi(text: string) {
  return new RegExp(`(^|\\s)@${KOOPI_MENTION}\\b`, "i").test(text);
}

function renderWithMentions(text: string, knownNames: string[]): ReactNode {
  if (!knownNames.length || !text.includes("@")) return text;
  const lower = new Set(knownNames.map((n) => n.toLowerCase()));
  const parts = text.split(/(@[A-Za-z0-9_]+)/g);
  return parts.map((part, i) =>
    part.startsWith("@") && lower.has(part.slice(1).toLowerCase()) ? (
      <span key={i} className="rounded bg-accent/20 px-1 font-medium text-accent">
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

function rowToThread(row: Record<string, unknown>): Thread {
  return {
    id: row.id as string,
    createdBy: (row.created_by as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export default function RoomView({
  roomId,
  initialName,
  isOwner,
  currentUserId,
  currentUserEmail,
  initialMessages,
  initialMembers,
  initialThreads,
  initialThreadParticipants,
}: {
  roomId: string;
  initialName: string;
  isOwner: boolean;
  currentUserId: string;
  currentUserEmail: string;
  initialMessages: ChatMessage[];
  initialMembers: RoomMember[];
  initialThreads: Thread[];
  initialThreadParticipants: Record<string, string[]>;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [members, setMembers] = useState<RoomMember[]>(initialMembers);
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [threadParticipants, setThreadParticipants] = useState<
    Record<string, string[]>
  >(initialThreadParticipants);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    // Threads arrive newest-first, so the most recent conversation opens.
    initialThreads[0]?.id ?? null
  );
  const [newChatOpen, setNewChatOpen] = useState(false);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [mentionState, setMentionState] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(initialName);

  const [now, setNow] = useState(() => Date.now());

  const bottomRef = useRef<HTMLDivElement>(null);

  const threadMessages = useMemo(
    () =>
      activeThreadId
        ? messages.filter((m) => m.threadId === activeThreadId)
        : [],
    [messages, activeThreadId]
  );

  const streamingMessage = threadMessages.find((m) => m.status === "streaming");
  const isStreaming = Boolean(streamingMessage);

  const memberById = useMemo(() => {
    const map = new Map<string, RoomMember>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  const activeThreadParticipantIds = useMemo(
    () => (activeThreadId ? (threadParticipants[activeThreadId] ?? []) : []),
    [activeThreadId, threadParticipants]
  );

  // Everyone the @ dropdown can offer, excluding yourself — tagging yourself
  // doesn't do anything useful.
  const mentionMembers = useMemo(
    () =>
      activeThreadParticipantIds
        .filter((id) => id !== currentUserId)
        .map((id) => memberById.get(id))
        .filter((m): m is RoomMember => Boolean(m)),
    [activeThreadParticipantIds, memberById, currentUserId]
  );

  const mentionMemberByName = useMemo(() => {
    const map = new Map<string, RoomMember>();
    for (const m of mentionMembers) map.set(m.username, m);
    return map;
  }, [mentionMembers]);

  const mentionCandidates = useMemo(
    () => [KOOPI_MENTION, ...mentionMembers.map((m) => m.username)],
    [mentionMembers]
  );

  // Everyone a message could legitimately mention, including yourself — used
  // to decide what to highlight when rendering someone else's message.
  const allMentionNames = useMemo(() => {
    const names = activeThreadParticipantIds
      .map((id) => memberById.get(id)?.username)
      .filter((n): n is string => Boolean(n));
    return [KOOPI_MENTION, ...names];
  }, [activeThreadParticipantIds, memberById]);

  const mentionOptions = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.toLowerCase();
    return mentionCandidates.filter((name) => name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mentionState, mentionCandidates]);

  // A thread with 2+ people is a group conversation — Koopi only jumps in
  // when explicitly tagged there, so humans can talk without waking it up.
  // Solo threads (just you) keep the old always-respond behavior.
  const requiresMention = activeThreadParticipantIds.length >= 2;

  // --- realtime: messages -------------------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`room:${roomId}:messages`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown> | null;
          if (!row?.id) return;

          const next: ChatMessage = {
            id: row.id as string,
            threadId: row.thread_id as string,
            senderType: row.sender_type as ChatMessage["senderType"],
            senderId: (row.sender_id as string | null) ?? null,
            content: (row.content as string) ?? "",
            status: row.status as ChatMessage["status"],
            type: (row.type as ChatMessage["type"]) ?? "text",
            interruptedBy: (row.interrupted_by as string | null) ?? null,
            createdAt: row.created_at as string,
          };

          setMessages((prev) => {
            const at = prev.findIndex((m) => m.id === next.id);
            if (at === -1) {
              return [...prev, next].sort((a, b) =>
                a.createdAt.localeCompare(b.createdAt)
              );
            }
            const copy = [...prev];
            copy[at] = next;
            return copy;
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId]);

  // --- realtime: threads --------------------------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`room:${roomId}:threads`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "threads",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const gone = (payload.old as Record<string, unknown> | null)?.id as
              | string
              | undefined;
            if (!gone) return;
            setThreads((prev) => prev.filter((t) => t.id !== gone));
            setActiveThreadId((cur) => (cur === gone ? null : cur));
            return;
          }

          const row = payload.new as Record<string, unknown> | null;
          if (!row?.id) return;
          const next = rowToThread(row);

          setThreads((prev) => {
            const at = prev.findIndex((t) => t.id === next.id);
            const merged =
              at === -1
                ? [...prev, next]
                : prev.map((t) => (t.id === next.id ? next : t));
            return merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId]);

  // --- realtime: thread participants (drives multi-person chat labels) ----
  useEffect(() => {
    // thread_participants carries no room_id, so this subscribes unfiltered
    // and relies on RLS to only deliver rows for threads we're invited to —
    // the same guarantee already proven for the threads/messages channels.
    const channel = supabase
      .channel(`room:${roomId}:thread-participants`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "thread_participants" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as Record<string, unknown> | null;
            const threadId = old?.thread_id as string | undefined;
            const userId = old?.user_id as string | undefined;
            if (!threadId || !userId) return;
            setThreadParticipants((prev) => {
              const list = prev[threadId];
              if (!list) return prev;
              return { ...prev, [threadId]: list.filter((id) => id !== userId) };
            });
            return;
          }

          const row = payload.new as Record<string, unknown> | null;
          const threadId = row?.thread_id as string | undefined;
          const userId = row?.user_id as string | undefined;
          if (!threadId || !userId) return;

          setThreadParticipants((prev) => {
            const list = prev[threadId] ?? [];
            if (list.includes(userId)) return prev;
            return { ...prev, [threadId]: [...list, userId] };
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId]);

  // --- realtime: participants --------------------------------------------
  const refreshMembers = useCallback(async () => {
    const { data } = await supabase
      .from("participants")
      .select(
        "user_id, display_name, last_seen_at, joined_at, profiles(username, avatar_url)"
      )
      .eq("room_id", roomId);

    if (!data) return;

    setMembers(
      data.map((row) => {
        const raw = row as unknown as {
          user_id: string;
          display_name: string | null;
          last_seen_at: string | null;
          joined_at: string | null;
          profiles:
            | { username: string | null; avatar_url: string | null }
            | { username: string | null; avatar_url: string | null }[]
            | null;
        };
        const prof = Array.isArray(raw.profiles) ? raw.profiles[0] : raw.profiles;
        return {
          userId: raw.user_id,
          username: prof?.username ?? raw.display_name ?? "Someone",
          avatarUrl: prof?.avatar_url ?? null,
          lastSeenAt: raw.last_seen_at,
          joinedAt: raw.joined_at,
        };
      })
    );
  }, [supabase, roomId]);

  useEffect(() => {
    const channel = supabase
      .channel(`room:${roomId}:participants`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "participants",
          filter: `room_id=eq.${roomId}`,
        },
        () => {
          void refreshMembers();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId, refreshMembers]);

  // --- presence heartbeat -------------------------------------------------
  useEffect(() => {
    async function beat() {
      await supabase
        .from("participants")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("room_id", roomId)
        .eq("user_id", currentUserId);
    }

    void beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [supabase, roomId, currentUserId]);

  // Re-evaluate presence windows without needing a new event.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(id);
  }, []);

  // --- auto-scroll --------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [threadMessages]);

  // --- actions ------------------------------------------------------------
  function handleThreadCreated(created: Thread, participantIds: string[]) {
    setThreads((prev) =>
      prev.some((t) => t.id === created.id)
        ? prev
        : [created, ...prev].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    );
    // Seed participants immediately so the directory groups it correctly
    // right away, instead of waiting on the realtime round trip.
    setThreadParticipants((prev) => ({ ...prev, [created.id]: participantIds }));
    setActiveThreadId(created.id);
    setNewChatOpen(false);
    if (isNarrowViewport()) setSidebarOpen(false);
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || isStreaming || !activeThreadId) return;

    const threadId = activeThreadId;
    // A group thread only wakes Koopi up when it's actually tagged — humans
    // can otherwise talk amongst themselves without an uninvited reply.
    const shouldInvokeAgent = !requiresMention || mentionsKoopi(text);
    setError(null);
    setSending(true);
    setDraft("");
    setMentionState(null);

    try {
      const { data: inserted, error: insertError } = await supabase
        .from("messages")
        .insert({
          room_id: roomId,
          thread_id: threadId,
          sender_type: "user",
          sender_id: currentUserId,
          content: text,
          status: "complete",
        })
        .select("id")
        .single();
      if (insertError) throw insertError;

      if (!shouldInvokeAgent) return;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, triggerMessageId: inserted.id }),
      });

      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? "The agent could not respond.");
      }

      // Content lands via realtime; draining keeps the connection open.
      await res.text();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  async function handleStop() {
    if (!streamingMessage) return;
    setError(null);

    const { error: stopError } = await supabase
      .from("messages")
      .update({ status: "interrupted", interrupted_by: currentUserId })
      .eq("id", streamingMessage.id)
      .eq("status", "streaming");

    if (stopError) setError(stopError.message);
  }

  async function saveName() {
    const trimmed = nameDraft.trim();
    setEditingName(false);
    if (!trimmed || trimmed === name) {
      setNameDraft(name);
      return;
    }

    setName(trimmed);
    const { error: nameError } = await supabase
      .from("rooms")
      .update({ name: trimmed })
      .eq("id", roomId);

    if (nameError) {
      setName(name);
      setNameDraft(name);
      setError("Could not rename the room.");
    }
  }

  function handleUsernameSaved(next: string) {
    setMembers((prev) =>
      prev.map((m) => (m.userId === currentUserId ? { ...m, username: next } : m))
    );
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Couldn't copy — copy the URL from the address bar.");
    }
  }

  function handleComposerChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setDraft(value);
    const cursor = e.target.selectionStart ?? value.length;
    const mention = detectMention(value, cursor);
    setMentionState(mention);
    setMentionIndex(0);
  }

  function selectMention(name: string) {
    if (!mentionState) return;
    const cursor = mentionState.start + 1 + mentionState.query.length;
    const before = draft.slice(0, mentionState.start);
    const after = draft.slice(cursor);
    const next = `${before}@${name} ${after}`;
    setDraft(next);
    setMentionState(null);

    const caretPos = before.length + name.length + 2; // "@" + name + trailing space
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caretPos, caretPos);
      }
    });
  }

  function onInputKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionState && mentionOptions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionOptions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectMention(mentionOptions[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionState(null);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend(e as unknown as FormEvent);
    }
  }

  return (
    <div className="flex h-screen bg-background">
      <RoomSidebar
        threads={threads}
        threadParticipants={threadParticipants}
        members={members}
        activeThreadId={activeThreadId}
        currentUserId={currentUserId}
        now={now}
        onSelectThread={(id) => {
          setActiveThreadId(id);
          if (isNarrowViewport()) setSidebarOpen(false);
        }}
        onNewChat={() => setNewChatOpen(true)}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---------- top bar ---------- */}
        <header className="shrink-0 border-b border-border">
          <div className="flex items-center gap-3 px-6 py-3">
            {!sidebarOpen && (
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label="Show chat directory"
                className="shrink-0 text-muted transition-colors hover:text-foreground"
              >
                <PanelLeft className="h-4 w-4" strokeWidth={1.75} />
              </button>
            )}

            <div className="flex min-w-0 items-center gap-2">
              <Link href="/dashboard" className="flex shrink-0 items-center">
                <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-display text-sm font-bold text-accent-foreground">
                  K
                </span>
              </Link>

              {editingName ? (
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={saveName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") {
                      setNameDraft(name);
                      setEditingName(false);
                    }
                  }}
                  className="min-w-0 translate-y-px rounded-md border border-accent bg-background px-2 py-1 font-display text-base font-semibold focus:outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => isOwner && setEditingName(true)}
                  title={isOwner ? "Click to rename" : undefined}
                  className={`min-w-0 translate-y-px truncate rounded-md px-2 py-1 text-left font-display text-base font-semibold ${
                    isOwner ? "hover:bg-surface" : "cursor-default"
                  }`}
                >
                  {name || "Untitled Room"}
                </button>
              )}
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={copyInvite}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
                    Link copied
                  </>
                ) : (
                  <>
                    <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    <span className="hidden sm:inline">Copy invite link</span>
                    <span className="sm:hidden">Invite</span>
                  </>
                )}
              </button>

              <div className="hidden -space-x-2 sm:flex">
                {members
                  .filter((m) => m.userId !== currentUserId)
                  .slice(0, 4)
                  .map((m) => {
                    const isOnline = presenceOf(m.lastSeenAt, now) === "online";
                    return (
                      <span
                        key={m.userId}
                        title={`${m.username}${isOnline ? " — online" : ""}`}
                        className="relative"
                      >
                        <Avatar
                          name={m.username}
                          src={m.avatarUrl}
                          size="sm"
                          className="ring-2 ring-background"
                        />
                        {isOnline && (
                          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent ring-2 ring-background" />
                        )}
                      </span>
                    );
                  })}
              </div>

              {memberById.get(currentUserId) && (
                <ProfileMenu
                  userId={currentUserId}
                  username={memberById.get(currentUserId)!.username}
                  email={currentUserEmail}
                  avatarUrl={memberById.get(currentUserId)!.avatarUrl}
                  onUsernameSaved={handleUsernameSaved}
                />
              )}
            </div>
          </div>
        </header>

        {activeThreadId === null ? (
          /* ---------- no thread selected ---------- */
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
            <p className="font-display text-lg font-semibold text-foreground">
              You haven&apos;t discussed anything yet
            </p>
            <button
              type="button"
              onClick={() => setNewChatOpen(true)}
              className="mt-5 flex items-center gap-2 rounded-lg bg-accent px-4 py-2 font-display text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90"
            >
              <MessageSquarePlus className="h-4 w-4" strokeWidth={2} />
              Start a chat
            </button>
            {error && (
              <p className="mt-4 text-sm text-red-400">{error}</p>
            )}
          </div>
        ) : (
          <>
            {/* ---------- transcript ---------- */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl px-6 py-8">
                {threadMessages.length === 0 ? (
                  <div className="flex h-full min-h-[40vh] items-center justify-center">
                    <p className="text-sm text-muted">
                      Send a message to get started
                    </p>
                  </div>
                ) : (
                  <ul className="flex flex-col gap-6">
                    {threadMessages.map((m) => {
                      const author = m.senderId
                        ? memberById.get(m.senderId)
                        : null;
                      const isAgent = m.senderType === "agent";
                      const stopper = m.interruptedBy
                        ? memberById.get(m.interruptedBy)
                        : null;

                      return (
                        <li key={m.id} className="flex gap-3">
                          {isAgent ? (
                            <span
                              aria-hidden="true"
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-base"
                              title="Koopi Kapi"
                            >
                              🦫
                            </span>
                          ) : (
                            <Avatar
                              name={author?.username ?? "Someone"}
                              src={author?.avatarUrl}
                              size="md"
                              className="shrink-0"
                            />
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-2">
                              <span className="font-display text-sm font-semibold">
                                {isAgent
                                  ? "Koopi"
                                  : (author?.username ?? "Someone")}
                              </span>
                              <span className="text-xs text-muted">
                                {timeLabel(m.createdAt)}
                              </span>
                            </div>

                            {m.type === "tool_call" ? (
                              <div className="mt-1 overflow-hidden rounded-lg border border-border">
                                <div className="flex items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted">
                                  <Terminal className="h-3.5 w-3.5" strokeWidth={2} />
                                  {m.status === "streaming"
                                    ? "Running code…"
                                    : m.status === "interrupted"
                                      ? "Code execution stopped"
                                      : "Ran code"}
                                  {(() => {
                                    const { language } = parseJson<ToolCallPayload>(
                                      m.content,
                                      { code: "", language: "" }
                                    );
                                    return language ? (
                                      <span className="ml-auto rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted">
                                        {language}
                                      </span>
                                    ) : null;
                                  })()}
                                </div>
                                <pre className="overflow-x-auto bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
                                  {
                                    parseJson<ToolCallPayload>(m.content, {
                                      code: "",
                                      language: "",
                                    }).code
                                  }
                                </pre>
                              </div>
                            ) : m.type === "tool_result" ? (
                              (() => {
                                const { stdout, stderr, exit_code } =
                                  parseJson<ToolResultPayload>(m.content, {
                                    stdout: "",
                                    stderr: "",
                                    exit_code: 0,
                                  });
                                return (
                                  <div className="mt-1 overflow-hidden rounded-lg border border-border">
                                    <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-1.5 text-xs font-medium text-muted">
                                      <span>Output</span>
                                      <span
                                        className={
                                          exit_code === 0
                                            ? "text-muted"
                                            : "text-red-400"
                                        }
                                      >
                                        exit {exit_code}
                                      </span>
                                    </div>
                                    <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground">
                                      {stdout || (
                                        <span className="text-muted">
                                          (no stdout)
                                        </span>
                                      )}
                                      {stderr && (
                                        <span className="text-red-400">
                                          {stdout ? "\n" : ""}
                                          {stderr}
                                        </span>
                                      )}
                                    </pre>
                                  </div>
                                );
                              })()
                            ) : (
                              <div
                                className={`mt-1 whitespace-pre-wrap break-words rounded-lg px-4 py-3 text-sm leading-relaxed ${
                                  isAgent
                                    ? "bg-surface text-foreground"
                                    : "bg-accent/10 text-foreground"
                                }`}
                              >
                                {m.content ? (
                                  renderWithMentions(m.content, allMentionNames)
                                ) : (
                                  <span className="text-muted">
                                    {m.status === "streaming" ? "Thinking…" : "—"}
                                  </span>
                                )}
                                {m.status === "streaming" && m.content && (
                                  <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-accent" />
                                )}
                              </div>
                            )}

                            {m.status === "interrupted" && (
                              <p className="mt-1.5 text-xs text-muted">
                                Stopped by {stopper?.username ?? "a teammate"}
                              </p>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            {/* ---------- composer ---------- */}
            <div className="shrink-0 border-t border-border bg-background">
              <div className="mx-auto max-w-3xl px-6 py-4">
                {error && (
                  <p className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
                    {error}
                  </p>
                )}

                {isStreaming && (
                  <div className="mb-3 flex justify-center">
                    <button
                      type="button"
                      onClick={handleStop}
                      className="flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-4 py-2 font-display text-sm font-medium text-red-400 transition-colors hover:bg-red-500/20"
                    >
                      <Square
                        className="h-3.5 w-3.5 fill-current"
                        strokeWidth={0}
                      />
                      Stop
                    </button>
                  </div>
                )}

                <form onSubmit={handleSend} className="relative flex items-end gap-2">
                  {mentionState && mentionOptions.length > 0 && (
                    <ul className="absolute bottom-full left-0 mb-1.5 w-56 overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
                      {mentionOptions.map((name, i) => (
                        <li key={name}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectMention(name)}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm ${
                              i === mentionIndex
                                ? "bg-accent/15 text-foreground"
                                : "text-foreground hover:bg-background"
                            }`}
                          >
                            {name === KOOPI_MENTION ? (
                              <span
                                aria-hidden="true"
                                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-xs"
                              >
                                🦫
                              </span>
                            ) : (
                              <Avatar
                                name={name}
                                src={mentionMemberByName.get(name)?.avatarUrl ?? null}
                                size="sm"
                              />
                            )}
                            {name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <label htmlFor="composer" className="sr-only">
                    Message
                  </label>
                  <textarea
                    id="composer"
                    ref={composerRef}
                    rows={1}
                    value={draft}
                    disabled={isStreaming}
                    onChange={handleComposerChange}
                    onKeyDown={onInputKeyDown}
                    onBlur={() => setMentionState(null)}
                    placeholder={
                      isStreaming
                        ? "Koopi is responding…"
                        : requiresMention
                          ? "Message the room… (tag @Koopi for a response)"
                          : "Message the room…"
                    }
                    className="max-h-40 min-h-[46px] flex-1 resize-y rounded-lg border border-border bg-surface px-4 py-3 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-60"
                  />
                  <button
                    type="submit"
                    disabled={isStreaming || sending || !draft.trim()}
                    aria-label="Send"
                    className="flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
                  </button>
                </form>
              </div>
            </div>
          </>
        )}
      </div>

      {newChatOpen && (
        <NewChatModal
          roomId={roomId}
          currentUserId={currentUserId}
          invitable={members.filter((m) => m.userId !== currentUserId)}
          onCreated={handleThreadCreated}
          onClose={() => setNewChatOpen(false)}
        />
      )}
    </div>
  );
}
