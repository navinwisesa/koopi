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
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Link2,
  Check,
  Square,
  ArrowUp,
  PanelLeft,
  PanelRight,
  MessageSquarePlus,
  Terminal,
  Wand2,
  Zap,
  Sparkles,
  Brain,
  AlertTriangle,
  MonitorPlay,
  ExternalLink,
} from "lucide-react";
import Avatar from "@/components/Avatar";
import ProjectPanel from "@/components/ProjectPanel";
import NewChatModal from "@/components/NewChatModal";
import ResizeHandle from "@/components/ResizeHandle";
import PersonalitySelector, { type Personality } from "@/components/PersonalitySelector";
import ProfileMenu from "@/components/ProfileMenu";
import RoomSidebar from "@/components/RoomSidebar";
import { presenceOf, PRESENCE_DOT } from "@/lib/presence";
import { createClient } from "@/lib/supabase/client";
import { useResizableWidth } from "@/lib/useResizableWidth";

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
  modelTier: "chat" | "build" | "code" | null;
  modelProvider: string | null;
  // Set by /api/chat's post-reply classification pass — never inferred client-side,
  // since "was room memory available" is true on nearly every message once a room has
  // any history, and would make the badge meaningless.
  usedRoomMemory: boolean;
  flagged: boolean;
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

// Room-scoped (not thread-scoped) — one project per room, keyed by fileId
// client-side. Replaces the old ThreadFile / single-file-per-thread model.
export type ProjectFile = {
  id: string;
  projectId: string;
  path: string;
  content: string;
  language: string;
  // null = Koopi-authored — the agent has no profiles row, same convention as
  // ChatMessage.senderId being null for agent messages.
  lastEditedBy: string | null;
  updatedAt: string;
};

export type ProjectRunState = {
  status: "idle" | "running";
  entryPath: string | null;
  lastRunStdout: string | null;
  lastRunStderr: string | null;
  lastRunExitCode: number | null;
  lastRunAt: string | null;
  lastRunBy: string | null;
};

export type Project = {
  id: string;
  roomId: string;
  name: string;
  createdBy: string | null;
} & ProjectRunState;

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
type ToolResultPayload = {
  stdout: string;
  stderr: string;
  exit_code: number;
  // Only present for open_gui_session results — a live, watchable view of a
  // GUI app running in a virtual desktop, in place of stdout/stderr.
  streamUrl?: string | null;
};

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// Finds the "@partial" fragment the cursor is currently sitting inside, if any —
// an "@" preceded by start-of-string or whitespace, with no whitespace since.
// Purely a text-composition affordance now — tagging someone here never triggers
// Koopi (that's governed entirely by the per-user toggle below the transcript), so
// this only ever offers/highlights human teammates.
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

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    roomId: row.room_id as string,
    name: (row.name as string | null) ?? "Project",
    createdBy: (row.created_by as string | null) ?? null,
    status: ((row.run_status as string) ?? "idle") as "idle" | "running",
    entryPath: (row.run_entry_path as string | null) ?? null,
    lastRunStdout: (row.last_run_stdout as string | null) ?? null,
    lastRunStderr: (row.last_run_stderr as string | null) ?? null,
    lastRunExitCode: (row.last_run_exit_code as number | null) ?? null,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    lastRunBy: (row.last_run_by as string | null) ?? null,
  };
}

function rowToProjectFile(row: Record<string, unknown>): ProjectFile {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    path: row.path as string,
    content: (row.content as string) ?? "",
    language: (row.language as string) ?? "python",
    lastEditedBy: (row.last_edited_by as string | null) ?? null,
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
  initialLastReadAt,
  initialKoopiActive,
  initialParticipantKoopiActive,
  initialProject,
  initialProjectFiles,
  initialPersonality,
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
  initialLastReadAt: Record<string, string | null>;
  initialKoopiActive: Record<string, boolean>;
  initialParticipantKoopiActive: Record<string, Record<string, boolean>>;
  initialProject: Project | null;
  initialProjectFiles: ProjectFile[];
  initialPersonality: Personality;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [members, setMembers] = useState<RoomMember[]>(initialMembers);
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [threadParticipants, setThreadParticipants] = useState<
    Record<string, string[]>
  >(initialThreadParticipants);
  // Current user's own last-viewed timestamp per thread — per-viewer state, never
  // shared with or derived from other participants' read status.
  const [lastReadAt, setLastReadAt] = useState<Record<string, string | null>>(
    initialLastReadAt
  );
  // Current user's own "Ask Koopi" setting per thread — the sole gate on whether
  // THEIR OWN messages trigger a reply. Never affected by anyone else's setting.
  const [koopiActive, setKoopiActiveState] = useState<Record<string, boolean>>(
    initialKoopiActive
  );
  // Every participant's setting per thread, so the composer can show "Koopi also
  // answers: ..." — each person's setting is independent, so this is purely informational.
  const [participantKoopiActive, setParticipantKoopiActive] = useState<
    Record<string, Record<string, boolean>>
  >(initialParticipantKoopiActive);
  // Threads with a Koopi reply currently in flight (broadcast, not persisted — purely
  // ephemeral UI state, same as any chat app's typing indicator).
  const [typingThreads, setTypingThreads] = useState<Set<string>>(new Set());
  // Room-scoped project (one per room) and its files — replaces the old
  // per-thread threadFiles map. `project` is null until someone opens the
  // panel for the first time, which lazily creates it (see ensureProject).
  const [project, setProject] = useState<Project | null>(initialProject);
  const [projectFiles, setProjectFiles] = useState<Record<string, ProjectFile>>(
    () => Object.fromEntries(initialProjectFiles.map((f) => [f.id, f]))
  );
  // Whether the project panel is visible at all — defaults closed.
  const [projectPanelOpen, setProjectPanelOpen] = useState(false);
  // The most recent project_files.updatedAt this viewer has actually had the
  // panel open for — not persisted, purely "have I looked since this
  // changed" for the toggle button's unseen-update dot. Room-scoped now
  // (single value), not per-thread.
  const [projectSeenAt, setProjectSeenAt] = useState<string | null>(null);
  const {
    width: codePanelWidth,
    onHandleMouseDown: onCodePanelHandleMouseDown,
    onHandleDoubleClick: onCodePanelHandleDoubleClick,
  } = useResizableWidth({
    storageKey: "koopi:code-panel-width",
    defaultWidth: 480,
    min: 360,
    max: 720,
    // Anchored to the right edge of the screen — dragging the handle left
    // (toward the chat column) grows it.
    direction: "left",
  });
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
  // Auto lets the server's heuristic pick a model per message; the other two
  // pin every message from this composer to one tier until switched back.
  const [modelMode, setModelMode] = useState<"auto" | "chat" | "build">("auto");

  const [mentionState, setMentionState] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState(initialName);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(initialName);
  const [personality, setPersonality] = useState<Personality>(initialPersonality);

  const [now, setNow] = useState(() => Date.now());

  const bottomRef = useRef<HTMLDivElement>(null);
  // The messages channel also carries the "typing" broadcast (see the realtime effect
  // below) — stashed in a ref so handleSend can send() on it without re-subscribing.
  const messagesChannelRef = useRef<RealtimeChannel | null>(null);

  const threadMessages = useMemo(
    () =>
      activeThreadId
        ? messages.filter((m) => m.threadId === activeThreadId)
        : [],
    [messages, activeThreadId]
  );

  const streamingMessage = threadMessages.find((m) => m.status === "streaming");
  const isStreaming = Boolean(streamingMessage);

  const sortedProjectFiles = useMemo(
    () =>
      Object.values(projectFiles)
        .filter((f) => f.projectId === project?.id)
        .sort((a, b) => a.path.localeCompare(b.path)),
    [projectFiles, project]
  );
  const latestProjectFileUpdate = useMemo(
    () => sortedProjectFiles.reduce<string | null>((max, f) => (!max || f.updatedAt > max ? f.updatedAt : max), null),
    [sortedProjectFiles]
  );
  const hasUnseenCodeUpdate = Boolean(latestProjectFileUpdate && latestProjectFileUpdate !== projectSeenAt);

  // Marks the project as "seen" the moment its panel is actually open and on
  // screen — covers both opening the panel on an already-updated project and
  // a fresh update arriving while it's already open.
  useEffect(() => {
    if (!projectPanelOpen || !latestProjectFileUpdate) return;
    setProjectSeenAt((prev) => (prev === latestProjectFileUpdate ? prev : latestProjectFileUpdate));
  }, [projectPanelOpen, latestProjectFileUpdate]);

  // Lazily creates the room's single project on first panel open. A unique
  // constraint on projects.room_id makes a simultaneous double-create by two
  // participants harmless — the loser's insert 23505s and just re-fetches
  // what the winner created.
  async function ensureProject(): Promise<void> {
    if (project) return;
    const { data: inserted, error: insertErr } = await supabase
      .from("projects")
      .insert({ room_id: roomId, created_by: currentUserId })
      .select("*")
      .single();
    if (!insertErr && inserted) {
      setProject(rowToProject(inserted as Record<string, unknown>));
      return;
    }
    const { data: existing } = await supabase
      .from("projects")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();
    if (existing) setProject(rowToProject(existing as Record<string, unknown>));
  }

  const memberById = useMemo(() => {
    const map = new Map<string, RoomMember>();
    for (const m of members) map.set(m.userId, m);
    return map;
  }, [members]);

  const activeThreadParticipantIds = useMemo(
    () => (activeThreadId ? (threadParticipants[activeThreadId] ?? []) : []),
    [activeThreadId, threadParticipants]
  );

  // Everyone the @ dropdown can offer, excluding yourself — tagging yourself doesn't
  // do anything useful. Human teammates only — Koopi isn't a taggable target anymore,
  // since tagging never triggered it in the first place (the toggle does that).
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
    () => mentionMembers.map((m) => m.username),
    [mentionMembers]
  );

  // Everyone a message could legitimately mention, including yourself — used to
  // decide what to highlight when rendering someone else's message.
  const allMentionNames = useMemo(
    () =>
      activeThreadParticipantIds
        .map((id) => memberById.get(id)?.username)
        .filter((n): n is string => Boolean(n)),
    [activeThreadParticipantIds, memberById]
  );

  const mentionOptions = useMemo(() => {
    if (!mentionState) return [];
    const q = mentionState.query.toLowerCase();
    return mentionCandidates.filter((name) => name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mentionState, mentionCandidates]);

  // My own setting for the open thread — the sole gate on whether my messages
  // trigger Koopi. Defaults true to match the column default for a thread whose
  // participant row hasn't round-tripped through state yet.
  const myKoopiActive = activeThreadId ? (koopiActive[activeThreadId] ?? true) : true;

  // Other participants in the open thread who currently have Koopi answering them —
  // purely informational, since each person's setting only ever affects their own
  // messages. Explains why Koopi might reply to one person's messages but not another's
  // in the same live conversation.
  const othersKoopiActive = useMemo(() => {
    if (!activeThreadId) return [];
    const settings = participantKoopiActive[activeThreadId] ?? {};
    return activeThreadParticipantIds
      .filter((id) => id !== currentUserId)
      .filter((id) => settings[id] ?? true)
      .map((id) => memberById.get(id)?.username)
      .filter((n): n is string => Boolean(n));
  }, [activeThreadId, participantKoopiActive, activeThreadParticipantIds, currentUserId, memberById]);

  const isActiveThreadTyping = Boolean(activeThreadId && typingThreads.has(activeThreadId));

  // --- realtime: messages (+ typing broadcast, same channel) --------------
  useEffect(() => {
    // { self: true } so the sender's own client also sees its own typing broadcasts —
    // "Koopi is typing" should look identical for the sender and everyone else, not
    // need separate local-optimistic-state just for the one person who sent it.
    const channel = supabase
      .channel(`room:${roomId}:messages`, { config: { broadcast: { self: true } } })
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
            modelTier: (row.model_tier as ChatMessage["modelTier"]) ?? null,
            modelProvider: (row.model_provider as string | null) ?? null,
            usedRoomMemory: Boolean(row.used_room_memory),
            flagged: Boolean(row.flagged),
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

          // The first row for a reply is inserted the moment the first token arrives
          // server-side (or, on failure, the failure-notice row) — either way, a real
          // agent row showing up is exactly the "stop showing typing" moment, precise
          // down to the same event that puts the real content on screen.
          if (next.senderType === "agent") {
            setTypingThreads((prev) => {
              if (!prev.has(next.threadId)) return prev;
              const copy = new Set(prev);
              copy.delete(next.threadId);
              return copy;
            });
          }
        }
      )
      .on("broadcast", { event: "typing" }, (payload) => {
        const { threadId, active } = payload.payload as {
          threadId: string;
          active: boolean;
        };
        setTypingThreads((prev) => {
          const alreadySet = prev.has(threadId);
          if (active === alreadySet) return prev;
          const copy = new Set(prev);
          if (active) copy.add(threadId);
          else copy.delete(threadId);
          return copy;
        });
      })
      .subscribe();

    messagesChannelRef.current = channel;

    return () => {
      messagesChannelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId]);

  // Broadcasts on the shared messages channel — a no-op (not an error) if the channel
  // hasn't finished subscribing yet, which only matters for a request fired in the
  // first instant after mount.
  const broadcastTyping = useCallback((threadId: string, active: boolean) => {
    void messagesChannelRef.current?.send({
      type: "broadcast",
      event: "typing",
      payload: { threadId, active },
    });
  }, []);

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

          // Only our own read-state is meaningful to track — this is what keeps
          // "opened on another tab/device" reflected here without a page reload.
          if (userId === currentUserId) {
            const lastRead = (row?.last_read_at as string | null) ?? null;
            setLastReadAt((prev) => ({ ...prev, [threadId]: lastRead }));
          }

          // koopi_active, unlike last_read_at, matters for EVERY participant — it's
          // what powers the "Koopi also answers: ..." hint, so every row's value gets
          // tracked, not just our own.
          const active = (row?.koopi_active as boolean | null) ?? true;
          setParticipantKoopiActive((prev) => ({
            ...prev,
            [threadId]: { ...(prev[threadId] ?? {}), [userId]: active },
          }));
          if (userId === currentUserId) {
            setKoopiActiveState((prev) => ({ ...prev, [threadId]: active }));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId, currentUserId]);

  // --- realtime: projects + project_files (project panel) -----------------
  useEffect(() => {
    // Neither table carries a filterable room_id column client-side query
    // params can key on directly in the postgres_changes filter — same
    // unfiltered-subscription, RLS-does-the-filtering shape thread_files used.
    const channel = supabase
      .channel(`room:${roomId}:projects`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "projects" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            setProject(null);
            return;
          }
          const row = payload.new as Record<string, unknown> | null;
          if (!row || row.room_id !== roomId) return;
          setProject(rowToProject(row));
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_files" },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const old = payload.old as Record<string, unknown> | null;
            const id = old?.id as string | undefined;
            if (!id) return;
            setProjectFiles((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
            return;
          }

          const row = payload.new as Record<string, unknown> | null;
          const id = row?.id as string | undefined;
          // project_files has no room_id column, and this effect intentionally
          // doesn't depend on `project` (avoids resubscribing the channel
          // every time the project row changes) — so a stale/cross-room
          // entry could in principle land in this dict. That's safe: it's
          // scoped out at read time by sortedProjectFiles filtering on
          // f.projectId === project?.id below, the same
          // "store everything, filter at read time" shape threadFiles used.
          if (!id) return;

          setProjectFiles((prev) => ({
            ...prev,
            [id]: rowToProjectFile(row!),
          }));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, roomId]);

  // --- realtime: room settings (personality) ------------------------------
  useEffect(() => {
    const channel = supabase
      .channel(`room:${roomId}:settings`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "rooms",
          filter: `id=eq.${roomId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown> | null;
          const next = row?.personality as Personality | undefined;
          if (next) setPersonality(next);
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

  // --- read tracking --------------------------------------------------------
  // Persists to thread_participants.last_read_at; local state updates optimistically
  // so the sidebar dot clears the instant you open a thread, not after the round trip.
  const markThreadRead = useCallback(
    (threadId: string) => {
      const nowIso = new Date().toISOString();
      setLastReadAt((prev) => ({ ...prev, [threadId]: nowIso }));
      void supabase
        .from("thread_participants")
        .update({ last_read_at: nowIso })
        .eq("thread_id", threadId)
        .eq("user_id", currentUserId);
    },
    [supabase, currentUserId]
  );

  useEffect(() => {
    if (activeThreadId) markThreadRead(activeThreadId);
    // Only re-fires on an actual thread switch, deliberately — bumping this on every
    // incoming message would spam writes. The currently-open thread is instead just
    // excluded from the unread computation below, which handles "already looking at
    // it" without needing last_read_at to track live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadId]);

  // --- "Ask Koopi" toggle --------------------------------------------------
  // Purely a per-user, per-thread setting — writing it never touches anyone else's
  // row, and reading it (via participantKoopiActive) never lets one person's toggle
  // change what another person's messages do.
  const setMyKoopiActive = useCallback(
    (threadId: string, active: boolean) => {
      setKoopiActiveState((prev) => ({ ...prev, [threadId]: active }));
      setParticipantKoopiActive((prev) => ({
        ...prev,
        [threadId]: { ...(prev[threadId] ?? {}), [currentUserId]: active },
      }));
      void supabase
        .from("thread_participants")
        .update({ koopi_active: active })
        .eq("thread_id", threadId)
        .eq("user_id", currentUserId)
        .then(({ error: updateError }) => {
          // The optimistic update above already changed what THIS user sees, so a
          // write failure here is invisible unless logged — and everyone else's view
          // depends on this write actually landing, since they only find out via the
          // thread_participants realtime subscription.
          if (updateError) {
            console.error("Failed to persist Koopi toggle:", updateError);
          }
        });
    },
    [supabase, currentUserId]
  );

  // A thread counts as unread if it has a message newer than our last visit that we
  // didn't send ourselves — our own messages don't need to notify us of themselves.
  // The active thread is excluded outright: it's on screen, so by definition read.
  const unreadThreadIds = useMemo(() => {
    const unread = new Set<string>();
    for (const m of messages) {
      if (m.threadId === activeThreadId) continue;
      if (m.senderType === "user" && m.senderId === currentUserId) continue;
      const readAt = lastReadAt[m.threadId];
      if (readAt && m.createdAt <= readAt) continue;
      unread.add(m.threadId);
    }
    return unread;
  }, [messages, lastReadAt, activeThreadId, currentUserId]);

  // --- actions ------------------------------------------------------------
  function handleThreadCreated(created: Thread, participantIds: string[]) {
    setThreads((prev) =>
      prev.some((t) => t.id === created.id)
        ? prev
        : [created, ...prev].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    );
    // Seed participants immediately so the directory groups it correctly
    // right away, instead of waiting on the realtime round trip. Matches the
    // koopi_active column default — nobody has touched the toggle yet.
    setThreadParticipants((prev) => ({ ...prev, [created.id]: participantIds }));
    setKoopiActiveState((prev) => ({ ...prev, [created.id]: true }));
    setParticipantKoopiActive((prev) => ({
      ...prev,
      [created.id]: Object.fromEntries(participantIds.map((id) => [id, true])),
    }));
    setActiveThreadId(created.id);
    setNewChatOpen(false);
    if (isNarrowViewport()) setSidebarOpen(false);
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || isStreaming || !activeThreadId) return;

    const threadId = activeThreadId;
    // Purely the sender's own setting — replaces the old @-mention trigger entirely.
    const shouldInvokeAgent = koopiActive[threadId] ?? true;
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

      broadcastTyping(threadId, true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId,
            triggerMessageId: inserted.id,
            modelOverride: modelMode === "auto" ? undefined : modelMode,
          }),
        });

        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error ?? "The agent could not respond.");
        }

        // Content lands via realtime; draining keeps the connection open.
        await res.text();
      } finally {
        // Tied to the request actually settling — success or failure — not a fixed
        // timer, so the indicator can never get stuck. The row-insert-based clear in
        // the messages effect above is what handles the normal "first token arrived"
        // case; this is the backstop for the rare case where no row ever lands at all.
        broadcastTyping(threadId, false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  async function handleStop() {
    if (!isStreaming || !activeThreadId) return;
    setError(null);

    // Clears every streaming row in this thread, not just the one
    // `streamingMessage` happened to point at — a thread can end up with more
    // than one row stuck at status='streaming' (e.g. a dev-server crash mid
    // tool_call leaves that row orphaned forever, same as the text-flush
    // ticker dying does), and stopping only the first one left Stop looking
    // like it did nothing: the UI would immediately re-lock onto the next
    // stuck row and show "responding…" again.
    //
    // Also sets threads.stop_requested_at unconditionally — a multi-round
    // tool loop (run_code, look at the result, call it again...) can spend
    // several seconds between rounds with NO row streaming at all (waiting
    // on the next model call, which can itself fail over through multiple
    // providers). During one of those gaps the update above touches zero
    // rows, so it alone can't stop a reply that's mid-loop; the server polls
    // this column once per round to catch exactly that case.
    const [{ error: stopError }, { error: signalError }] = await Promise.all([
      supabase
        .from("messages")
        .update({ status: "interrupted", interrupted_by: currentUserId })
        .eq("thread_id", activeThreadId)
        .eq("status", "streaming"),
      supabase
        .from("threads")
        .update({ stop_requested_at: new Date().toISOString() })
        .eq("id", activeThreadId),
    ]);

    if (stopError) setError(stopError.message);
    // Best-effort, logged not surfaced — the row-flip above already covers
    // the common case (something visibly streaming right now), so a failure
    // here (e.g. the stop_requested_at migration not applied yet) shouldn't
    // block the user with an error banner over what's still a working Stop.
    if (signalError) console.warn("handleStop: failed to set stop_requested_at", signalError);
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
        unreadThreadIds={unreadThreadIds}
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
              <PersonalitySelector
                roomId={roomId}
                personality={personality}
                onChanged={setPersonality}
              />

              <button
                type="button"
                onClick={() => {
                  setProjectPanelOpen((v) => !v);
                  void ensureProject();
                }}
                aria-pressed={projectPanelOpen}
                title={
                  hasUnseenCodeUpdate && !projectPanelOpen
                    ? "Project — updated since you last looked"
                    : projectPanelOpen
                      ? "Hide project panel"
                      : "Show project panel"
                }
                className={`relative flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  projectPanelOpen
                    ? "border-accent text-accent"
                    : "border-border text-muted hover:text-foreground"
                }`}
              >
                <PanelRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span className="hidden sm:inline">Project</span>
                {hasUnseenCodeUpdate && !projectPanelOpen && (
                  <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-accent" />
                )}
              </button>

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
                    const presence = presenceOf(m.lastSeenAt, now);
                    return (
                      <span
                        key={m.userId}
                        title={`${m.username} — ${presence}`}
                        className="relative"
                      >
                        <Avatar
                          name={m.username}
                          src={m.avatarUrl}
                          size="sm"
                          className="ring-2 ring-background"
                        />
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-background ${PRESENCE_DOT[presence]}`}
                        />
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
          <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* ---------- transcript ---------- */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl px-6 py-8">
                {threadMessages.length === 0 && !isActiveThreadTyping ? (
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
                            (() => {
                              const runningCode =
                                m.type === "tool_call" && m.status === "streaming";
                              const generating = m.type === "text" && m.status === "streaming";
                              return (
                                <span
                                  aria-hidden="true"
                                  title={
                                    runningCode
                                      ? "Koopi Kapi — running code"
                                      : generating
                                        ? "Koopi Kapi — responding"
                                        : "Koopi Kapi"
                                  }
                                  className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base ${
                                    runningCode
                                      ? "animate-pulse bg-amber-500/15 ring-2 ring-amber-500/50"
                                      : generating
                                        ? "animate-pulse bg-accent/15 ring-2 ring-accent/50"
                                        : "bg-accent/15"
                                  }`}
                                >
                                  🦫
                                  {runningCode && (
                                    <Terminal
                                      className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-amber-500 p-0.5 text-white"
                                      strokeWidth={2.5}
                                    />
                                  )}
                                </span>
                              );
                            })()
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
                              {isAgent && m.modelTier && (() => {
                                // Groq is the primary provider for chat/build; OpenRouter is its
                                // fallback there, but is the sole (never "fallback") provider for
                                // code — cohere/north-mini-code only lives on OpenRouter.
                                const isFallback = m.modelTier !== "code" && m.modelProvider === "openrouter";
                                const style =
                                  m.modelTier === "build"
                                    ? { icon: Sparkles, label: "Powerful", className: "bg-accent/15 text-accent" }
                                    : m.modelTier === "code"
                                      ? { icon: Terminal, label: "Code", className: "bg-blue-500/15 text-blue-400" }
                                      : { icon: Zap, label: "Efficient", className: "bg-surface text-muted" };
                                return (
                                  <span
                                    title={m.modelProvider && isFallback ? `Served via ${m.modelProvider} (fallback)` : undefined}
                                    className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${style.className}`}
                                  >
                                    <style.icon className="h-2.5 w-2.5" strokeWidth={2.5} />
                                    {style.label}
                                    {isFallback ? ` · ${m.modelProvider}` : ""}
                                  </span>
                                );
                              })()}
                              {isAgent && m.usedRoomMemory && (
                                <span
                                  title="This reply drew on room memory — context from other threads in this room"
                                  className="flex items-center gap-1 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-400"
                                >
                                  <Brain className="h-2.5 w-2.5" strokeWidth={2.5} />
                                  Room memory
                                </span>
                              )}
                              {isAgent && m.flagged && (
                                <span
                                  title="Koopi flagged a conflict, disagreement, or risk in this reply"
                                  className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
                                >
                                  <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2.5} />
                                  Flagged
                                </span>
                              )}
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
                                const { stdout, stderr, exit_code, streamUrl } =
                                  parseJson<ToolResultPayload>(m.content, {
                                    stdout: "",
                                    stderr: "",
                                    exit_code: 0,
                                  });

                                if (streamUrl) {
                                  return (
                                    <div className="mt-1 overflow-hidden rounded-lg border border-accent/40 bg-accent/5">
                                      <a
                                        href={streamUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-2 px-3 py-2.5 text-sm font-medium text-accent hover:underline"
                                      >
                                        <MonitorPlay className="h-4 w-4 shrink-0" strokeWidth={2} />
                                        Open live view
                                        <ExternalLink className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                                      </a>
                                      <p className="border-t border-accent/20 px-3 py-1.5 text-xs text-muted">
                                        Opens in a new tab — live for about 5 minutes.
                                      </p>
                                    </div>
                                  );
                                }

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
                    {isActiveThreadTyping && !isStreaming && (
                      <li className="flex gap-3">
                        <span
                          aria-hidden="true"
                          title="Koopi Kapi — responding"
                          className="flex h-8 w-8 shrink-0 animate-pulse items-center justify-center rounded-full bg-accent/15 text-base ring-2 ring-accent/50"
                        >
                          🦫
                        </span>
                        <div className="flex items-center">
                          <div className="mt-1 flex items-center gap-1 rounded-lg bg-surface px-4 py-3.5">
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.3s]" />
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:-0.15s]" />
                            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
                          </div>
                        </div>
                      </li>
                    )}
                  </ul>
                )}
                <div ref={bottomRef} />
              </div>
            </div>

            {/* ---------- composer ---------- */}
            <div className="shrink-0 border-t border-border bg-background">
              <div className="mx-auto max-w-3xl px-6 py-4">
                {/* Deliberately the most prominent thing above the composer — this
                    replaced @-mention tagging entirely, so it has to be impossible to
                    miss, not a tucked-away setting. */}
                <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-lg border border-border bg-surface px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-sm font-semibold text-foreground">
                      Should Koopi answer you?
                    </span>
                    <div className="flex items-center gap-0.5 rounded-full border border-border bg-background p-0.5">
                      <button
                        type="button"
                        onClick={() => activeThreadId && setMyKoopiActive(activeThreadId, true)}
                        aria-pressed={myKoopiActive}
                        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                          myKoopiActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted hover:bg-surface hover:text-foreground"
                        }`}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        onClick={() => activeThreadId && setMyKoopiActive(activeThreadId, false)}
                        aria-pressed={!myKoopiActive}
                        className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                          !myKoopiActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted hover:bg-surface hover:text-foreground"
                        }`}
                      >
                        No
                      </button>
                    </div>
                  </div>
                  {othersKoopiActive.length > 0 && (
                    <span className="text-xs text-muted">
                      Koopi also answers: {othersKoopiActive.join(", ")}
                    </span>
                  )}
                </div>

                <div className="mb-2 flex items-center justify-end gap-1.5">
                  <span className="text-xs text-muted">Model</span>
                  <div className="flex items-center gap-0.5 rounded-full border border-border bg-surface p-0.5">
                    {(
                      [
                        {
                          key: "auto",
                          label: "Auto",
                          icon: Wand2,
                          title:
                            "Auto — automatically picks based on your message: Powerful for code/build tasks, Efficient for quick questions.",
                        },
                        {
                          key: "chat",
                          label: "Efficient",
                          icon: Zap,
                          title: "Efficient — fast, lightweight model for casual questions and quick replies.",
                        },
                        {
                          key: "build",
                          label: "Powerful",
                          icon: Sparkles,
                          title: "Powerful — more capable model for code generation and complex tasks.",
                        },
                      ] as const
                    ).map(({ key, label, icon: Icon, title }) => (
                      <button
                        key={key}
                        type="button"
                        title={title}
                        onClick={() => setModelMode(key)}
                        aria-pressed={modelMode === key}
                        className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                          modelMode === key
                            ? "bg-accent text-accent-foreground"
                            : "text-muted hover:bg-background hover:text-foreground"
                        }`}
                      >
                        <Icon className="h-3 w-3" strokeWidth={2.5} />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

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
                            <Avatar
                              name={name}
                              src={mentionMemberByName.get(name)?.avatarUrl ?? null}
                              size="sm"
                            />
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
                    placeholder={isStreaming ? "Koopi is responding…" : "Message the room…"}
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
          </div>

          {projectPanelOpen && project && (
            <>
              <div className="hidden md:block">
                <ResizeHandle
                  onMouseDown={onCodePanelHandleMouseDown}
                  onDoubleClick={onCodePanelHandleDoubleClick}
                />
              </div>
              <div
                style={{ width: codePanelWidth }}
                className="hidden shrink-0 md:flex md:flex-col"
              >
                <ProjectPanel
                  projectId={project.id}
                  files={sortedProjectFiles}
                  runState={project}
                  currentUserId={currentUserId}
                  memberById={memberById}
                />
              </div>
            </>
          )}
          </div>
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
